import type { Logger } from "pino";
import type { ProviderOptions, ToolPolicy } from "@omp-desktop/protocol/agent-types";
import { z } from "zod";
import { applyOmpProxyEnabled } from "@omp-desktop/protocol/provider-config";

import type {
  AgentClient,
  AgentCreateConfigUnattendedInput,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRuntimeInfo,
  AgentSession,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderRefreshContext,
  ProviderCatalog,
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
  ResolveAgentDefaultModeInput,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import {
  isDefaultAgentCreateConfigUnattended,
  resolveDefaultAgentCreateConfig,
} from "./create-agent-mode.js";
import { normalizeAgentModelDefinition } from "./agent-sdk-types.js";
import { runProviderRefreshActivity } from "./provider-refresh-deadline.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
  ProviderProfileModel,
  ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import { ToolPolicyUnsupportedError, validateProviderOptions } from "./provider-options.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import type { OmpRuntime } from "./providers/omp/runtime.js";
import { CodexImportClientFacade } from "./providers/external-import/codex-provider.js";
import { PiImportClientFacade } from "./providers/external-import/pi-provider.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "@omp-desktop/protocol/provider-manifest";

export type { AgentProviderDefinition };

export { AGENT_PROVIDER_DEFINITIONS, getAgentProviderDefinition };

export interface ProviderDefinition extends AgentProviderDefinition {
  enabled: boolean;
  /**
   * The id of another *registered* provider this one extends (e.g. a Z.AI
   * profile that extends "claude"). null for built-in providers and for
   * generic ACP providers (which only extend the literal "acp" sentinel).
   */
  derivedFromProviderId: string | null;
  optionsSchema: z.ZodType<ProviderOptions>;
  supportsExactMcpPreapproval: boolean;
  validateOptions: (options: ProviderOptions | undefined) => ProviderOptions | undefined;
  applyOptions: (
    config: AgentSessionConfig,
    options: ProviderOptions | undefined,
  ) => AgentSessionConfig;
  applyToolPolicy: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
  createClient: (logger: Logger) => AgentClient;
  resolveCreateConfig: (input: ResolveAgentCreateConfigInput) => ResolveAgentCreateConfigResult;
  isCreateConfigUnattended: (input: AgentCreateConfigUnattendedInput) => boolean;
  /**
   * Single catalog discovery call used by ProviderSnapshotManager. Should spawn
   * at most one provider runtime process and return both models and modes.
   */
  fetchCatalog: (
    options: FetchCatalogOptions,
    client?: AgentClient,
    context?: ProviderRefreshContext,
  ) => Promise<ProviderCatalog>;
}

export interface BuildProviderRegistryOptions {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  ompRuntime?: OmpRuntime;
  desktopConfigDir?: string;
}

interface ProviderClientFactoryOptions extends Pick<
  BuildProviderRegistryOptions,
  "workspaceGitService" | "managedProcesses" | "ompRuntime" | "desktopConfigDir"
> {
  providerParams?: unknown;
}

type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
  options?: ProviderClientFactoryOptions,
) => AgentClient;

interface ResolvedProvider {
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
  profileModelsAreAdditive: boolean;
  enabled: boolean;
  derivedFromProviderId: string | null;
  providerParams?: unknown;
  createBaseClient: (logger: Logger) => AgentClient;
  contract: ProviderContract;
}

interface ProviderContract {
  optionsSchema: z.ZodType<ProviderOptions>;
  supportsExactMcpPreapproval: boolean;
  applyToolPolicy?: (provider: string, toolPolicy: ToolPolicy) => ToolPolicy;
}

const EmptyProviderOptionsSchema: z.ZodType<ProviderOptions> = z.object({}).strict();

const PROVIDER_CONTRACTS: Record<string, ProviderContract> = {};

