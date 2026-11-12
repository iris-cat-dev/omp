import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveOmpRuntimeHelperPath } from "./sdk-host-command.js";
import { z } from "zod";
import {
  BackgroundProcessSchema,
  BackgroundProcessOutputSchema,
  type BackgroundProcess,
  type BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";
import {
  RuntimeResourceSchema,
  type RuntimeResource,
} from "@omp-desktop/protocol/runtime-resources";
import {
  AgentPromptContextSchema,
  type AgentPromptContext,
} from "@omp-desktop/protocol/prompt-context";
import type { Logger } from "pino";
import type { PluginAgentPromptSelection } from "@omp-desktop/plugin/server";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { ProxyPolicySchema, type ProxyPolicy } from "@omp-desktop/protocol/provider-config";
import {
  JSONL_RPC_DEFAULT_TIMEOUT_MS,
  JsonlRpcProcess,
  JSONL_RPC_NO_TIMEOUT,
  supportsJsonlRpcProtocolV2,
} from "../jsonl-rpc-process.js";
import {
  buildOmpLaunch,
  resolveOmpRuntimeCommand,
  type OmpRuntime,
  type OmpRuntimeLaunch,
  type OmpRuntimeSession,
  type OmpRuntimeRetirement,
  type OmpStartSessionInput,
  type OmpUserMessageOptions,
  type OmpBranchMessage,
} from "./runtime.js";
import { resolveOmpBuiltinToolArgsForLaunch } from "./provider-config.js";
import { LOCAL_MODEL_PROVIDER } from "@omp-desktop/protocol/local-models";
import type { LocalModelBridge } from "../../../local-model-bridge.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import {
  prepareOmpImageSettingsLaunch,
  OMP_IMAGE_SETTINGS_TOKEN_ENV,
  type OmpImageSettingsGetter,
} from "./image-settings.js";
import {
  OmpAbortAndRestoreQueueResultSchema,
  type OmpAbortAndRestoreQueueResult,
  OmpBranchMessagesResultSchema,
  OmpApprovalModeSchema,
  type OmpApprovalMode,
  OmpBranchResultSchema,
  OmpCommandsResultSchema,
  OmpFastModeResultSchema,
  OmpHostToolsResultSchema,
  OmpLoginProvidersResultSchema,
  OmpMessagesResultSchema,
  OmpSessionAnnotationResultSchema,
  OmpModelSchema,
  OmpModelsResultSchema,
  OmpNativeServiceTierSnapshotSchema,
  OmpPromptAckSchema,
  OmpRpcCommandSchema,
  OmpRuntimeEventSchema,
  OmpSessionStateSchema,
  OmpSessionStatsSchema,
  type OmpThinkingLevel,
  type OmpFastModeResult,
  type OmpFastModeSelection,
  type OmpAgentMessage,
  type OmpLoginProvider,
  type OmpExtensionUiResponse,
  type OmpModel,
  type OmpPromptAck,
  type OmpRpcCommand,
  type OmpRpcHostToolDefinition,
  type OmpRpcHostToolResult,
  type OmpRpcHostToolUpdate,
  type OmpRpcSlashCommand,
  type OmpRuntimeEvent,
  type OmpSessionState,
  type OmpSessionStats,
  type OmpSubagentSubscriptionLevel,
} from "./rpc-types.js";
import {
  OmpSubagentsResultSchema,
  OmpSubagentMessagesSelectorSchema,
  OmpSubagentRpcCommandSchema,
  parseOmpSubagentMessagesResult,
  type OmpSubagentSnapshot,
  type OmpSubagentMessagesSelector,
  type OmpSubagentMessagesResult,
} from "./subagent-rpc.js";

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const DEFAULT_COMMANDS_RPC_NAME = "get_available_commands";
/** Allow cold OMP starts the same 30-second budget as other control-plane RPCs. */
const OMP_READY_TIMEOUT_MS = JSONL_RPC_DEFAULT_TIMEOUT_MS;
const OMP_CODEX_CATALOG_PRELOAD_URL_ENV = "OMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL";
export const OMP_SERVICE_TIER_TOKEN_ENV = "OMP_DESKTOP_SERVICE_TIER_TOKEN";
const OMP_SERVICE_TIER_TIMEOUT_MS = 5_000;
const OMP_BACKGROUND_JOBS_COMMAND_PATTERN = /^desktop-background-jobs-[0-9a-f-]+$/;
const OMP_CODEX_CATALOG_PRELOAD_BRIDGE =
  "data:text/javascript,await%20import(process%2Eenv%2EOMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL)";
const OmpToolInventorySchema = z.object({
  dumpTools: z.array(z.object({ name: z.string() })),
});

interface BackgroundJobsEndpoint {
  port: number;
  token: string;
  generation: number;
}

type BackgroundJobsBridge =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "ready"; endpoint: BackgroundJobsEndpoint }
  | { status: "dead" };

export function resolveOmpBackgroundJobsExtensionPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  return resolveOmpRuntimeHelperPath("background-jobs-extension", moduleUrl, pathExists);
}

export function resolveOmpImageSettingsExtensionPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  return resolveOmpRuntimeHelperPath("image-settings-extension", moduleUrl, pathExists);
}

export function resolveOmpServiceTierExtensionPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  return resolveOmpRuntimeHelperPath("service-tier-extension", moduleUrl, pathExists);
}

