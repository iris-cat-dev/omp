import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";
import { ProviderOverrideSchema } from "./agent/provider-launch-config.js";
import {
  OmpProviderParamsSchema,
  validateOmpBuiltinToolConfigSync,
} from "./agent/providers/omp/provider-config.js";
import { ensureManagedOmpOnPath } from "./agent/providers/omp/installer.js";
import {
  MutableDaemonConfigSchema,
  MutableDaemonConfigPatchSchema,
} from "@omp-desktop/protocol/messages";
import type { AgentSkillSelection } from "@omp-desktop/protocol/messages";
import { parseRelayAddress } from "@omp-desktop/protocol/connection-offer";
import { shouldUseTlsForDefaultHostedRelay } from "@omp-desktop/protocol/daemon-endpoints";
import { DEFAULT_RELAY_ENDPOINT } from "./config.js";
import { normalizeImageGenerationBaseUrl } from "./image-generation/base-url.js";

export type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@omp-desktop/protocol/messages";

type MutableDaemonConfig = import("@omp-desktop/protocol/messages").MutableDaemonConfig;
type MutableDaemonConfigPatch = import("@omp-desktop/protocol/messages").MutableDaemonConfigPatch;
type ProviderOverride = import("./agent/provider-launch-config.js").ProviderOverride;

interface SupportedMutableConfigPatch {
  relay?: {
    enabled?: boolean;
    endpoint?: string;
    useTls?: boolean;
    publicEndpoint?: string;
    publicUseTls?: boolean;
  };
  mcp?: MutableDaemonConfigPatch["mcp"];
  providers?: MutableDaemonConfig["providers"];
  removeProviders?: string[];
  metadataGeneration?: MutableDaemonConfigPatch["metadataGeneration"];
  quickAsk?: MutableDaemonConfigPatch["quickAsk"];
  imageGeneration?: MutableDaemonConfigPatch["imageGeneration"];
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: MutableDaemonConfig["terminalProfiles"];
  agentProfiles?: MutableDaemonConfig["agentProfiles"];
  ompProviderAccountNotes?: MutableDaemonConfig["ompProviderAccountNotes"];
  skills?: MutableDaemonConfig["skills"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
}

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

export interface DaemonConfigChangeDetails {
  removedProviders: readonly string[];
}

export interface DaemonConfigReloadResult {
  appliedPaths: string[];
  restartRequiredPaths: string[];
  overrideControlledPaths: string[];
}

export type ImageGenerationRuntimeConfig = NonNullable<MutableDaemonConfig["imageGeneration"]> & {
  apiKey?: string;
};

export interface DaemonConfigReloadSource {
  resolve(persisted: PersistedConfig): {
    mutable: MutableDaemonConfig;
    overrideControlledPaths: readonly string[];
  };
}

type ConfigListener = (config: MutableDaemonConfig, details: DaemonConfigChangeDetails) => void;
type ConfigApplyRollback = () => void;
type ConfigApplyListener = (
  config: MutableDaemonConfig,
  previous: MutableDaemonConfig,
  details: DaemonConfigChangeDetails,
) => ConfigApplyRollback;
type FieldChangeHandler = (value: unknown) => void;

interface AppliedFieldChange {
  handler: FieldChangeHandler;
  previousValue: unknown;
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "daemon-config-store" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) {
      continue;
    }
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function omitProvidersFromConfig<T extends { providers?: Record<string, unknown> }>(
  config: T,
  providers: readonly string[],
): T {
  if (providers.length === 0 || !config.providers) {
    return config;
  }

  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }

  return changed ? ({ ...config, providers: nextProviders } as T) : config;
}

interface ConfiguredProviderEntry {
  provider?: unknown;
}

function omitRemovedProviderEntries<T extends ConfiguredProviderEntry>(
  entries: T[] | undefined,
  removedProviders: ReadonlySet<string>,
): T[] | undefined {
  if (!entries) {
    return undefined;
  }
  const filtered = entries.filter(
    (entry) => typeof entry.provider !== "string" || !removedProviders.has(entry.provider),
  );
  return filtered.length === entries.length ? entries : filtered;
}

function omitGenerationProvidersFromConfig<
  T extends {
    metadataGeneration?: {
      providers?: ConfiguredProviderEntry[];
      commitMessageProviders?: ConfiguredProviderEntry[];
    };
    quickAsk?: { providers?: ConfiguredProviderEntry[] };
  },