const UNSUPPORTED_PROVIDER_CONTRACT: ProviderContract = {
  optionsSchema: EmptyProviderOptionsSchema,
  supportsExactMcpPreapproval: false,
};

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  omp: (logger, runtimeSettings, options) =>
    new OmpAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
      desktopConfigDir: options?.desktopConfigDir,
      runtime: options?.ompRuntime,
    }),
  // Import-only providers wrap the same OMP client: sessions run on the OMP
  // binary, while listing/import read external transcripts (pi / Codex).
  pi: (logger, runtimeSettings, options) => {
    const ompClient = new OmpAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
      desktopConfigDir: options?.desktopConfigDir,
      runtime: options?.ompRuntime,
    });
    return new PiImportClientFacade(ompClient, logger);
  },
  codex: (logger, runtimeSettings, options) => {
    const ompClient = new OmpAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
      desktopConfigDir: options?.desktopConfigDir,
      runtime: options?.ompRuntime,
    });
    return new CodexImportClientFacade(ompClient, logger);
  },
};

/**
 * Providers that can create brand-new sessions. Import-only providers
 * (pi/codex) have no creation modes and are surfaced through the
 * import-sessions sheet instead.
 */
export function isCreateCapableProvider(provider: string): boolean {
  return provider === "omp";
}

function getProviderClientFactory(provider: string): ProviderClientFactory {
  const factory = PROVIDER_CLIENT_FACTORIES[provider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${provider}'`);
  }
  return factory;
}

function toRuntimeSettings(override?: ProviderOverride): ProviderRuntimeSettings | undefined {
  if (!override?.command && !override?.env && !override?.disallowedTools) {
    return undefined;
  }

  return {
    command: override.command
      ? {
          mode: "replace",
          argv: override.command,
        }
      : undefined,
    env: override.env,
    disallowedTools: override.disallowedTools,
  };
}

function mergeRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    command: override?.command ?? base?.command,
    env:
      base?.env || override?.env
        ? {
            ...base?.env,
            ...override?.env,
          }
        : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}

function applyOverrideToDefinition(
  definition: AgentProviderDefinition,
  override?: ProviderOverride,
): AgentProviderDefinition {
  if (!override) {
    return definition;
  }

  return {
    ...definition,
    label: override.label ?? definition.label,
    description: override.description ?? definition.description,
  };
}

function mapPersistenceHandle(
  provider: AgentProvider,
  handle: AgentPersistenceHandle | null,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }

  return {
    ...handle,
    provider,
  };
}

function mapRuntimeInfo(provider: AgentProvider, runtimeInfo: AgentRuntimeInfo): AgentRuntimeInfo {
  return {
    ...runtimeInfo,
    provider,
  };
}

function mapStreamEvent(provider: AgentProvider, event: AgentStreamEvent): AgentStreamEvent {
  return {
    ...event,
    provider,
  };
}

function mapModel(
  provider: AgentProvider,
  model: AgentModelDefinition | ProviderProfileModel,
): AgentModelDefinition {
  return normalizeAgentModelDefinition({ ...model, provider });
}

function resolveConfiguredModels(
  provider: AgentProvider,
  client: AgentClient,
  models: ProviderProfileModel[],
): AgentModelDefinition[] {
  return models.map((model) => {
    const mapped = mapModel(provider, model);
    return client.resolveConfiguredModel?.(mapped) ?? mapped;
  });
}

function mergeModels(
  provider: AgentProvider,
  profileModels: ProviderProfileModel[],
  additionalModels: ProviderProfileModel[],
  runtimeModels: AgentModelDefinition[],
  options?: { profileModelsAreAdditive?: boolean },
): AgentModelDefinition[] {
  const baseModels = runtimeModels.map((model) => mapModel(provider, model));
  if (profileModels.length > 0 && options?.profileModelsAreAdditive !== true) {
    return mergeModelAdditions(
      provider,
      profileModels.map((model) => mapModel(provider, model)),
      additionalModels,
    );
  }

  return mergeModelAdditions(provider, baseModels, [...profileModels, ...additionalModels]);
}