export function hasOmpUltrafastCommand(commands: readonly OmpRpcSlashCommand[]): boolean {
  return commands.some(
    (command) =>
      command.name === "fast" &&
      command.source === "builtin" &&
      (command.subcommands?.some((subcommand) => subcommand.name === "ultra") === true ||
        /\bultra\b/.test(command.input?.hint ?? "")),
  );
}

export function resolveOmpCodexCatalogPreloadPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  return resolveOmpRuntimeHelperPath("codex-catalog-preload", moduleUrl, pathExists);
}

function installCodexCatalogPreload(launch: OmpRuntimeLaunch): void {
  const bunOptions = (launch.env?.BUN_OPTIONS ?? globalThis.process.env.BUN_OPTIONS)?.trim();
  // Bun tokenizes BUN_OPTIONS on whitespace and treats shell quotes and backslashes literally.
  // Keep the option whitespace-free and carry the encoded absolute path in a separate env value.
  launch.env = {
    ...launch.env,
    BUN_OPTIONS: `${bunOptions ? `${bunOptions} ` : ""}--preload=${OMP_CODEX_CATALOG_PRELOAD_BRIDGE}`,
    [OMP_CODEX_CATALOG_PRELOAD_URL_ENV]: pathToFileURL(resolveOmpCodexCatalogPreloadPath()).href,
  };
}

export class OmpReadyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `OMP did not become ready within ${timeoutMs / 1_000} seconds. Retry the operation; if it keeps failing, restart OMP.`,
    );
    this.name = "OmpReadyTimeoutError";
  }
}

export interface OmpCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  localModelBridge?: LocalModelBridge;
  disabledBuiltInTools?: readonly string[];
  command?: [string, ...string[]];
  commandsRpcName?: "get_available_commands";
  spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;
}