>(config: T, providers: readonly string[]): T {
  if (providers.length === 0) {
    return config;
  }

  const removedProviders = new Set(providers);
  const metadataGeneration = config.metadataGeneration;
  const quickAsk = config.quickAsk;
  const metadataProviders = omitRemovedProviderEntries(
    metadataGeneration?.providers,
    removedProviders,
  );
  const commitMessageProviders = omitRemovedProviderEntries(
    metadataGeneration?.commitMessageProviders,
    removedProviders,
  );
  const quickAskProviders = omitRemovedProviderEntries(quickAsk?.providers, removedProviders);
  if (
    metadataProviders === metadataGeneration?.providers &&
    commitMessageProviders === metadataGeneration?.commitMessageProviders &&
    quickAskProviders === quickAsk?.providers
  ) {
    return config;
  }

  return {
    ...config,
    ...(metadataGeneration
      ? {
          metadataGeneration: {
            ...metadataGeneration,
            ...(metadataProviders ? { providers: metadataProviders } : {}),
            ...(commitMessageProviders ? { commitMessageProviders } : {}),
          },
        }
      : {}),
    ...(quickAsk
      ? {
          quickAsk: { ...quickAsk, ...(quickAskProviders ? { providers: quickAskProviders } : {}) },
        }
      : {}),
  } as T;
}

function omitProvidersFromOverrides(
  overrides: Record<string, ProviderOverride> | undefined,
  providers: readonly string[],
): Record<string, ProviderOverride> | undefined {
  if (!overrides) {
    return undefined;
  }

  const nextOverrides = { ...overrides };
  for (const provider of providers) {
    delete nextOverrides[provider];
  }

  return Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
}

function getValueAtPath(config: MutableDaemonConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, segment) => (isRecord(value) ? value[segment] : undefined), config);
}

function isEqualValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function assertImageGenerationPatchMutable(
  patch: NonNullable<MutableDaemonConfigPatch["imageGeneration"]>,
  env: NodeJS.ProcessEnv,
): void {
  if (patch.enabled !== undefined && env.PASEO_IMAGE_GENERATION_ENABLED !== undefined) {
    throw new Error(
      "Image generation enabled state is controlled by PASEO_IMAGE_GENERATION_ENABLED.",
    );
  }
  if (patch.model !== undefined && nonEmptyEnvironmentValue(env.PASEO_IMAGE_GENERATION_MODEL)) {
    throw new Error("Image generation model is controlled by PASEO_IMAGE_GENERATION_MODEL.");
  }
  if (patch.baseUrl !== undefined && nonEmptyEnvironmentValue(env.OPENAI_BASE_URL)) {
    throw new Error("Image generation base URL is controlled by OPENAI_BASE_URL.");
  }
  if (patch.apiKey !== undefined && nonEmptyEnvironmentValue(env.OPENAI_API_KEY)) {
    throw new Error("Image generation API key is controlled by OPENAI_API_KEY.");
  }
}

function createImageGenerationPublicConfig(
  current: MutableDaemonConfig["imageGeneration"],
): NonNullable<MutableDaemonConfig["imageGeneration"]> {
  return {
    enabled: current?.enabled ?? false,
    provider: "openai",
    backend: current?.backend ?? "openai-api",
    model: current?.model ?? "gpt-image-2",
    ...(current?.baseUrl ? { baseUrl: current.baseUrl } : {}),
    apiKeyConfigured: current?.apiKeyConfigured ?? false,
    apiKeySource: current?.apiKeySource ?? null,
    ...(current?.subscriptionCredentialId
      ? { subscriptionCredentialId: current.subscriptionCredentialId }
      : {}),
  };
}

function applyImageGenerationPatchToPublicConfig(
  current: MutableDaemonConfig["imageGeneration"],
  patch: NonNullable<MutableDaemonConfigPatch["imageGeneration"]>,
  env: NodeJS.ProcessEnv,
): NonNullable<MutableDaemonConfig["imageGeneration"]> {
  assertImageGenerationPatchMutable(patch, env);
  const next = createImageGenerationPublicConfig(current);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.backend !== undefined) next.backend = patch.backend;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null) delete next.baseUrl;
    else next.baseUrl = normalizeImageGenerationBaseUrl(patch.baseUrl);
  }
  if (patch.apiKey !== undefined) {
    next.apiKeyConfigured = patch.apiKey !== null;
    next.apiKeySource = patch.apiKey === null ? null : "config";
  }
  if (patch.subscriptionCredentialId !== undefined) {
    if (patch.subscriptionCredentialId === null) delete next.subscriptionCredentialId;
    else next.subscriptionCredentialId = patch.subscriptionCredentialId;
  }
  return next;
}

