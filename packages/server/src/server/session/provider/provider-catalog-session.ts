import type pino from "pino";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { getErrorMessage } from "@omp-desktop/protocol/error-utils";
import {
  compactProviderSnapshot,
  type CompactProviderSnapshot,
} from "@omp-desktop/protocol/provider-snapshot-codec";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  isGlobalProviderSnapshotKey,
  resolveSnapshotCwd,
  type ProviderSnapshotManager,
} from "../../agent/provider-snapshot-manager.js";
import {
  filterSelectableAgentModels,
  type AgentFeature,
  type AgentProvider,
  type AgentSessionConfig,
  type ProviderSnapshotEntry,
} from "../../agent/agent-sdk-types.js";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type {
  ProviderUsageListResult,
  ProviderUsageService,
} from "../../../services/quota-fetcher/service.js";
import { isZhipuProviderBaseUrl } from "../../../services/quota-fetcher/providers/zhipu.js";
import { expandTilde } from "../../../utils/path.js";
import { discoverOmpProviderModels } from "./omp-model-discovery.js";

// COMPAT(customModeIcons): the only mode icons known to clients before v0.1.84. Any
// other icon name is downgraded to "ShieldCheck" for those clients.
const LEGACY_MODE_ICONS = new Set<string>([
  "ShieldCheck",
  "ShieldAlert",
  "ShieldOff",
  "ShieldQuestionMark",
]);

/**
 * The collaborators a provider-catalog request reaches that are NOT part of the
 * provider domain. Two are CLIENT-COMPAT predicates the Session shell owns because
 * agent-lifecycle shares the visibility gate: both read client state (appVersion /
 * capabilities) LIVE, mutated post-construction via updateAppVersion /
 * updateClientCapabilities. The two agent-control reads expose provider availability
 * and draft features the AgentManager owns.
 */
export interface ProviderCatalogSessionHost {
  emit(msg: SessionOutboundMessage): void;
  // COMPAT(providersSnapshot): visibility gating for older clients lives on the shell
  // (agent-lifecycle shares it). Reads appVersion live.
  isProviderVisibleToClient(provider: string): boolean;
  // COMPAT(customModeIcons): reads clientCapabilities live.
  supportsCustomModeIcons(): boolean;
  supportsCompactProviderSnapshots(): boolean;
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]>;
  listActiveOmpAgentIds(): string[];
  stopOmpAgents(agentIds: readonly string[]): Promise<void>;
}

export interface ProviderCatalogSessionOptions {
  host: ProviderCatalogSessionHost;
  providerSnapshotManager: ProviderSnapshotManager;
  providerUsageService: ProviderUsageService;
  logger: pino.Logger;
}

interface EncodedProviderSnapshot {
  compactSnapshot: CompactProviderSnapshot;
  snapshotHash: string;
}

function encodeProviderSnapshot(entries: ProviderSnapshotEntry[]): EncodedProviderSnapshot {
  const compactSnapshot = compactProviderSnapshot(entries);
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify(compactSnapshot))
    .digest("base64url");
  return { compactSnapshot, snapshotHash };
}

interface CustomProviderUsageConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
}

function providerUsageConfig(
  providers: Record<string, { baseUrl?: unknown; apiKey?: unknown }>,
  providerId: string,
  allowMissingKey = false,
): CustomProviderUsageConfig | null {
  const provider = providers[providerId];
  if (
    !provider ||
    typeof provider.baseUrl !== "string" ||
    !provider.baseUrl.trim() ||
    (!allowMissingKey && (typeof provider.apiKey !== "string" || !provider.apiKey.trim()))
  ) {
    return null;
  }
  return {
    providerId,
    displayName: providerId,
    baseUrl: provider.baseUrl.trim(),
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey.trim() : "",
  };
}

export function resolveCustomProviderUsageConfig(
  configYaml: string,
  providerId: string,
): CustomProviderUsageConfig | null {
  const config = parse(configYaml) as {
    providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
  } | null;
  return config?.providers ? providerUsageConfig(config.providers, providerId) : null;
}