export class OmpCliRuntime implements OmpRuntime {
  private readonly command: [string, ...string[]];
  private readonly commandsRpcName: "get_available_commands";
  private readonly spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: OmpCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_OMP_COMMAND;
    this.commandsRpcName = options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME;
    this.spawnProcess = options.spawnProcess;
  }

  private async applyBuiltInToolPolicy(
    launch: OmpRuntimeLaunch,
    command: ReturnType<typeof resolveOmpRuntimeCommand>,
    onRetirementCreated?: (retirement: OmpRuntimeRetirement) => void,
  ): Promise<void> {
    const disabledBuiltInTools = this.options.disabledBuiltInTools;
    if (!disabledBuiltInTools?.length) return;
    if (
      launch.argv.slice(command.length).some((arg) => /^(?:--tools(?:=.*)?|--no-tools)$/.test(arg))
    ) {
      throw new Error(
        "OMP built-in tool settings conflict with a configured --tools or --no-tools argument. Remove the custom tool flag first.",
      );
    }
    let policyArgs = await resolveOmpBuiltinToolArgsForLaunch(disabledBuiltInTools, command, {
      ...globalThis.process.env,
      ...launch.env,
    });
    if (policyArgs[0] === "--tools") {
      // Validate the actual registry: equal versions can expose different tools.
      const available = await inspectOmpActiveTools(
        launch,
        this.options.logger,
        onRetirementCreated,
      );
      if (!disabledBuiltInTools.some((name) => available.has(name))) {
        policyArgs = [];
      } else {
        const enabled = policyArgs[1]!.split(",").filter((name) => available.has(name));
        // Preserve a settings-gated image tool newer than the static manifest.
        if (
          available.has("generate_image") &&
          !disabledBuiltInTools.includes("generate_image") &&
          !enabled.includes("generate_image")
        ) {
          enabled.push("generate_image");
        }
        policyArgs = enabled.length ? ["--tools", enabled.join(",")] : ["--no-tools"];
      }
    }
    launch.argv.push(...policyArgs);
  }


  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    input.signal?.throwIfAborted();
    const preparationStartedAt = performance.now();
    const launch = buildOmpLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    const { bridge, enabled: localModelsEnabled } = await prepareOmpLocalModelsLaunch(
      launch,
      input,
      this.options.localModelBridge,
    );
    const effectiveCommand = resolveOmpRuntimeCommand(this.command, this.options.runtimeSettings);
    installCodexCatalogPreload(launch);
    const serviceTierToken = randomUUID();
    launch.env = { ...launch.env, [OMP_SERVICE_TIER_TOKEN_ENV]: serviceTierToken };
    launch.argv.push("--extension", resolveOmpServiceTierExtensionPath());
    const imageLaunch = input.getImageGenerationConfig
      ? await prepareOmpImageSettingsLaunch(effectiveCommand, launch.cwd, {
          ...globalThis.process.env,
          ...launch.env,
        })
      : undefined;
    if (imageLaunch) {
      launch.argv.push("--config", imageLaunch.configPath);
      launch.env = { ...launch.env, [OMP_IMAGE_SETTINGS_TOKEN_ENV]: imageLaunch.token };
    }
    try {
      if (!input.localModelGateway)
        await this.applyBuiltInToolPolicy(launch, effectiveCommand, input.onRetirementCreated);
      if (input.protocolMode === "rpc-ui") {
        launch.argv.push("--extension", resolveOmpBackgroundJobsExtensionPath());
      }
      if (imageLaunch) launch.argv.push("--extension", resolveOmpImageSettingsExtensionPath());
      const imageToolAllowed = imageToolAllowedByArguments(launch.argv);
      input.signal?.throwIfAborted();
      input.onActivity?.("prepareMs", performance.now() - preparationStartedAt);
      const startStartedAt = performance.now();
      const session = await startOmpRpcSession({
        launch,
        logger: this.options.logger,
        commandsRpcName: this.commandsRpcName,
        spawnProcess: this.spawnProcess,
        signal: input.signal,
        onRetirementCreated: input.onRetirementCreated,
        getImageGenerationConfig: input.getImageGenerationConfig,
        imageSettingsToken: imageLaunch?.token,
        imageToolAllowed,
        localModelBridge: bridge,
        localModelsEnabled: localModelsEnabled && !launch.env?.OMP_DESKTOP_SANDBOX_MODEL_BRIDGE,
        serviceTierToken,
        cleanup: imageLaunch?.cleanup,
      });
      input.onActivity?.("startMs", performance.now() - startStartedAt);
      const proxyPolicy = input.proxyPolicy ?? this.options.runtimeSettings?.proxyPolicy;
      if (proxyPolicy) {
        try {
          await session.setProxyPolicy(proxyPolicy);
        } catch (error) {
          await session.close();
          throw error;
        }
      }
      return session;
    } catch (error) {
      await imageLaunch?.cleanup();
      throw error;
    }
  }
}
export async function prepareOmpLocalModelsLaunch(
  launch: OmpRuntimeLaunch,
  input: OmpStartSessionInput,
  configuredBridge?: LocalModelBridge,
): Promise<{ bridge: LocalModelBridge | undefined; enabled: boolean }> {
  const bridge = input.localModelGateway ? undefined : configuredBridge;
  const enabled = bridge?.isEnabled() === true;
  if (enabled) {
    const configuration = await bridge!.getLaunchConfig();
    if (!configuration)
      throw new Error("Local model source is disconnected. Reconnect OMP Desktop.");
    const requested = input.model?.startsWith(`${LOCAL_MODEL_PROVIDER}/`)
      ? input.model.slice(LOCAL_MODEL_PROVIDER.length + 1)
      : input.model;
    const restoreSandboxModel = input.sandbox && input.session && !requested;
    const selected = requested
      ? configuration.models.find((model) => `${model.provider}/${model.id}` === requested)
      : restoreSandboxModel ? undefined : configuration.models[0];
    if (!selected && !restoreSandboxModel) throw new Error("Select an available model from this Desktop.");
    const preserveIdentity = input.sandbox && !input.model?.startsWith(`${LOCAL_MODEL_PROVIDER}/`);
    if (selected) {
      const reference = preserveIdentity
        ? `${selected.provider}/${selected.id}`
        : `${LOCAL_MODEL_PROVIDER}/${selected.provider}/${selected.id}`;
      // An explicit source selector wins; sandbox resume without one restores its own saved selection.
      launch.argv.push("--model", reference);
      launch.model = reference;
    }
    launch.argv.push(
      "--extension",
      resolveOmpRuntimeHelperPath(preserveIdentity ? "sandbox-models-extension" : "local-models-extension", import.meta.url),
    );
    launch.env = {
      ...launch.env,
      ...(preserveIdentity
        ? { OMP_DESKTOP_SANDBOX_MODEL_BRIDGE: JSON.stringify({ baseUrl: configuration.baseUrl, token: configuration.token }) }
        : { OMP_DESKTOP_LOCAL_MODEL_BRIDGE: JSON.stringify({
            baseUrl: configuration.baseUrl,
            token: configuration.token,
          }) }),
    };
  } else if (!input.localModelGateway && input.model?.startsWith(`${LOCAL_MODEL_PROVIDER}/`)) {
    throw new Error("Local model source is disconnected. Reconnect OMP Desktop.");
  }
  return { bridge, enabled };
}

export interface OmpRpcSessionOptions {
  launch: OmpRuntimeLaunch;
  logger: Logger;
  commandsRpcName?: "get_available_commands";
  /** SDK hosts must enable grouped ask before exposing a usable session. */
  enableAskDialog?: boolean;
  spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;
  signal?: AbortSignal;
  onRetirementCreated?: (retirement: OmpRuntimeRetirement) => void;
  getImageGenerationConfig?: OmpImageSettingsGetter;
  imageSettingsToken?: string;
  imageToolAllowed?: boolean;
  localModelBridge?: LocalModelBridge;
  localModelsEnabled?: boolean;
  serviceTierToken?: string;
  cleanup?: () => Promise<void>;
}