const RELOADABLE_PATHS = [
  "daemon.relay.enabled",
  "daemon.relay.endpoint",
  "daemon.relay.useTls",
  "daemon.relay.publicEndpoint",
  "daemon.relay.publicUseTls",
  "daemon.mcp.enabled",
  "daemon.mcp.injectIntoAgents",
  "daemon.mcp.toolCapabilities",
  "daemon.hostnames",
  "daemon.cors.allowedOrigins",
  "daemon.trustedProxies",
  "daemon.git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks",
  "daemon.appendSystemPrompt",
  "daemon.terminalProfiles",
  "daemon.agentProfiles",
  "daemon.ompProviderAccountNotes",
  "app.baseUrl",
  "agents.providers",
  "agents.catalogRefreshTimeoutMs",
  "agents.metadataGeneration",
  "agents.quickAsk",
  "agents.skills.selection",
  "pluginsEnabled",
  "providers.openai.image",
] as const;

const PERSISTED_TO_MUTABLE_PATH: Record<string, string> = {
  "daemon.relay.enabled": "relay.enabled",
  "daemon.relay.endpoint": "relay.endpoint",
  "daemon.relay.useTls": "relay.useTls",
  "daemon.relay.publicEndpoint": "relay.publicEndpoint",
  "daemon.relay.publicUseTls": "relay.publicUseTls",
  "daemon.mcp.enabled": "mcp.enabled",
  "daemon.mcp.injectIntoAgents": "mcp.injectIntoAgents",
  "daemon.mcp.toolCapabilities": "mcp.toolCapabilities",
  "daemon.hostnames": "hostnames",
  "daemon.cors.allowedOrigins": "cors.allowedOrigins",
  "daemon.trustedProxies": "trustedProxies",
  "daemon.git.maxProcessesPerSecond": "git.maxProcessesPerSecond",
  "daemon.git.maxProcessConcurrency": "git.maxProcessConcurrency",
  "daemon.autoArchiveAfterMerge": "autoArchiveAfterMerge",
  "daemon.enableTerminalAgentHooks": "enableTerminalAgentHooks",
  "daemon.appendSystemPrompt": "appendSystemPrompt",
  "daemon.terminalProfiles": "terminalProfiles",
  "daemon.agentProfiles": "agentProfiles",
  "daemon.ompProviderAccountNotes": "ompProviderAccountNotes",
  "app.baseUrl": "app.baseUrl",
  "agents.providers": "providers",
  "agents.catalogRefreshTimeoutMs": "catalogRefreshTimeoutMs",
  "agents.metadataGeneration": "metadataGeneration",
  "agents.quickAsk": "quickAsk",
  "agents.skills.selection": "skills.selection",
  pluginsEnabled: "pluginsEnabled",
  "providers.openai.image": "imageGeneration",
};

function pathBelongsTo(path: string, owner: string): boolean {
  return path === owner || path.startsWith(`${owner}.`);
}

function diffPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (isEqualValue(previous, next)) return [];
  if (!isRecord(previous) || !isRecord(next)) {
    if (isRecord(previous)) return leafPaths(previous, prefix);
    if (isRecord(next)) return leafPaths(next, prefix);
    return prefix ? [prefix] : [];
  }

  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return Array.from(keys).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return diffPaths(previous[key], next[key], path);
  });
}

function leafPaths(record: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? leafPaths(value, path) : [path];
  });
}

function compactOwnedPaths(paths: readonly string[], owners: readonly string[]): string[] {
  const compacted = new Set<string>();
  for (const path of paths) {
    const owner = owners.find((candidate) => pathBelongsTo(path, candidate));
    compacted.add(owner ?? path);
  }
  return Array.from(compacted).sort();
}

function pickRelayPatchField(
  patch: MutableDaemonConfigPatch,
): Pick<SupportedMutableConfigPatch, "relay"> {
  if (patch.relay === undefined) return {};
  const relay = patch.relay;
  return {
    relay: {
      ...(relay.enabled !== undefined ? { enabled: relay.enabled } : {}),
      ...(relay.endpoint !== undefined ? { endpoint: relay.endpoint } : {}),
      ...(relay.useTls !== undefined ? { useTls: relay.useTls } : {}),
      ...(relay.publicEndpoint !== undefined ? { publicEndpoint: relay.publicEndpoint } : {}),
      ...(relay.publicUseTls !== undefined ? { publicUseTls: relay.publicUseTls } : {}),
    },
  };
}