function configuredZhipuProviders(configYaml: string): CustomProviderUsageConfig[] {
  const config = parse(configYaml) as {
    providers?: Record<string, { baseUrl?: unknown; apiKey?: unknown }>;
  } | null;
  if (!config?.providers || typeof config.providers !== "object") return [];
  return Object.keys(config.providers).flatMap((providerId) => {
    const provider = providerUsageConfig(config.providers!, providerId, true);
    return provider && isZhipuProviderBaseUrl(provider.baseUrl) ? [provider] : [];
  });
}

/**
 * A client's provider catalog surface: model / mode / feature listing, the providers
 * snapshot push + pull, provider diagnostics, and usage. The snapshot PUSH (start) and
 * every PULL handler gate visibility and downgrade mode icons through the SAME predicates,
 * so an older client sees one consistent provider set across both paths — the COMPAT
 * invariant the shell could only enforce by code proximity before this carve.
 */
export class ProviderCatalogSession {
  private readonly host: ProviderCatalogSessionHost;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly providerUsageService: ProviderUsageService;
  private readonly logger: pino.Logger;
  private unsubscribeSnapshotEvents: (() => void) | null = null;

  constructor(options: ProviderCatalogSessionOptions) {
    this.host = options.host;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.providerUsageService = options.providerUsageService;
    this.logger = options.logger;
  }