function mergeModelAdditions(
  provider: AgentProvider,
  baseModels: AgentModelDefinition[],
  modelAdditions: Array<ProviderProfileModel | AgentModelDefinition>,
): AgentModelDefinition[] {
  if (modelAdditions.length === 0) {
    return baseModels;
  }

  const mergedModels = [...baseModels];
  let hasAdditionalDefault = false;

  for (const model of modelAdditions) {
    const additionalModel = mapModel(provider, model);
    hasAdditionalDefault ||= additionalModel.isDefault === true;

    const existingIndex = mergedModels.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex === -1) {
      mergedModels.push(additionalModel);
      continue;
    }

    const existingModel = mergedModels[existingIndex];
    const explicitlyEnablesCompatibilityModel =
      existingModel?.isSelectable === false && additionalModel.isSelectable === undefined;
    mergedModels[existingIndex] = {
      ...existingModel,
      ...additionalModel,
      ...(explicitlyEnablesCompatibilityModel ? { isSelectable: true } : {}),
    };
  }

  if (!hasAdditionalDefault) {
    return mergedModels;
  }

  const additionalDefaultIds = new Set(
    modelAdditions.filter((model) => model.isDefault === true).map((model) => model.id),
  );

  return mergedModels.map((model) =>
    additionalDefaultIds.has(model.id) ? model : Object.assign({}, model, { isDefault: false }),
  );
}

export function wrapSessionProvider(provider: AgentProvider, inner: AgentSession): AgentSession {
  return {
    provider,
    id: inner.id,
    capabilities: inner.capabilities,
    get features() {
      return inner.features;
    },
    run: (prompt, options) => inner.run(prompt, options),
    startTurn: (prompt, options) => inner.startTurn(prompt, options),
    subscribe: (callback) => inner.subscribe((event) => callback(mapStreamEvent(provider, event))),
    async *streamHistory() {
      for await (const event of inner.streamHistory()) {
        yield mapStreamEvent(provider, event);
      }
    },
    getRuntimeInfo: async () => mapRuntimeInfo(provider, await inner.getRuntimeInfo()),
    getAvailableModes: () => inner.getAvailableModes(),
    getCurrentMode: () => inner.getCurrentMode(),
    setMode: (modeId) => inner.setMode(modeId),
    getPendingPermissions: () => inner.getPendingPermissions(),
    respondToPermission: (requestId, response) => inner.respondToPermission(requestId, response),
    describePersistence: () => mapPersistenceHandle(provider, inner.describePersistence()),
    interrupt: () => inner.interrupt(),
    close: () => inner.close(),
    listCommands: inner.listCommands?.bind(inner),
    setModel: inner.setModel?.bind(inner),
    setThinkingOption: inner.setThinkingOption?.bind(inner),
    setFeature: inner.setFeature?.bind(inner),
    revertConversation: inner.revertConversation?.bind(inner),
    revertFiles: inner.revertFiles?.bind(inner),
    revertBoth: inner.revertBoth?.bind(inner),
    tryHandleOutOfBand: inner.tryHandleOutOfBand?.bind(inner),
  };
}

function bindOmpClientMethods(inner: AgentClient): Partial<AgentClient> {
  return {
    getOmpProviderManagement: inner.getOmpProviderManagement?.bind(inner),
    consumeOmpCodexResetCredit: inner.consumeOmpCodexResetCredit?.bind(inner),
    saveOmpProviderConfig: inner.saveOmpProviderConfig?.bind(inner),
    getOmpSubagentSettings: inner.getOmpSubagentSettings?.bind(inner),
    updateOmpSubagentModel: inner.updateOmpSubagentModel?.bind(inner),
    updateOmpSubagentSettingsEnabled: inner.updateOmpSubagentSettingsEnabled?.bind(inner),
    getOmpMemorySettings: inner.getOmpMemorySettings?.bind(inner),
    updateOmpMemorySettings: inner.updateOmpMemorySettings?.bind(inner),
    updateOmpModelContextWindowOverrides: inner.updateOmpModelContextWindowOverrides?.bind(inner),
    reorderOmpProviderAccounts: inner.reorderOmpProviderAccounts?.bind(inner),
    addOmpProvider: inner.addOmpProvider?.bind(inner),
    removeOmpProvider: inner.removeOmpProvider?.bind(inner),
    getOmpInstallationStatus: inner.getOmpInstallationStatus?.bind(inner),
    installOmp: inner.installOmp?.bind(inner),
    startOmpProviderLogin: inner.startOmpProviderLogin?.bind(inner),
    finishOmpProviderLogin: inner.finishOmpProviderLogin?.bind(inner),
    cancelOmpProviderLogin: inner.cancelOmpProviderLogin?.bind(inner),
    logoutOmpProvider: inner.logoutOmpProvider?.bind(inner),
  };
}