function pickMcpPatchField(
  patch: MutableDaemonConfigPatch,
): Pick<SupportedMutableConfigPatch, "mcp"> {
  if (patch.mcp === undefined) return {};
  return {
    mcp: {
      ...(patch.mcp.injectIntoAgents !== undefined
        ? { injectIntoAgents: patch.mcp.injectIntoAgents }
        : {}),
      ...(patch.mcp.toolCapabilities !== undefined
        ? { toolCapabilities: patch.mcp.toolCapabilities }
        : {}),
    },
  };
}

function pickQuickAskPatchField(
  patch: MutableDaemonConfigPatch,
): Pick<SupportedMutableConfigPatch, "quickAsk"> {
  return patch.quickAsk === undefined ? {} : { quickAsk: patch.quickAsk };
}

function pickSupportedPatchFields(patch: MutableDaemonConfigPatch): SupportedMutableConfigPatch {
  return {
    ...pickRelayPatchField(patch),
    ...pickMcpPatchField(patch),
    ...(patch.providers !== undefined ? { providers: patch.providers } : {}),
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...(patch.metadataGeneration !== undefined
      ? { metadataGeneration: patch.metadataGeneration }
      : {}),
    ...pickQuickAskPatchField(patch),
    ...(patch.imageGeneration !== undefined ? { imageGeneration: patch.imageGeneration } : {}),
    ...(patch.autoArchiveAfterMerge !== undefined
      ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge }
      : {}),
    ...(patch.enableTerminalAgentHooks !== undefined
      ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks }
      : {}),
    ...(patch.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: patch.appendSystemPrompt }
      : {}),
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.ompProviderAccountNotes !== undefined
      ? { ompProviderAccountNotes: patch.ompProviderAccountNotes }
      : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
  };
}

function applyRelayAddressDefaults(
  relay: NonNullable<MutableDaemonConfig["relay"]>,
  patch: NonNullable<SupportedMutableConfigPatch["relay"]>,
  persistedRelay: NonNullable<PersistedConfig["daemon"]>["relay"],
  env: NodeJS.ProcessEnv,
): NonNullable<MutableDaemonConfig["relay"]> {
  const endpoint = relay.endpoint ?? DEFAULT_RELAY_ENDPOINT;
  const useTls = relay.useTls ?? shouldUseTlsForDefaultHostedRelay(endpoint);
  const publicEndpointExplicit =
    patch.publicEndpoint !== undefined ||
    persistedRelay?.publicEndpoint !== undefined ||
    env.PASEO_RELAY_PUBLIC_ENDPOINT !== undefined;
  const publicTlsExplicit =
    patch.publicUseTls !== undefined ||
    persistedRelay?.publicUseTls !== undefined ||
    env.PASEO_RELAY_PUBLIC_USE_TLS !== undefined;
  return {
    ...relay,
    endpoint,
    useTls,
    publicEndpoint: publicEndpointExplicit ? (relay.publicEndpoint ?? endpoint) : endpoint,
    publicUseTls: publicTlsExplicit
      ? (relay.publicUseTls ?? useTls)
      : parseRelayAddress(
          publicEndpointExplicit
            ? (patch.publicEndpoint ??
                env.PASEO_RELAY_PUBLIC_ENDPOINT ??
                persistedRelay?.publicEndpoint ??
                relay.publicEndpoint ??
                endpoint)
            : endpoint,
          useTls,
        ).useTls,
  };
}

export function applyMutableProviderConfigToOverrides(
  baseOverrides: Record<string, ProviderOverride> | undefined,
  mutableProviders: MutableDaemonConfig["providers"] | undefined,
): Record<string, ProviderOverride> | undefined {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) {
    return undefined;
  }

  const nextOverrides: Record<string, ProviderOverride> = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const parsed = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...nextOverrides[providerId],
      ...parsed,
      ...(parsed.params
        ? { params: { ...nextOverrides[providerId]?.params, ...parsed.params } }
        : {}),
    };
  }

  return nextOverrides;
}