/** Shared transport, validation and UI protocol for CLI and isolated Node SDK hosts. */
export async function startOmpRpcSession(
  options: OmpRpcSessionOptions,
): Promise<OmpRuntimeSession> {
  options.signal?.throwIfAborted();
  const { launch, logger, spawnProcess } = options;
  const [command, ...args] = launch.argv;
  const process = new JsonlRpcProcess({
    launch: { command, args, cwd: launch.cwd, env: launch.env },
    logger,
    diagnosticName: "OMP RPC",
    ...(spawnProcess ? { spawn: () => spawnProcess(launch) } : {}),
  });
  const session = new OmpCliRuntimeSession(
    process,
    options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME,
    options.getImageGenerationConfig,
    options.imageSettingsToken,
    options.imageToolAllowed ?? true,
    options.localModelBridge,
    options.localModelsEnabled ?? false,
    options.serviceTierToken,
  );
  if (options.cleanup) {
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= options.cleanup!();
    const close = session.close.bind(session);
    session.close = async () => {
      try { await close(); }
      finally { await cleanup(); }
    };
    process.onExit(() => {
      void cleanup().catch((error: unknown) => {
        logger.warn({ error }, "Could not remove private OMP session overlay");
      });
    });
  }
  const abort = () => void process.close(options.signal?.reason).catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.onRetirementCreated?.(session);
    await negotiateOmpProtocolV2(process, logger);
    options.signal?.throwIfAborted();
    if (options.enableAskDialog) {
      const response = (await process.request(
        { type: "set_ask_dialog", enabled: true },
        JSONL_RPC_DEFAULT_TIMEOUT_MS,
      )) as { enabled?: unknown } | undefined;
      if (response?.enabled !== true) {
        throw new Error("OMP did not enable grouped ask dialogs");
      }
      options.signal?.throwIfAborted();
    }
    await session.refreshImageSettings();
    return session;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    await process.close(failure);
    throw failure;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Wait for OMP to advertise readiness and negotiate RPC protocol v2 when it is
 * supported. OMP caps protocol-v1 single-line frames at 1 MiB; `get_available_models`
 * (and other large payloads) can exceed that and are returned as an overflow error.
 * Protocol v2 lifts the ceiling to 64 MiB by chunking oversized frames, which the
 * JSONL transport reassembles. Supported OMP versions send a `ready` frame immediately
 * after launch; startup fails if the process exits or never becomes ready.
 */
async function negotiateOmpProtocolV2(process: JsonlRpcProcess, logger: Logger): Promise<void> {
  const ready = await waitForOmpReadyFrame(process);
  if (!supportsJsonlRpcProtocolV2(ready)) {
    return;
  }
  const response = (await process.request(
    { type: "negotiate_protocol", protocolVersion: 2 },
    JSONL_RPC_DEFAULT_TIMEOUT_MS,
  )) as { protocolVersion?: unknown } | undefined;
  if (response?.protocolVersion !== 2) {
    throw new Error("OMP did not accept RPC protocol v2");
  }
  logger.debug({}, "Negotiated OMP RPC protocol v2 (chunked frame transport)");
}

function waitForOmpReadyFrame(process: JsonlRpcProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeMessage = (): void => {};
    let unsubscribeExit = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Record<string, unknown> | Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribeMessage();
      unsubscribeExit();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    unsubscribeMessage = process.onMessage((message) => {
      if (message.type === "ready") {
        finish(message);
      }
    });
    unsubscribeExit = process.onExit(({ error }) => finish(error));
    timer = setTimeout(
      () => finish(new OmpReadyTimeoutError(OMP_READY_TIMEOUT_MS)),
      OMP_READY_TIMEOUT_MS,
    );
  });
}

async function inspectOmpActiveTools(
  launch: OmpRuntimeLaunch,
  logger: Logger,
  onRetirementCreated?: (retirement: OmpRuntimeRetirement) => void,
): Promise<Set<string>> {
  const probeArgv = [...launch.argv];
  const sessionIndex = probeArgv.indexOf("--session");
  if (sessionIndex >= 0) probeArgv.splice(sessionIndex, 2);
  if (!probeArgv.includes("--no-session")) probeArgv.push("--no-session");
  const [command, ...args] = probeArgv;
  const process = new JsonlRpcProcess({
    launch: { command, args, cwd: launch.cwd, env: launch.env },
    logger,
    diagnosticName: "OMP tool inventory",
  });
  try {
    onRetirementCreated?.(process);
    const response = await process.request({ type: "get_state" }, OMP_READY_TIMEOUT_MS);
    const inventory = OmpToolInventorySchema.safeParse(response);
    if (!inventory.success) {
      throw new Error("OMP get_state did not return a tool inventory");
    }
    return new Set(inventory.data.dumpTools.map((tool) => tool.name));
  } finally {
    await process.close();
  }
}

function imageToolAllowedByArguments(argv: readonly string[]): boolean {
  const toolFlag = argv.findLastIndex(
    (arg) => arg === "--tools" || arg.startsWith("--tools=") || arg === "--no-tools",
  );
  return (
    toolFlag < 0 ||
    (argv[toolFlag] !== "--no-tools" &&
      (argv[toolFlag] === "--tools" ? argv[toolFlag + 1] : argv[toolFlag]!.slice("--tools=".length))
        ?.split(",")
        .includes("generate_image") === true)
  );
}