function wrapClientProvider(
  provider: AgentProvider,
  inner: AgentClient,
  profileModels: ProviderProfileModel[],
  additionalModels: ProviderProfileModel[],
  profileModelsAreAdditive: boolean,
): AgentClient {
  const listImportableSessions = inner.listImportableSessions?.bind(inner);
  const importSession = inner.importSession?.bind(inner);
  const listFeatures = inner.listFeatures?.bind(inner);

  return {
    provider,
    capabilities: inner.capabilities,
    createSession: async (config, launchContext) =>
      wrapSessionProvider(
        provider,
        await inner.createSession(
          {
            ...config,
            provider: inner.provider,
          },
          launchContext,
        ),
      ),
    resumeSession: async (handle, overrides, launchContext, options) =>
      wrapSessionProvider(
        provider,
        await inner.resumeSession(
          {
            ...handle,
            provider: inner.provider,
          },
          overrides
            ? {
                ...overrides,
                provider: inner.provider,
              }
            : undefined,
          launchContext,
          options,
        ),
      ),
    fetchCatalog: async (options, context) => {
      const catalog = await inner.fetchCatalog(options, context);
      return {
        ...catalog,
        models: mergeModels(provider, profileModels, additionalModels, catalog.models, {
          profileModelsAreAdditive,
        }),
        modes: catalog.modes,
      };
    },
    resolveDefaultModeId: inner.resolveDefaultModeId
      ? async ({ config, env, signal }: ResolveAgentDefaultModeInput) =>
          await inner.resolveDefaultModeId?.({
            config: { ...config, provider: inner.provider },
            env,
            signal,
          })
      : undefined,
    resolveCreateConfig: inner.resolveCreateConfig?.bind(inner),
    resolveConfiguredModel: inner.resolveConfiguredModel?.bind(inner),
    isCreateConfigUnattended: inner.isCreateConfigUnattended?.bind(inner),
    listFeatures: listFeatures
      ? async (config) => await listFeatures({ ...config, provider: inner.provider })
      : undefined,
    listImportableSessions: listImportableSessions
      ? async (options) => await listImportableSessions(options)
      : undefined,
    importSession: importSession
      ? async (input, context) => {
          const imported = await importSession(input, {
            ...context,
            config: {
              ...context.config,
              provider: inner.provider,
            },
            storedConfig: {
              ...context.storedConfig,
              provider: inner.provider,
            },
          });
          const persistence = mapPersistenceHandle(provider, imported.persistence);
          if (!persistence) {
            throw new Error(`Provider '${provider}' import did not return persistence`);
          }
          return {
            ...imported,
            session: wrapSessionProvider(provider, imported.session),
            config: {
              ...imported.config,
              provider,
            },
            persistence,
          };
        }
      : undefined,
    isAvailable: (signal) => inner.isAvailable(signal),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
    ...bindOmpClientMethods(inner),
  };
}