export class DaemonConfigStore {
  private current: MutableDaemonConfig;
  private readonly paseoHome: string;
  private readonly logger: LoggerLike | undefined;
  private readonly changeListeners = new Set<ConfigListener>();
  private readonly applyListeners = new Set<ConfigApplyListener>();
  private readonly fieldChangeHandlers = new Map<string, Set<FieldChangeHandler>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly relayEnabledMutable: boolean;
  private readonly relayOverrideControlledPaths: readonly string[];
  private readonly reloadSource: DaemonConfigReloadSource | undefined;
  private readonly startupPersisted: PersistedConfig;
  private lastKnownPersisted: PersistedConfig;

  constructor(
    paseoHome: string,
    initial: MutableDaemonConfig,
    logger?: LoggerLike,
    options: {
      relayEnabledMutable?: boolean;
      relayOverrideControlledPaths?: readonly string[];
      reloadSource?: DaemonConfigReloadSource;
      startupPersisted?: PersistedConfig;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.paseoHome = paseoHome;
    this.logger = getLogger(logger);
    this.current = MutableDaemonConfigSchema.parse({
      ...initial,
      relay: initial.relay ?? { enabled: false },
    });
    this.relayEnabledMutable = options.relayEnabledMutable ?? true;
    this.reloadSource = options.reloadSource;
    this.startupPersisted = options.startupPersisted ?? loadPersistedConfig(paseoHome, this.logger);
    this.env = options.env ?? process.env;
    this.relayOverrideControlledPaths = options.relayOverrideControlledPaths ?? [
      ...(this.env.PASEO_RELAY_ENDPOINT !== undefined ? ["daemon.relay.endpoint"] : []),
      ...(this.env.PASEO_RELAY_USE_TLS !== undefined ? ["daemon.relay.useTls"] : []),
      ...(this.env.PASEO_RELAY_PUBLIC_ENDPOINT !== undefined
        ? ["daemon.relay.publicEndpoint"]
        : []),
      ...(this.env.PASEO_RELAY_PUBLIC_USE_TLS !== undefined ? ["daemon.relay.publicUseTls"] : []),
    ];
    this.lastKnownPersisted = this.startupPersisted;
  }

  public get(): MutableDaemonConfig {
    return this.current;
  }

  public getImageGenerationRuntimeConfig(): ImageGenerationRuntimeConfig | null {
    const publicConfig = this.current.imageGeneration;
    if (!publicConfig) return null;
    const persistedOpenAi = loadPersistedConfig(this.paseoHome, this.logger).providers?.openai;
    const apiKey =
      nonEmptyEnvironmentValue(this.env.OPENAI_API_KEY) ??
      persistedOpenAi?.image?.apiKey ??
      persistedOpenAi?.apiKey;
    return {
      ...publicConfig,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  public patch(partial: MutableDaemonConfigPatch): MutableDaemonConfig {
    const parsedPatch = pickSupportedPatchFields(MutableDaemonConfigPatchSchema.parse(partial));
    return this.applySupportedPatch(parsedPatch);
  }

  public setAgentSkillSelection(selection: AgentSkillSelection): MutableDaemonConfig {
    return this.applySupportedPatch({ skills: { selection } });
  }

  private applySupportedPatch(parsedPatch: SupportedMutableConfigPatch): MutableDaemonConfig {
    if (parsedPatch.relay?.enabled !== undefined && !this.relayEnabledMutable) {
      throw new Error(
        "Relay is controlled by a daemon launch override. Remove PASEO_RELAY_ENABLED or the relay CLI flag before changing it here.",
      );
    }
    if (parsedPatch.relay) {
      parsedPatch = { ...parsedPatch, relay: this.normalizeRelayPatch(parsedPatch.relay) };
    }
    const { removeProviders = [], imageGeneration, ...configPatch } = parsedPatch;
    const removedProviders = Array.from(new Set(removeProviders));
    const merged = deepMerge(this.current, configPatch);
    const relayAddressChanged =
      parsedPatch.relay !== undefined &&
      Object.keys(parsedPatch.relay).some((field) => field !== "enabled");
    if (relayAddressChanged) {
      merged.relay = applyRelayAddressDefaults(
        merged.relay!,
        parsedPatch.relay!,
        this.lastKnownPersisted.daemon?.relay,
        this.env,
      );
    }
    if (imageGeneration !== undefined) {
      merged.imageGeneration = applyImageGenerationPatchToPublicConfig(
        this.current.imageGeneration,
        imageGeneration,
        this.env,
      );
    }
    if (parsedPatch.skills?.selection !== undefined) {
      merged.skills = { selection: parsedPatch.skills.selection };
    }
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitGenerationProvidersFromConfig(
        omitProvidersFromConfig(merged, removedProviders),
        removedProviders,
      ),
    );
    if (parsedPatch.providers?.omp?.params?.disabledBuiltInTools !== undefined) {
      const disabled = OmpProviderParamsSchema.shape.disabledBuiltInTools.parse(
        next.providers.omp?.params?.disabledBuiltInTools,
      );
      if (disabled) {
        ensureManagedOmpOnPath(process.platform, this.env);
        const provider = ProviderOverrideSchema.strip().parse(next.providers.omp);
        validateOmpBuiltinToolConfigSync(
          disabled,
          provider.command ?? [this.env.OMP_COMMAND?.trim() || "omp"],
          { ...this.env, ...provider.env },
        );
      }
    }

    const configChanged = !isEqualValue(this.current, next);

    if (!configChanged && removedProviders.length === 0 && !relayAddressChanged) {
      return this.current;
    }

    const { previous: persistedBeforePatch, knownNext } = this.persistConfig(
      { ...configPatch, ...(imageGeneration !== undefined ? { imageGeneration } : {}) },
      removedProviders,
    );
    if (!configChanged) {
      this.lastKnownPersisted = knownNext;
      return this.current;
    }

    try {
      this.applyReplacement(next, { removedProviders });
      this.lastKnownPersisted = knownNext;
    } catch (error) {
      savePersistedConfig(this.paseoHome, persistedBeforePatch, this.logger);
      throw error;
    }

    return this.current;
  }

  private normalizeRelayPatch(
    patch: NonNullable<SupportedMutableConfigPatch["relay"]>,
  ): NonNullable<SupportedMutableConfigPatch["relay"]> {
    const normalized = { ...patch };
    if (patch.endpoint !== undefined) {
      const address = parseRelayAddress(
        patch.endpoint,
        patch.useTls ?? this.current.relay?.useTls ?? false,
      );
      normalized.endpoint = address.endpoint;
      normalized.useTls = patch.useTls ?? address.useTls;
    }
    if (patch.publicEndpoint !== undefined) {
      const address = parseRelayAddress(
        patch.publicEndpoint,
        patch.publicUseTls ?? normalized.useTls ?? this.current.relay?.useTls ?? false,
      );
      normalized.publicEndpoint = address.endpoint;
      // A URL scheme is an explicit public TLS selection; bare authorities inherit.
      if (patch.publicUseTls !== undefined || /^wss?:\/\//iu.test(patch.publicEndpoint.trim())) {
        normalized.publicUseTls = patch.publicUseTls ?? address.useTls;
      }
    }
    for (const field of Object.keys(normalized)) {
      if (this.relayOverrideControlledPaths.includes(`daemon.relay.${field}`)) {
        throw new Error(
          `Relay ${field} is controlled by a daemon launch override. Remove its environment or CLI override before changing it here.`,
        );
      }
    }
    return normalized;
  }

  public reload(): DaemonConfigReloadResult {
    if (!this.reloadSource) {
      throw new Error("Daemon config reload is unavailable for this daemon instance");
    }

    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const resolved = this.reloadSource.resolve(persisted);
    // Plugin source changes require the plugin lifecycle operation or a daemon
    // restart. The global switch is independently reloadable.
    const desired = MutableDaemonConfigSchema.parse({
      ...resolved.mutable,
      plugins: this.current.plugins,
    });
    const changedSinceLastApply = diffPaths(this.lastKnownPersisted, persisted);
    const overrideControlledPaths = compactOwnedPaths(
      changedSinceLastApply.filter((path) =>
        resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner)),
      ),
      resolved.overrideControlledPaths,
    );
    const appliedPaths = RELOADABLE_PATHS.filter((persistedPath) => {
      if (resolved.overrideControlledPaths.some((owner) => pathBelongsTo(persistedPath, owner))) {
        return false;
      }
      const mutablePath = PERSISTED_TO_MUTABLE_PATH[persistedPath];
      return (
        mutablePath !== undefined &&
        !isEqualValue(
          getValueAtPath(this.current, mutablePath),
          getValueAtPath(desired, mutablePath),
        )
      );
    });
    const restartRequiredPaths = compactOwnedPaths(
      diffPaths(this.startupPersisted, persisted).filter((path) => {
        if (path === "$schema" || path === "version") return false;
        if (RELOADABLE_PATHS.some((owner) => pathBelongsTo(path, owner))) return false;
        return !resolved.overrideControlledPaths.some((owner) => pathBelongsTo(path, owner));
      }),
      [],
    );

    const removedProviders = Object.keys(this.current.providers).filter(
      (provider) => !(provider in desired.providers),
    );
    this.applyReplacement(desired, { removedProviders });
    this.lastKnownPersisted = persisted;

    return {
      appliedPaths: [...appliedPaths].sort(),
      restartRequiredPaths,
      overrideControlledPaths,
    };
  }