  start(): void {
    const handleProviderSnapshotChange = (entries: ProviderSnapshotEntry[], cwd: string) => {
      // COMPAT(providersSnapshot): keep provider visibility gating for older clients.
      const visibleEntries = entries.filter((entry) =>
        this.host.isProviderVisibleToClient(entry.provider),
      );
      const snapshotCwd = isGlobalProviderSnapshotKey(cwd) ? undefined : cwd;
      const clientEntries = this.downgradeEntryModesForClient(visibleEntries);
      if (this.host.supportsCompactProviderSnapshots()) {
        const encoded = encodeProviderSnapshot(clientEntries);
        this.host.emit({
          type: "providers_snapshot_update",
          payload: {
            ...(snapshotCwd ? { cwd: snapshotCwd } : {}),
            entries: [],
            ...encoded,
            generatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      this.host.emit({
        type: "providers_snapshot_update",
        payload: {
          ...(snapshotCwd ? { cwd: snapshotCwd } : {}),
          entries: clientEntries,
          generatedAt: new Date().toISOString(),
        },
      });
    };
    this.providerSnapshotManager.on("change", handleProviderSnapshotChange);
    const unsubscribeLoginCompleted = this.providerSnapshotManager.onOmpProviderLoginCompleted(
      (payload) => this.host.emit({ type: "omp.provider.login.completed", payload }),
    );
    this.unsubscribeSnapshotEvents = () => {
      this.providerSnapshotManager.off("change", handleProviderSnapshotChange);
      unsubscribeLoginCompleted();
    };
  }

  dispose(): void {
    if (this.unsubscribeSnapshotEvents) {
      this.unsubscribeSnapshotEvents();
      this.unsubscribeSnapshotEvents = null;
    }
  }

  // COMPAT(customModeIcons): rewrite icons unknown to v0.1.83 clients (whose MODE_ICONS
  // map is a closed enum and would render `undefined`, crashing in render). Drop
  // this and the cap gate when floor >= v0.1.84.
  private downgradeModeIconsForClient<T extends { icon?: string }>(modes: T[]): T[] {
    if (this.host.supportsCustomModeIcons()) return modes;
    return modes.map((mode) =>
      mode.icon && !LEGACY_MODE_ICONS.has(mode.icon) ? { ...mode, icon: "ShieldCheck" } : mode,
    );
  }

  private downgradeEntryModesForClient<T extends { modes?: { icon?: string }[] }>(
    entries: T[],
  ): T[] {
    if (this.host.supportsCustomModeIcons()) return entries;
    return entries.map((entry) =>
      entry.modes ? { ...entry, modes: this.downgradeModeIconsForClient(entry.modes) } : entry,
    );
  }

  private emitProviderDisabledResponse(
    kind: "models" | "modes",
    provider: AgentProvider,
    requestId: string,
    fetchedAt: string,
  ): void {
    const payload = {
      provider,
      error: `Provider ${provider} is disabled`,
      fetchedAt,
      requestId,
    };
    if (kind === "models") {
      this.host.emit({ type: "list_provider_models_response", payload });
    } else {
      this.host.emit({ type: "list_provider_modes_response", payload });
    }
  }

  async handleListProviderModelsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_models_request" }>,
  ): Promise<void> {
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const fetchedAt = new Date().toISOString();

    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("models", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_models_response",
        payload: {
          provider: msg.provider,
          models: filterSelectableAgentModels(entry.models),
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list models for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_models_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  async handleListProviderModesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_modes_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    const cwd = resolveCatalogRequestCwd(msg.cwd);
    const entry = await this.getProviderSnapshotEntryForRead(cwd, msg.provider);

    if (!entry) {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          error: `Unknown provider: ${msg.provider}`,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    if (!entry.enabled) {
      this.emitProviderDisabledResponse("modes", msg.provider, msg.requestId, fetchedAt);
      return;
    }

    if (entry.status === "ready") {
      this.host.emit({
        type: "list_provider_modes_response",
        payload: {
          provider: msg.provider,
          modes: this.downgradeModeIconsForClient(entry.modes ?? []),
          error: null,
          fetchedAt: entry.fetchedAt ?? fetchedAt,
          requestId: msg.requestId,
        },
      });
      return;
    }

    const errorMessage =
      entry.status === "error"
        ? (entry.error ?? `Failed to list modes for ${msg.provider}`)
        : `Provider ${msg.provider} is not available`;

    this.host.emit({
      type: "list_provider_modes_response",
      payload: {
        provider: msg.provider,
        error: errorMessage,
        fetchedAt,
        requestId: msg.requestId,
      },
    });
  }

  private async getProviderSnapshotEntryForRead(
    cwd: string | undefined,
    provider: AgentProvider,
  ): Promise<ProviderSnapshotEntry | undefined> {
    const manager = this.providerSnapshotManager;
    const findEntry = () =>
      manager.getSnapshot(cwd).find((candidate) => candidate.provider === provider);

    let entry = findEntry();
    if (entry && !entry.enabled) {
      return entry;
    }
    if (!entry || entry.status === "loading") {
      // Awaits the in-flight warmup (deduped per-cwd) so old clients still get
      // a resolved answer rather than a loading placeholder.
      await manager.warmUpSnapshotForCwd({ cwd, providers: [provider] });
      entry = findEntry();
    }
    return entry;
  }

  private buildDraftAgentSessionConfig(draftConfig: {
    provider: AgentProvider;
    cwd: string;
    modeId?: string;
    model?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  }): AgentSessionConfig {
    return {
      provider: draftConfig.provider,
      cwd: expandTilde(draftConfig.cwd),
      ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
      ...(draftConfig.model ? { model: draftConfig.model } : {}),
      ...(draftConfig.thinkingOptionId ? { thinkingOptionId: draftConfig.thinkingOptionId } : {}),
      ...(draftConfig.featureValues ? { featureValues: draftConfig.featureValues } : {}),
    };
  }

  async handleListProviderFeaturesRequest(
    msg: Extract<SessionInboundMessage, { type: "list_provider_features_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const sessionConfig = this.buildDraftAgentSessionConfig(msg.draftConfig);
      const features = await this.host.listDraftFeatures(sessionConfig);
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          features,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, provider: msg.draftConfig.provider, draftConfig: msg.draftConfig },
        `Failed to list features for ${msg.draftConfig.provider}`,
      );
      this.host.emit({
        type: "list_provider_features_response",
        payload: {
          provider: msg.draftConfig.provider,
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleListAvailableProvidersRequest(
    msg: Extract<SessionInboundMessage, { type: "list_available_providers_request" }>,
  ): Promise<void> {
    const fetchedAt = new Date().toISOString();
    try {
      const providers = (await this.host.listProviderAvailability()).filter((provider) =>
        this.host.isProviderVisibleToClient(provider.provider),
      );
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers,
          error: null,
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to list provider availability");
      this.host.emit({
        type: "list_available_providers_response",
        payload: {
          providers: [],
          error: getErrorMessage(error),
          fetchedAt,
          requestId: msg.requestId,
        },
      });
    }
  }

  async handleGetProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "get_providers_snapshot_request" }>,
  ): Promise<void> {
    // COMPAT(providersSnapshot): keep legacy provider-list RPCs alongside snapshot flow.
    const snapshotCwd = msg.cwd?.trim() ? resolveSnapshotCwd(expandTilde(msg.cwd)) : undefined;
    const entries = this.providerSnapshotManager
      .getSnapshot(snapshotCwd)
      .filter((entry) => this.host.isProviderVisibleToClient(entry.provider));
    const clientEntries = this.downgradeEntryModesForClient(entries);

    if (this.host.supportsCompactProviderSnapshots()) {
      const encoded = encodeProviderSnapshot(clientEntries);
      const notModified = msg.ifNoneMatch === encoded.snapshotHash;
      this.host.emit({
        type: "get_providers_snapshot_response",
        payload: {
          ...(snapshotCwd ? { cwd: snapshotCwd } : {}),
          entries: [],
          ...(!notModified ? { compactSnapshot: encoded.compactSnapshot } : {}),
          snapshotHash: encoded.snapshotHash,
          ...(notModified ? { notModified: true } : {}),
          generatedAt: new Date().toISOString(),
          requestId: msg.requestId,
        },
      });
      return;
    }

    this.host.emit({
      type: "get_providers_snapshot_response",
      payload: {
        ...(snapshotCwd ? { cwd: snapshotCwd } : {}),
        entries: clientEntries,
        generatedAt: new Date().toISOString(),
        requestId: msg.requestId,
      },
    });
  }

  async handleRefreshProvidersSnapshotRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_providers_snapshot_request" }>,
  ): Promise<void> {
    if (msg.cwd) {
      await this.providerSnapshotManager.refreshSnapshotForCwd({
        cwd: expandTilde(msg.cwd),
        providers: msg.providers,
      });
    } else {
      await this.providerSnapshotManager.refreshSettingsSnapshot({
        providers: msg.providers,
      });
    }
    this.host.emit({
      type: "refresh_providers_snapshot_response",
      payload: {
        acknowledged: true,
        requestId: msg.requestId,
      },
    });
  }

  async handleProviderDiagnosticRequest(
    msg: Extract<SessionInboundMessage, { type: "provider_diagnostic_request" }>,
  ): Promise<void> {
    try {
      const { diagnostic } = await this.providerSnapshotManager.getProviderDiagnostic(msg.provider);
      this.host.emit({
        type: "provider_diagnostic_response",
        payload: {
          provider: msg.provider,
          diagnostic,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        { err, provider: msg.provider },
        `Failed to get provider diagnostic for ${msg.provider}`,
      );
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to get provider diagnostic: ${err.message}`,
          code: "provider_diagnostic_failed",
        },
      });
    }
  }
  async handleOmpProviderManagementGetRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.management.get.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.getOmpProviderManagement();
      this.host.emit({
        type: "omp.provider.management.get.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to load OMP provider management");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to load OMP provider management: ${err.message}`,
          code: "omp_provider_management_failed",
        },
      });
    }
  }

  async handleOmpCodexResetCreditConsumeRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.codex.reset_credit.consume.request" }>,
  ): Promise<void> {
    try {
      const result = await this.providerSnapshotManager.consumeOmpCodexResetCredit(
        msg.credentialId,
        msg.creditId,
        msg.redeemRequestId,
      );
      this.host.emit({
        type: "omp.codex.reset_credit.consume.response",
        payload: { ...result, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: err.message,
          code: "omp_codex_reset_credit_consume_failed",
        },
      });
    }
  }

  async handleOmpProviderManagementSaveRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.management.save.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.saveOmpProviderConfig(msg.configYaml);
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.management.save.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to save OMP provider configuration");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to save OMP provider configuration: ${err.message}`,
          code: "omp_provider_management_save_failed",
        },
      });
    }
  }
  async handleOmpSubagentSettingsGetRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.subagents.management.get.request" }>,
  ): Promise<void> {
    try {
      const settings = await this.providerSnapshotManager.getOmpSubagentSettings();
      this.host.emit({
        type: "omp.subagents.management.get.response",
        payload: { ...settings, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to load OMP subagent settings");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to load OMP subagent settings: ${err.message}`,
          code: "omp_subagent_settings_failed",
        },
      });
    }
  }

  async handleOmpSubagentSettingsUpdateRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.subagents.management.update.request" }>,
  ): Promise<void> {
    try {
      const settings = await this.providerSnapshotManager.updateOmpSubagentModel(
        msg.agentName,
        msg.model,
      );
      this.host.emit({
        type: "omp.subagents.management.update.response",
        payload: { ...settings, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to update OMP subagent settings");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to update OMP subagent settings: ${err.message}`,
          code: "omp_subagent_settings_update_failed",
        },
      });
    }
  }
  async handleOmpSubagentSettingsEnabledUpdateRequest(
    msg: Extract<
      SessionInboundMessage,
      { type: "omp.subagents.management.enabled.update.request" }
    >,
  ): Promise<void> {
    try {
      const settings = await this.providerSnapshotManager.updateOmpSubagentSettingsEnabled(
        msg.enabled,
      );
      this.host.emit({
        type: "omp.subagents.management.enabled.update.response",
        payload: { ...settings, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to update OMP subagent override state");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to update OMP subagent override state: ${err.message}`,
          code: "omp_subagent_settings_enabled_update_failed",
        },
      });
    }
  }

  async handleOmpMemorySettingsGetRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.memory.settings.get.request" }>,
  ): Promise<void> {
    try {
      const settings = await this.providerSnapshotManager.getOmpMemorySettings();
      this.host.emit({
        type: "omp.memory.settings.get.response",
        payload: { ...settings, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to load OMP memory settings");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to load OMP memory settings: ${err.message}`,
          code: "omp_memory_settings_failed",
        },
      });
    }
  }

  async handleOmpMemorySettingsUpdateRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.memory.settings.update.request" }>,
  ): Promise<void> {
    try {
      const settings = await this.providerSnapshotManager.updateOmpMemorySettings(
        msg.expectedRevision,
        msg.patch,
      );
      this.host.emit({
        type: "omp.memory.settings.update.response",
        payload: { ...settings, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const conflict = err.name === "OmpMemorySettingsConflictError";
      this.logger.error({ err }, "Failed to update OMP memory settings");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to update OMP memory settings: ${err.message}`,
          code: conflict ? "omp_memory_settings_conflict" : "omp_memory_settings_update_failed",
        },
      });
    }
  }

  async handleOmpProviderContextWindowOverridesUpdateRequest(
    msg: Extract<
      SessionInboundMessage,
      { type: "omp.provider.management.context_windows.update.request" }
    >,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.updateOmpModelContextWindowOverrides(
        msg.providerId,
        msg.overrides,
      );
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.management.context_windows.update.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to update OMP model context windows");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to update OMP model context windows: ${err.message}`,
          code: "omp_provider_context_windows_update_failed",
        },
      });
    }
  }
  async handleOmpProviderAccountOrderUpdateRequest(
    msg: Extract<
      SessionInboundMessage,
      { type: "omp.provider.management.accounts.reorder.request" }
    >,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.reorderOmpProviderAccounts(
        msg.providerId,
        msg.credentialIds,
      );
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.management.accounts.reorder.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to reorder OMP provider accounts");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to reorder OMP provider accounts: ${err.message}`,
          code: "omp_provider_accounts_reorder_failed",
        },
      });
    }
  }

  async handleOmpProviderManagementAddRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.management.add.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.addOmpProvider(msg.provider);
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.management.add.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to add OMP provider");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to add OMP provider: ${err.message}`,
          code: "omp_provider_management_add_failed",
        },
      });
    }
  }
  async handleOmpProviderModelDiscoveryRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.models.discover.request" }>,
  ): Promise<void> {
    try {
      const models = await discoverOmpProviderModels(msg);
      this.host.emit({
        type: "omp.provider.models.discover.response",
        payload: { models, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to discover OMP provider models");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to fetch model list: ${err.message}`,
          code: "omp_provider_model_discovery_failed",
        },
      });
    }
  }

  async handleOmpProviderManagementRemoveRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.management.remove.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.removeOmpProvider(msg.providerId);
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.management.remove.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to remove OMP provider");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to remove OMP provider: ${err.message}`,
          code: "omp_provider_management_remove_failed",
        },
      });
    }
  }
  async handleOmpInstallStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.install.status.request" }>,
  ): Promise<void> {
    try {
      const status = await this.providerSnapshotManager.getOmpInstallationStatus({
        checkForUpdates: msg.checkForUpdates,
      });
      this.host.emit({
        type: "omp.install.status.response",
        payload: {
          ...status,
          activeAgentCount: this.host.listActiveOmpAgentIds().length,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to detect OMP: ${err.message}`,
          code: "omp_install_status_failed",
        },
      });
    }
  }

  async handleOmpInstallRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.install.request" }>,
  ): Promise<void> {
    try {
      if (msg.action === "cancel") {
        const status = await this.providerSnapshotManager.cancelOmpInstall();
        this.host.emit({
          type: "omp.install.response",
          payload: {
            ...status,
            activeAgentCount: this.host.listActiveOmpAgentIds().length,
            requestId: msg.requestId,
          },
        });
        return;
      }

      let activeAgentIds = this.host.listActiveOmpAgentIds();
      if (msg.strategy === "stop-agents" && activeAgentIds.length > 0) {
        await this.host.stopOmpAgents(activeAgentIds);
        activeAgentIds = this.host.listActiveOmpAgentIds();
      }
      if (activeAgentIds.length > 0 && msg.strategy !== "defer") {
        const status = await this.providerSnapshotManager.getOmpInstallationStatus({
          checkForUpdates: true,
        });
        if (status.platform === "win32") {
          this.host.emit({
            type: "omp.install.response",
            payload: {
              ...status,
              updatePhase: "waiting-for-agents",
              activeAgentCount: activeAgentIds.length,
              message: `OMP is being used by ${activeAgentIds.length} Agent${activeAgentIds.length === 1 ? "" : "s"}. Stop them or install the update after restart.`,
              requestId: msg.requestId,
            },
          });
          return;
        }
      }

      const status = await this.providerSnapshotManager.installOmp({
        defer: msg.strategy === "defer",
      });
      if (status.updatePhase === "complete") {
        await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      }
      this.host.emit({
        type: "omp.install.response",
        payload: {
          ...status,
          activeAgentCount: this.host.listActiveOmpAgentIds().length,
          requestId: msg.requestId,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to install OMP");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to install OMP: ${err.message}`,
          code: "omp_install_failed",
        },
      });
    }
  }

  async handleOmpProviderLoginStartRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.login.start.request" }>,
  ): Promise<void> {
    try {
      const flow = await this.providerSnapshotManager.startOmpProviderLogin(msg.providerId);
      this.host.emit({
        type: "omp.provider.login.start.response",
        payload: { ...flow, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err, providerId: msg.providerId }, "Failed to start OMP login");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to start OMP login: ${err.message}`,
          code: "omp_provider_login_start_failed",
        },
      });
    }
  }

  async handleOmpProviderLoginFinishRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.login.finish.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.finishOmpProviderLogin(
        msg.flowId,
        msg.input,
      );
      this.host.emit({
        type: "omp.provider.login.finish.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err }, "Failed to finish OMP login");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to finish OMP login: ${err.message}`,
          code: "omp_provider_login_finish_failed",
        },
      });
    }
  }
  async handleOmpProviderLoginCancelRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.login.cancel.request" }>,
  ): Promise<void> {
    try {
      const cancelled = await this.providerSnapshotManager.cancelOmpProviderLogin(msg.flowId);
      this.host.emit({
        type: "omp.provider.login.cancel.response",
        payload: { requestId: msg.requestId, flowId: msg.flowId, cancelled },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err, flowId: msg.flowId }, "Failed to cancel OMP login");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to cancel OMP login: ${err.message}`,
          code: "omp_provider_login_cancel_failed",
        },
      });
    }
  }
  async handleOmpProviderLogoutRequest(
    msg: Extract<SessionInboundMessage, { type: "omp.provider.logout.request" }>,
  ): Promise<void> {
    try {
      const management = await this.providerSnapshotManager.logoutOmpProvider(
        msg.providerId,
        msg.credentialId,
      );
      await this.providerSnapshotManager.refreshSettingsSnapshot({ providers: ["omp"] });
      this.host.emit({
        type: "omp.provider.logout.response",
        payload: { ...management, requestId: msg.requestId },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ err, providerId: msg.providerId }, "Failed to log out OMP provider");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to log out OMP provider: ${err.message}`,
          code: "omp_provider_logout_failed",
        },
      });
    }
  }

  async handleProviderUsageListRequest(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
    try {
      let usage: ProviderUsageListResult | undefined;
      if (msg.providerId && msg.providerId !== "cursor") {
        const management = await this.providerSnapshotManager.getOmpProviderManagement();
        const customProvider =
          configuredZhipuProviders(management.configYaml).find(
            (provider) => provider.providerId === msg.providerId,
          ) ?? resolveCustomProviderUsageConfig(management.configYaml, msg.providerId);
        if (customProvider) {
          const provider = await this.providerUsageService.fetchCustomUsage(customProvider);
          usage = {
            fetchedAt: provider.fetchedAt ?? new Date().toISOString(),
            providers: [provider],
          };
        }
      }
      usage ??= await this.providerUsageService.listUsage();
      if (!msg.providerId) {
        try {
          const management = await this.providerSnapshotManager.getOmpProviderManagement();
          const configured = configuredZhipuProviders(management.configYaml);
          const zhipu = await Promise.all(
            configured.map(async (provider) => {
              try {
                return await this.providerUsageService.fetchCustomUsage(provider);
              } catch {
                // A single provider failure must not hide the built-in providers.
                return {
                  providerId: provider.providerId,
                  displayName: provider.displayName,
                  status: "error" as const,
                  planLabel: null,
                  windows: [],
                  balances: [],
                  details: [],
                  error: "Zhipu usage request failed",
                };
              }
            }),
          );
          const builtInProviders = usage.providers;
          usage = {
            ...usage,
            providers: [
              ...builtInProviders,
              ...zhipu.filter(
                (provider) =>
                  !builtInProviders.some((builtIn) => builtIn.providerId === provider.providerId),
              ),
            ],
          };
        } catch {
          // Management/configuration may be unavailable independently of Cursor usage.
          this.logger.debug("Failed to discover Zhipu usage configuration");
        }
      }
      this.host.emit({
        type: "provider.usage.list.response",
        payload: {
          requestId: msg.requestId,
          fetchedAt: usage.fetchedAt,
          providers: usage.providers,
        },
      });
    } catch {
      // Never echo configuration, fetch, or parse errors (which may embed API keys).
      this.logger.error("Failed to list provider usage");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: "Failed to list provider usage",
          code: "provider_usage_list_failed",
        },
      });
    }
  }
}

function resolveCatalogRequestCwd(cwd?: string | null): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed ? expandTilde(trimmed) : undefined;
}