function createRegistryEntry(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): ProviderDefinition {
  const modelClient = resolved.createBaseClient(logger);
  const profileModels = resolveConfiguredModels(provider, modelClient, resolved.profileModels);
  const additionalModels = resolveConfiguredModels(
    provider,
    modelClient,
    resolved.additionalModels,
  );
  const hasReplacementModels = profileModels.length > 0 && !resolved.profileModelsAreAdditive;
  const replacementModels = hasReplacementModels
    ? profileModels.map((model) => mapModel(provider, model))
    : [];

  const decorateModes = (modes: AgentMode[]): AgentMode[] =>
    modes.map((mode) => {
      if (mode.icon && mode.colorTier) return mode;
      const definitionMode = resolved.definition.modes.find((d) => d.id === mode.id);
      if (!definitionMode) return mode;
      return Object.assign({}, mode, {
        icon: mode.icon ?? definitionMode.icon,
        colorTier: mode.colorTier ?? definitionMode.colorTier,
      });
    });

  const hasStaticModes = resolved.definition.modes.length > 0;

  return {
    ...resolved.definition,
    enabled: resolved.enabled,
    derivedFromProviderId: resolved.derivedFromProviderId,
    optionsSchema: resolved.contract.optionsSchema,
    supportsExactMcpPreapproval: resolved.contract.supportsExactMcpPreapproval,
    validateOptions: (options) =>
      validateProviderOptions(provider, resolved.contract.optionsSchema, options),
    applyOptions: (config, options) => ({ ...config, providerOptions: options }),
    applyToolPolicy: (config, toolPolicy) => {
      if (toolPolicy && !resolved.contract.supportsExactMcpPreapproval) {
        throw new ToolPolicyUnsupportedError(provider);
      }
      return {
        ...config,
        toolPolicy: toolPolicy
          ? (resolved.contract.applyToolPolicy?.(provider, toolPolicy) ?? toolPolicy)
          : undefined,
      };
    },
    createClient: (providerLogger: Logger) =>
      createResolvedProviderClient(providerLogger, provider, resolved),
    resolveCreateConfig: modelClient.resolveCreateConfig ?? resolveDefaultAgentCreateConfig,
    isCreateConfigUnattended:
      modelClient.isCreateConfigUnattended ?? isDefaultAgentCreateConfigUnattended,
    fetchCatalog: async (
      options: FetchCatalogOptions,
      client?: AgentClient,
      context?: ProviderRefreshContext,
    ) => {
      const catalogClient = client ?? modelClient;
      if (hasReplacementModels) {
        // Replacement models skip runtime model discovery, but additionalModels
        // must still be merged on top. If modes are dynamic, probe for modes via
        // the single catalog API; otherwise use static/empty modes with no runtime.
        const models = mergeModelAdditions(provider, replacementModels, additionalModels);
        if (hasStaticModes) {
          const defaultModeId = await runProviderRefreshActivity(
            context,
            "default-mode",
            async () =>
              await catalogClient.resolveDefaultModeId?.({
                config: {
                  provider,
                  cwd: options.scope === "workspace" ? options.cwd : process.cwd(),
                },
                signal: context?.signal,
              }),
          );
          return {
            models,
            modes: decorateModes(resolved.definition.modes),
            defaultModeId,
          };
        }
        const catalog = await catalogClient.fetchCatalog(options, context);
        return { ...catalog, models, modes: hasStaticModes ? decorateModes(catalog.modes) : [] };
      }

      const catalog = await catalogClient.fetchCatalog(options, context);
      // Import-only providers (pi/codex) define modes: [] — they run sessions
      // on the OMP runtime but must not inherit OMP's creation modes, or the
      // UI's "no modes means not create-capable" filter leaks them into the
      // new-session provider list.
      const modes = hasStaticModes ? decorateModes(catalog.modes) : [];
      return {
        ...catalog,
        models: mergeModels(provider, profileModels, additionalModels, catalog.models, {
          profileModelsAreAdditive: resolved.profileModelsAreAdditive,
        }),
        modes,
      };
    },
  };
}

function createResolvedProviderClient(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): AgentClient {
  const inner = resolved.createBaseClient(logger);
  const profileModels = resolveConfiguredModels(provider, inner, resolved.profileModels);
  const additionalModels = resolveConfiguredModels(provider, inner, resolved.additionalModels);
  const hasModelOverrides = profileModels.length > 0 || additionalModels.length > 0;
  if (inner.provider === provider && !hasModelOverrides) {
    return inner;
  }
  return wrapClientProvider(
    provider,
    inner,
    profileModels,
    additionalModels,
    resolved.profileModelsAreAdditive,
  );
}