  private applyReplacement(
    next: MutableDaemonConfig,
    changeDetails: DaemonConfigChangeDetails,
  ): void {
    const changedFieldPaths = Array.from(this.fieldChangeHandlers.keys()).filter((path) => {
      return !isEqualValue(getValueAtPath(this.current, path), getValueAtPath(next, path));
    });
    if (isEqualValue(this.current, next) && changeDetails.removedProviders.length === 0) return;

    const previous = this.current;
    const appliedFieldChanges: AppliedFieldChange[] = [];
    const applyRollbacks: ConfigApplyRollback[] = [];
    this.current = next;
    try {
      for (const path of changedFieldPaths) {
        const handlers = this.fieldChangeHandlers.get(path);
        if (!handlers) {
          continue;
        }
        const value = getValueAtPath(next, path);
        const previousValue = getValueAtPath(previous, path);
        for (const handler of handlers) {
          appliedFieldChanges.push({ handler, previousValue });
          handler(value);
        }
      }
      for (const listener of this.applyListeners) {
        applyRollbacks.push(listener(next, previous, changeDetails));
      }
    } catch (error) {
      this.current = previous;
      const rollbackErrors: unknown[] = [];
      for (const rollback of applyRollbacks.toReversed()) {
        try {
          rollback();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const change of appliedFieldChanges.toReversed()) {
        try {
          change.handler(change.previousValue);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const rollbackFailure = new Error(
          "Daemon config apply failed and one or more live owners could not roll back",
          { cause: error },
        );
        Object.assign(rollbackFailure, { rollbackErrors });
        throw rollbackFailure;
      }
      throw error;
    }

    for (const listener of this.changeListeners) {
      try {
        listener(next, changeDetails);
      } catch (error) {
        this.logger?.info({ error }, "Daemon config change notification failed");
      }
    }
  }

  public onFieldChange(path: string, handler: FieldChangeHandler): () => void {
    const handlers = this.fieldChangeHandlers.get(path) ?? new Set<FieldChangeHandler>();
    handlers.add(handler);
    this.fieldChangeHandlers.set(path, handlers);

    return () => {
      const currentHandlers = this.fieldChangeHandlers.get(path);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.fieldChangeHandlers.delete(path);
      }
    };
  }

  public onChange(listener: ConfigListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  public onApply(listener: ConfigApplyListener): () => void {
    // A live owner must either throw before changing its state or return a
    // rollback that restores the previous config. Notifications belong in
    // onChange so they run only after every live owner commits.
    this.applyListeners.add(listener);
    return () => {
      this.applyListeners.delete(listener);
    };
  }

  private persistConfig(
    patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
    removeProviders: readonly string[],
  ): { previous: PersistedConfig; knownNext: PersistedConfig } {
    const persisted = loadPersistedConfig(this.paseoHome, this.logger);
    const merge = (source: PersistedConfig) =>
      mergeMutablePatchIntoPersistedConfig({
        persisted: source,
        patch,
        removeProviders,
        persistRelayEnabled: this.relayEnabledMutable,
      });
    const nextPersisted = merge(persisted);
    const knownNext = merge(this.lastKnownPersisted);
    savePersistedConfig(this.paseoHome, nextPersisted, this.logger);
    return { previous: persisted, knownNext };
  }
}

function mergeMutablePatchIntoPersistedConfig(params: {
  persisted: PersistedConfig;
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">;
  removeProviders: readonly string[];
  persistRelayEnabled: boolean;
}): PersistedConfig {
  const { persisted, patch, removeProviders, persistRelayEnabled } = params;
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  const providers = mergeMutableImageGenerationPatch(persisted.providers, patch.imageGeneration);
  return {
    ...persisted,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(providers ? { providers } : { providers: undefined }),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
  } as PersistedConfig;
}

function mergeMutableImageGenerationPatch(
  persistedProviders: PersistedConfig["providers"],
  patch: MutableDaemonConfigPatch["imageGeneration"],
): PersistedConfig["providers"] {
  if (patch === undefined) return persistedProviders;

  const image = { ...persistedProviders?.openai?.image };
  if (patch.enabled !== undefined) image.enabled = patch.enabled;
  if (patch.backend !== undefined) image.backend = patch.backend;
  if (patch.model !== undefined) image.model = patch.model;
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null) delete image.baseUrl;
    else image.baseUrl = normalizeImageGenerationBaseUrl(patch.baseUrl);
  }
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === null) delete image.apiKey;
    else image.apiKey = patch.apiKey;
  }
  if (patch.subscriptionCredentialId !== undefined) {
    if (patch.subscriptionCredentialId === null) delete image.subscriptionCredentialId;
    else image.subscriptionCredentialId = patch.subscriptionCredentialId;
  }

  return {
    ...persistedProviders,
    openai: {
      ...persistedProviders?.openai,
      image,
    },
  };
}