class OmpCliRuntimeSession implements OmpRuntimeSession {
  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  activeBranchEntryId?: string;
  private backgroundJobsBridge: BackgroundJobsBridge = { status: "pending" };
  private backgroundJobsGeneration = -1;
  private backgroundJobsRecoveryCommand: string | undefined;
  private backgroundJobsRecovery: Promise<BackgroundJobsEndpoint> | undefined;
  private readonly imageEndpoint = Promise.withResolvers<number>();
  private readonly processExit = new AbortController();
  private imageEndpointPort: number | undefined;
  private appliedImageSettings: string | undefined;
  private imageUpdates = Promise.resolve();
  private readonly localModelGatewayEndpoint = Promise.withResolvers<number | Error>();
  private inputGeneration = 0;
  private serviceTierEndpointPort: number | undefined;
  private ultrafastCommand: Promise<boolean> | undefined;
  private modelControls = Promise.resolve();

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
    private readonly getImageGenerationConfig?: OmpImageSettingsGetter,
    private readonly imageToken?: string,
    private readonly imageToolAllowed = true,
    private readonly localModelBridge?: LocalModelBridge,
    private readonly usesLocalModels = false,
    private readonly serviceTierToken?: string,
  ) {
    process.onMessage((message) => {
      if (message.type === "desktop_service_tier_ready") {
        const endpoint = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (endpoint.success) this.serviceTierEndpointPort = endpoint.data.port;
        return;
      }
      if (message.type === "desktop_local_model_gateway_ready") {
        const endpoint = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (endpoint.success) this.localModelGatewayEndpoint.resolve(endpoint.data.port);
        return;
      }
      if (message.type === "desktop_image_settings_ready") {
        const endpoint = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (endpoint.success && !this.processExit.signal.aborted) {
          this.imageEndpointPort = endpoint.data.port;
          this.appliedImageSettings = undefined;
          this.imageEndpoint.resolve(endpoint.data.port);
        }
        return;
      }
      if (message.type === "desktop_background_jobs_ready") {
        const endpoint = z
          .object({
            port: z.number().int().min(1).max(65535),
            token: z.string().min(1),
            generation: z.number().int().positive(),
            recoveryCommand: z.string().regex(OMP_BACKGROUND_JOBS_COMMAND_PATTERN),
          })
          .safeParse(message);
        if (
          endpoint.success &&
          this.backgroundJobsBridge.status !== "dead" &&
          endpoint.data.generation > this.backgroundJobsGeneration
        ) {
          this.backgroundJobsGeneration = endpoint.data.generation;
          this.backgroundJobsRecoveryCommand = endpoint.data.recoveryCommand;
          this.backgroundJobsBridge = { status: "ready", endpoint: endpoint.data };
        }
        return;
      }
      if (message.type === "desktop_background_jobs_invalidated") {
        const frame = z.object({ generation: z.number().int().nonnegative() }).safeParse(message);
        if (
          frame.success &&
          this.backgroundJobsBridge.status !== "dead" &&
          frame.data.generation >= this.backgroundJobsGeneration
        ) {
          this.backgroundJobsGeneration = frame.data.generation;
          this.backgroundJobsBridge = { status: "unavailable" };
        }
        return;
      }
      const event = OmpRuntimeEventSchema.safeParse(message);
      if (event.success) {
        this.emit(event.data);
      }
    });
    process.onExit(({ error }) => {
      this.backgroundJobsBridge = { status: "dead" };
      this.backgroundJobsRecoveryCommand = undefined;
      this.serviceTierEndpointPort = undefined;
      this.imageEndpointPort = undefined;
      this.appliedImageSettings = undefined;
      this.localModelGatewayEndpoint.resolve(new Error("The local OMP model worker stopped"));
      this.processExit.abort(error);
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  async getLocalModelGatewayPort(): Promise<number> {
    const endpoint = await withTimeout(
      this.localModelGatewayEndpoint.promise,
      OMP_READY_TIMEOUT_MS,
      "Local models require an OMP version with native model gateway support. Update local OMP.",
    );
    if (endpoint instanceof Error) throw endpoint;
    return endpoint;
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private async applyImageSettings(
    config: ReturnType<OmpImageSettingsGetter>,
    encoded: string,
  ): Promise<void> {
    this.processExit.signal.throwIfAborted();
    if (
      encoded === this.appliedImageSettings &&
      !(config?.enabled && this.imageToolAllowed && config.backend === "chatgpt-subscription")
    )
      return;
    const signal = AbortSignal.any([
      AbortSignal.timeout(OMP_READY_TIMEOUT_MS),
      this.processExit.signal,
    ]);
    const aborted = Promise.withResolvers<never>();
    const onAbort = () =>
      aborted.reject(
        this.processExit.signal.aborted
          ? this.processExit.signal.reason
          : new Error(
              "OMP native image settings bridge did not become available; update OMP to v18.8.7 or newer",
            ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const readyPort = await Promise.race([this.imageEndpoint.promise, aborted.promise]);
      signal.throwIfAborted();
      const port = this.imageEndpointPort ?? readyPort;
      const response = await fetch(`http://127.0.0.1:${port}/settings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.imageToken}`,
          "Content-Type": "application/json",
        },
        body: encoded,
        signal,
      });
      if (!response.ok) {
        const result = z.object({ error: z.string() }).safeParse(await response.json());
        throw new Error(
          result.success ? result.data.error : "OMP native image settings update failed",
        );
      }
      signal.throwIfAborted();
      this.appliedImageSettings = encoded;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async refreshImageSettings(): Promise<void> {
    this.processExit.signal.throwIfAborted();
    if (!this.getImageGenerationConfig || !this.imageToken) return;
    const config = this.getImageGenerationConfig();
    const encoded = JSON.stringify({ config, allowed: this.imageToolAllowed });
    const update = this.imageUpdates.then(() => this.applyImageSettings(config, encoded));
    this.imageUpdates = update.catch(() => undefined);
    await update;
  }

  private assertModelSource(): void {
    if (this.localModelBridge && this.localModelBridge.isEnabled() !== this.usesLocalModels) {
      throw new Error("The model source changed. Restart this agent before continuing.");
    }
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): Promise<OmpPromptAck> {
    this.assertModelSource();
    const generation = this.inputGeneration;
    await this.refreshImageSettings();
    this.assertInputGeneration(generation);
    // Admission waits for compaction, input hooks, and image preparation. It is
    // not a short control-plane RPC; a timeout cannot withdraw the pending input.
    const { id: requestId, promise } = this.process.startRequest(
      {
        type: "prompt",
        message,
        ...(images?.length ? { images } : {}),
        ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
        // Steering admits queued input even while the preceding run is streaming.
        streamingBehavior: "steer",
      },
      JSONL_RPC_NO_TIMEOUT,
    );
    const ack = OmpPromptAckSchema.parse(await promise) ?? {};
    return { requestId, ...ack };
  }

  async compact(customInstructions?: string): Promise<void> {
    this.assertModelSource();
    await this.request(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      JSONL_RPC_NO_TIMEOUT,
    );
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async abortAndRestoreQueue(): Promise<OmpAbortAndRestoreQueueResult> {
    this.inputGeneration++;
    return OmpAbortAndRestoreQueueResultSchema.parse(
      await this.request({ type: "abort_and_restore_queue" }, JSONL_RPC_NO_TIMEOUT),
    );
  }

  async cancelSubagent(subagentId: string): Promise<boolean> {
    let result: unknown;
    try {
      result = await this.request({ type: "cancel_subagent", subagentId });
    } catch (error) {
      throw new Error(
        `Unable to stop OMP subagent ${subagentId}; update OMP to v18.4.9 or newer if cancel_subagent is unsupported: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return z.object({ cancelled: z.boolean() }).parse(result).cancelled;
  }

  async getState(): Promise<OmpSessionState> {
    return this.runModelControl(async () => {
      const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
      if (!this.serviceTierEndpointPort) return state;
      const native = await this.requestServiceTier();
      if (native.model?.provider !== state.model?.provider || native.model?.id !== state.model?.id)
        throw new Error("OMP model changed during service tier readback");
      return {
        ...state,
        ...(native.available && native.openaiFamily ? { fastModeTier: native.tier } : {}),
        ultrafastSupported:
          native.ultrafastAvailable &&
          state.model?.serviceTiers?.includes("ultrafast") === true &&
          (await this.supportsUltrafastCommand()),
      };
    });
  }

  async getPromptContext(): Promise<AgentPromptContext> {
    return AgentPromptContextSchema.parse(await this.request({ type: "get_prompt_context" }));
  }

  async getRuntimeResources(): Promise<RuntimeResource[]> {
    const result = await this.request({ type: "get_runtime_resources" });
    return z.object({ resources: z.array(RuntimeResourceSchema) }).parse(result).resources;
  }

  async releaseRuntimeResource(resourceId: string): Promise<void> {
    const result = await this.request({ type: "release_runtime_resource", resourceId });
    z.object({ released: z.literal(true) }).parse(result);
  }

  async setApprovalMode(mode: OmpApprovalMode): Promise<OmpApprovalMode> {
    const result = await this.request({ type: "set_approval_mode", mode });
    return z.object({ mode: OmpApprovalModeSchema }).parse(result).mode;
  }

  async listBackgroundJobs(): Promise<BackgroundProcess[]> {
    const payload = await this.requestBackgroundJobs("/list");
    return z.object({ processes: z.array(BackgroundProcessSchema) }).parse(payload).processes;
  }

  async getBackgroundJobOutput(
    processId: string,
    cursor?: number,
  ): Promise<BackgroundProcessOutput> {
    const query = new URLSearchParams({ id: processId });
    if (cursor !== undefined) query.set("cursor", String(cursor));
    return BackgroundProcessOutputSchema.parse(
      await this.requestBackgroundJobs(`/output?${query}`),
    );
  }
  async stopBackgroundJob(processId: string): Promise<boolean> {
    const query = new URLSearchParams({ id: processId });
    const payload = await this.requestBackgroundJobs(`/stop?${query}`, { method: "POST" });
    return z.object({ stopped: z.boolean() }).parse(payload).stopped;
  }

  async stopAllBackgroundJobs(): Promise<number> {
    const payload = await this.requestBackgroundJobs("/stop-all", { method: "POST" });
    return z.object({ stopped: z.number().int().nonnegative() }).parse(payload).stopped;
  }

  private async recoverBackgroundJobs(): Promise<BackgroundJobsEndpoint> {
    if (this.backgroundJobsBridge.status === "dead")
      throw new Error("OMP background-process runtime has exited");
    if (this.backgroundJobsRecovery) return this.backgroundJobsRecovery;
    const recovery = (async () => {
      let name = this.backgroundJobsRecoveryCommand;
      const commands =
        OmpCommandsResultSchema.parse(await this.request({ type: this.commandsRpcName }))
          .commands ?? [];
      if (
        !name ||
        !commands.some((command) => command.name === name && command.source === "extension")
      ) {
        name = commands.find(
          (command) =>
            command.source === "extension" &&
            OMP_BACKGROUND_JOBS_COMMAND_PATTERN.test(command.name),
        )?.name;
      }
      if (
        !name ||
        !commands.some((command) => command.name === name && command.source === "extension")
      )
        throw new Error("OMP background-process bridge is not ready or recovery is unavailable");
      // Command-only RPC never falls back to model input if an extension was
      // removed between command discovery and execution.
      z.object({ executed: z.literal(true) }).parse(
        await this.request({ type: "execute_extension_command", name }),
      );
      if (this.backgroundJobsBridge.status !== "ready")
        throw new Error("OMP background-process bridge recovery did not advertise readiness");
      return this.backgroundJobsBridge.endpoint;
    })();
    this.backgroundJobsRecovery = recovery;
    try {
      return await recovery;
    } finally {
      this.backgroundJobsRecovery = undefined;
    }
  }

  private async fetchBackgroundJobs(
    endpoint: BackgroundJobsEndpoint,
    path: string,
    init?: { method: "POST" },
  ): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(init ? 30_000 : 5_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`OMP background-process request failed (${response.status})`);
    const payload: unknown = await response.json();
    if (
      this.backgroundJobsBridge.status !== "ready" ||
      this.backgroundJobsBridge.endpoint !== endpoint
    )
      throw new Error("OMP background-process bridge changed during inventory");
    return payload;
  }

  private async requestBackgroundJobs(path: string, init?: { method: "POST" }): Promise<unknown> {
    if (this.backgroundJobsBridge.status === "dead")
      throw new Error("OMP background-process runtime has exited");
    const endpoint =
      this.backgroundJobsBridge.status === "ready"
        ? this.backgroundJobsBridge.endpoint
        : await this.recoverBackgroundJobs();
    try {
      return await this.fetchBackgroundJobs(endpoint, path, init);
    } catch (error) {
      // Do not invalidate a newer ready frame that arrived during this request.
      if (
        this.backgroundJobsBridge.status === "ready" &&
        this.backgroundJobsBridge.endpoint === endpoint
      )
        this.backgroundJobsBridge = { status: "unavailable" };
      const recovered =
        this.backgroundJobsBridge.status === "ready"
          ? this.backgroundJobsBridge.endpoint
          : await this.recoverBackgroundJobs();
      // A write may already have taken effect. Rebinding is safe, replaying a
      // stop request would conceal its unknown outcome.
      if (init) throw error;
      return this.fetchBackgroundJobs(recovered, path);
    }
  }

  async setFastMode(enabled: boolean): Promise<OmpFastModeResult> {
    return this.runModelControl(async () => {
      const result = OmpFastModeResultSchema.parse(
        await this.request({ type: "set_fast_mode", enabled }),
      );
      if (!this.serviceTierEndpointPort) return result;
      const native = await this.requestServiceTier();
      return {
        ...result,
        ...(native.available && native.openaiFamily ? { tier: native.tier } : {}),
      };
    });
  }

  async setFastModeTier(
    value: OmpFastModeSelection,
    model: { provider: string; id: string },
  ): Promise<OmpFastModeResult> {
    return this.runModelControl(async () => {
      if (!(await this.supportsUltrafastCommand())) {
        throw new Error("OMP Ultrafast requires a native /fast ultra command");
      }
      const native = await this.requestServiceTier({
        value,
        model: { provider: model.provider, id: model.id },
      });
      const selectedTier = value === "on" ? "priority" : value;
      const tier = selectedTier === "off" ? null : selectedTier;
      if (
        !native.available ||
        !native.ultrafastAvailable ||
        native.model?.provider !== model.provider ||
        native.model.id !== model.id ||
        native.tier !== tier
      )
        throw new Error("OMP did not apply the requested service tier");
      return { enabled: value !== "off", active: value !== "off", tier: native.tier };
    });
  }

  private supportsUltrafastCommand(): Promise<boolean> {
    this.ultrafastCommand ??= this.getCommands().then(hasOmpUltrafastCommand, () => false);
    return this.ultrafastCommand;
  }

  private async requestServiceTier(update?: {
    value: OmpFastModeSelection;
    model: { provider: string; id: string };
  }): Promise<z.infer<typeof OmpNativeServiceTierSnapshotSchema>> {
    const port = this.serviceTierEndpointPort;
    if (!port || !this.serviceTierToken) {
      throw new Error("OMP native service tier bridge is unavailable");
    }
    const response = await fetch(`http://127.0.0.1:${port}/tier`, {
      method: update ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${this.serviceTierToken}`,
        ...(update ? { "Content-Type": "application/json" } : {}),
      },
      ...(update ? { body: JSON.stringify(update) } : {}),
      signal: AbortSignal.timeout(OMP_SERVICE_TIER_TIMEOUT_MS),
      redirect: "error",
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(error.success ? error.data.error : "OMP service tier update failed");
    }
    return OmpNativeServiceTierSnapshotSchema.parse(payload);
  }

  private runModelControl<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.modelControls.then(operation);
    this.modelControls = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async setProxyPolicy(policy: ProxyPolicy): Promise<void> {
    await this.request({ type: "set_proxy_policy", policy: ProxyPolicySchema.parse(policy) });
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    const data = OmpMessagesResultSchema.parse(await this.request({ type: "get_messages" }));
    return data.messages ?? [];
  }

  async appendSessionAnnotation(customType: string, data: unknown): Promise<string> {
    return OmpSessionAnnotationResultSchema.parse(await this.request({ type: "append_session_annotation", customType, data })).entryId;
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    const command = OmpSubagentRpcCommandSchema.parse({ type: "get_subagents" });
    return OmpSubagentsResultSchema.parse(await this.process.request(command)).subagents;
  }

  async getSubagentMessages(
    selector: OmpSubagentMessagesSelector,
  ): Promise<OmpSubagentMessagesResult> {
    const validated = OmpSubagentMessagesSelectorSchema.parse(selector);
    const command = OmpSubagentRpcCommandSchema.parse({
      type: "get_subagent_messages",
      ...validated,
    });
    return parseOmpSubagentMessagesResult(validated, await this.process.request(command));
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<OmpModel[]> {
    const data = OmpModelsResultSchema.parse(
      await this.request({ type: "get_available_models" }, timeoutMs),
    );
    return data.models ?? [];
  }
  async getServiceTierCapabilities() {
    const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
    const native = this.serviceTierEndpointPort ? await this.requestServiceTier() : undefined;
    return {
      fastMode: typeof state.fastModeEnabled === "boolean",
      ultrafast: native?.available === true && (await this.supportsUltrafastCommand()),
    };
  }
  async getLoginProviders(): Promise<OmpLoginProvider[]> {
    const data = OmpLoginProvidersResultSchema.parse(
      await this.request({ type: "get_login_providers" }),
    );
    return data.providers ?? [];
  }

  async login(providerId: string): Promise<void> {
    await this.request({ type: "login", providerId }, null);
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    this.assertModelSource();
    if (this.usesLocalModels && provider !== LOCAL_MODEL_PROVIDER) {
      throw new Error("Select a model from this Desktop while local models are enabled.");
    }
    return this.runModelControl(async () =>
      OmpModelSchema.parse(await this.request({ type: "set_model", provider, modelId })),
    );
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    // COMPAT(ompGetStateFallback): added in v0.1.105 — older OMP binaries
    // lack the `get_session_stats` RPC command; fall back to extracting
    // context window usage from `get_state`. Remove after 2027-01-10 once the
    // supported OMP floor includes `get_session_stats`.
    let stats: OmpSessionStats | undefined;
    try {
      stats = OmpSessionStatsSchema.parse(await this.request({ type: "get_session_stats" }));
    } catch {
      // get_session_stats not supported by this binary — will try get_state below
    }
    if (stats?.tokens == null && stats?.cost == null && stats?.contextUsage == null) {
      try {
        const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
        const ctx = state.contextUsage;
        if (ctx) {
          return {
            contextUsage: {
              tokens: typeof ctx.tokens === "number" ? ctx.tokens : undefined,
              contextWindow: typeof ctx.contextWindow === "number" ? ctx.contextWindow : undefined,
            },
          };
        }
      } catch {
        // get_state also failed — nothing we can do
      }
    }
    return stats ?? {};
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    const data = OmpCommandsResultSchema.parse(await this.request({ type: this.commandsRpcName }));
    return (data.commands ?? []).filter(
      (command) => !OMP_BACKGROUND_JOBS_COMMAND_PATTERN.test(command.name),
    );
  }

  async setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void> {
    await this.request({ type: "set_subagent_subscription", level });
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    const data = OmpHostToolsResultSchema.parse(
      await this.request({ type: "set_host_tools", tools }),
    );
    return data.toolNames ?? [];
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.process.send({ ...result });
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.process.send({ ...update });
  }

  sendPluginPromptResult(id:string,contributions:PluginAgentPromptSelection[],error?:string):void {
    this.process.send({type:"desktop_plugin_prompt_response",id,contributions,error});
  }

  async branch(entryId: string): Promise<{ text: string }> {
    const data = OmpBranchResultSchema.parse(await this.request({ type: "branch", entryId }));
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    // Branch restores and removes the selected user prompt. Its entry is no
    // longer a valid leaf in the new transcript; follow the persisted active tip.
    this.activeBranchEntryId = undefined;
    return { text: data.text };
  }

  async getBranchMessages(): Promise<OmpBranchMessage[]> {
    const data = OmpBranchMessagesResultSchema.parse(
      await this.request({ type: "get_branch_messages", activeBranchOnly: true }),
    );
    return data.messages ?? [];
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): Promise<void> {
    this.assertModelSource();
    const generation = this.inputGeneration;
    await this.refreshImageSettings();
    this.assertInputGeneration(generation);
    await this.request({
      type: "steer",
      message,
      ...(images?.length ? { images } : {}),
      ...options,
    });
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
    options?: OmpUserMessageOptions,
  ): void {
    this.assertModelSource();
    const generation = this.inputGeneration;
    if (!this.getImageGenerationConfig || !this.imageToken) {
      this.process.send({
        type: "follow_up",
        message,
        ...(images?.length ? { images } : {}),
        ...options,
      });
      return;
    }
    void this.refreshImageSettings()
      .then(() => {
        if (generation !== this.inputGeneration) return undefined;
        return this.process.send({
          type: "follow_up",
          message,
          ...(images?.length ? { images } : {}),
          ...options,
        });
      })
      .catch((error: unknown) => {
        if (generation !== this.inputGeneration) return;
        // A queued turn must not continue using stale credentials or silently
        // drop a failed settings update. Process exit is an observable provider error.
        void this.process.close(
          error instanceof Error ? error : new Error("OMP image settings update failed"),
        );
      });
  }

  async handoff(customInstructions?: string): Promise<void> {
    await this.request({
      type: "handoff",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  respondToExtensionUiRequest(id: string, response: OmpExtensionUiResponse): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    await this.process.close(new Error("OMP RPC session is closed"));
  }

  private request(command: OmpRpcCommand, timeoutMs?: number | null): Promise<unknown> {
    return this.process.request(OmpRpcCommandSchema.parse(command), timeoutMs);
  }

  private assertInputGeneration(generation: number): void {
    if (generation !== this.inputGeneration) throw new Error("OMP input canceled by user Stop");
  }

  private emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