function buildResolvedBuiltinProviders(
  providerOverrides: Record<string, ProviderOverride>,
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
  options: Pick<
    BuildProviderRegistryOptions,
    "workspaceGitService" | "managedProcesses" | "ompRuntime" | "desktopConfigDir"
  >,
  isDev: boolean,
): Map<string, ResolvedProvider> {
  const resolvedProviders = new Map<string, ResolvedProvider>();

  const definitions = isDev
    ? [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS]
    : AGENT_PROVIDER_DEFINITIONS;

  for (const definition of definitions) {
    const override = providerOverrides[definition.id];
    const factory = getProviderClientFactory(definition.id);
    const configuredRuntimeSettings = mergeRuntimeSettings(
      runtimeSettings?.[definition.id],
      toRuntimeSettings(override),
    );
    const mergedRuntimeSettings =
      definition.id === "omp"
        ? applyOmpProxyEnabled(configuredRuntimeSettings, override)
        : configuredRuntimeSettings;

    resolvedProviders.set(definition.id, {
      definition: applyOverrideToDefinition(definition, override),
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override?.models ?? [],
      additionalModels: override?.additionalModels ?? [],
      profileModelsAreAdditive: false,
      enabled: override?.enabled ?? definition.enabledByDefault ?? true,
      derivedFromProviderId: null,
      providerParams: override?.params,
      createBaseClient: (logger) =>
        factory(logger, mergedRuntimeSettings, {
          workspaceGitService: options.workspaceGitService,
          managedProcesses: options.managedProcesses,
          ompRuntime: options.ompRuntime,
          desktopConfigDir: options.desktopConfigDir,
          providerParams: override?.params,
        }),
      contract: PROVIDER_CONTRACTS[definition.id] ?? UNSUPPORTED_PROVIDER_CONTRACT,
    });
  }

  return resolvedProviders;
}

function rejectDerivedProviders(
  resolvedProviders: Map<string, ResolvedProvider>,
  providerOverrides: Record<string, ProviderOverride>,
): void {
  for (const providerId of Object.keys(providerOverrides)) {
    if (!resolvedProviders.has(providerId)) {
      throw new Error(
        `OMP Desktop supports only the built-in 'omp' provider; received '${providerId}'`,
      );
    }
  }
}

export function buildProviderRegistry(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, ProviderDefinition> {
  const runtimeSettings = options?.runtimeSettings;
  const providerOverrides = options?.providerOverrides ?? {};
  const resolvedProviders = buildResolvedBuiltinProviders(
    providerOverrides,
    runtimeSettings,
    {
      workspaceGitService: options?.workspaceGitService,
      managedProcesses: options?.managedProcesses,
      ompRuntime: options?.ompRuntime,
      desktopConfigDir: options?.desktopConfigDir,
    },
    options?.isDev === true,
  );
  rejectDerivedProviders(resolvedProviders, providerOverrides);

  return Object.fromEntries(
    [...resolvedProviders.entries()].map(([provider, resolved]) => [
      provider,
      createRegistryEntry(logger, provider, resolved),
    ]),
  ) as Record<AgentProvider, ProviderDefinition>;
}

export function getProviderIds(
  registry: Record<AgentProvider, ProviderDefinition>,
): AgentProvider[] {
  return Object.keys(registry);
}

// Deprecated: Use buildProviderRegistry instead
export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> =
  null as unknown as Record<AgentProvider, ProviderDefinition>;

export function createAllClients(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, AgentClient> {
  return createClientsFromRegistry(buildProviderRegistry(logger, options), logger);
}

export function createClientsFromRegistry(
  registry: Record<AgentProvider, ProviderDefinition>,
  logger: Logger,
): Record<AgentProvider, AgentClient> {
  return Object.fromEntries(
    Object.entries(registry).map(([provider, definition]) => [
      provider,
      definition.createClient(logger),
    ]),
  ) as Record<AgentProvider, AgentClient>;
}

export async function shutdownProviders(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Promise<void> {
  const clients = createAllClients(logger, options);
  await shutdownAgentClients(Object.values(clients), logger);
}

export async function shutdownAgentClients(
  clients: Iterable<AgentClient>,
  logger: Logger,
): Promise<void> {
  await Promise.all(
    Array.from(clients).map(async (client) => {
      if (!client.shutdown) return;
      try {
        await client.shutdown();
      } catch (error) {
        logger.warn({ err: error, provider: client.provider }, "Provider client shutdown failed");
      }
    }),
  );
}