function applyMutableQuickAskPatch(
  next: Record<string, unknown>,
  persistedAgents: PersistedConfig["agents"],
  patch: MutableDaemonConfigPatch["quickAsk"],
  removeProviders: readonly string[],
): void {
  if (patch !== undefined) {
    next["quickAsk"] = { ...persistedAgents?.quickAsk, ...patch };
  } else if (removeProviders.length > 0 && persistedAgents?.quickAsk) {
    next["quickAsk"] = omitGenerationProvidersFromConfig(
      { quickAsk: persistedAgents.quickAsk },
      removeProviders,
    ).quickAsk;
  }
}

function mergeMutableAgentPatch(
  persistedAgents: PersistedConfig["agents"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  removeProviders: readonly string[],
): PersistedConfig["agents"] {
  if (
    patch.providers === undefined &&
    patch.metadataGeneration === undefined &&
    patch.quickAsk === undefined &&
    patch.skills === undefined &&
    removeProviders.length === 0
  ) {
    return persistedAgents;
  }

  const next = { ...persistedAgents } as Record<string, unknown>;
  const persistedProviderOverrides = omitProvidersFromOverrides(
    persistedAgents?.providers as Record<string, ProviderOverride> | undefined,
    removeProviders,
  );
  const providerOverrides = applyMutableProviderConfigToOverrides(
    persistedProviderOverrides,
    patch.providers,
  );
  if (providerOverrides) next["providers"] = providerOverrides;
  else delete next["providers"];

  if (patch.metadataGeneration !== undefined) {
    next["metadataGeneration"] = {
      ...persistedAgents?.metadataGeneration,
      ...patch.metadataGeneration,
    };
  } else if (removeProviders.length > 0 && persistedAgents?.metadataGeneration) {
    next["metadataGeneration"] = omitGenerationProvidersFromConfig(
      { metadataGeneration: persistedAgents.metadataGeneration },
      removeProviders,
    ).metadataGeneration;
  }

  applyMutableQuickAskPatch(next, persistedAgents, patch.quickAsk, removeProviders);

  if (patch.skills?.selection !== undefined) {
    next["skills"] = { selection: patch.skills.selection };
  }

  return Object.keys(next).length > 0 ? (next as PersistedConfig["agents"]) : undefined;
}

function mergeMutableDaemonPatch(
  persistedDaemon: PersistedConfig["daemon"],
  patch: Omit<SupportedMutableConfigPatch, "removeProviders">,
  persistRelayEnabled: boolean,
): PersistedConfig["daemon"] {
  const next = { ...persistedDaemon } as NonNullable<PersistedConfig["daemon"]>;
  if (persistRelayEnabled && patch.relay?.enabled !== undefined) {
    next.relay = { ...next.relay, enabled: patch.relay.enabled };
  }
  if (patch.relay) {
    const { enabled: _enabled, ...address } = patch.relay;
    if (Object.keys(address).length > 0) next.relay = { ...next.relay, ...address };
  }
  if (patch.mcp?.injectIntoAgents !== undefined) {
    next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  }
  if (patch.mcp?.toolCapabilities !== undefined) {
    next.mcp = {
      ...next.mcp,
      toolCapabilities: {
        ...next.mcp?.toolCapabilities,
        ...patch.mcp.toolCapabilities,
      },
    };
  }
  if (patch.autoArchiveAfterMerge !== undefined) {
    next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  }
  if (patch.enableTerminalAgentHooks !== undefined) {
    next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  }
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  if (patch.ompProviderAccountNotes !== undefined) {
    next.ompProviderAccountNotes = patch.ompProviderAccountNotes;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
