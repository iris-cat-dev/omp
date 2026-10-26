import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BackgroundProcessSchema,
  BackgroundProcessOutputSchema,
  type BackgroundProcess,
  type BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";
import type { Logger } from "pino";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  JSONL_RPC_DEFAULT_TIMEOUT_MS,
  JsonlRpcProcess,
  JSONL_RPC_NO_TIMEOUT,
  supportsJsonlRpcProtocolV2,
  type JsonlRpcLaunch,
} from "../jsonl-rpc-process.js";
import {
  buildOmpLaunch,
  resolveOmpRuntimeCommand,
  type OmpRuntime,
  type OmpRuntimeLaunch,
  type OmpRuntimeSession,
  type OmpStartSessionInput,
} from "./runtime.js";
import { resolveOmpBuiltinToolArgsForLaunch } from "./provider-config.js";
import {
  createBundledOmpHostVerifier,
  type BundledOmpHostVerifier,
} from "../../../bundled-omp-host.js";
import {
  provisionBundledOmpPlugins,
  type BundledOmpProvisioningResult,
} from "../../../bundled-omp-plugins.js";
import { beginBundledOmpInitialization } from "../../../bundled-omp-initialization.js";
import { createProviderEnv } from "../../provider-launch-config.js";
import { LOCAL_MODEL_PROVIDER } from "@omp-desktop/protocol/local-models";
import type { LocalModelBridge } from "../../../local-model-bridge.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";
import {
  prepareOmpImageSettingsLaunch,
  OMP_IMAGE_SETTINGS_TOKEN_ENV,
  type OmpImageSettingsGetter,
} from "./image-settings.js";
import {
  OmpBranchMessagesResultSchema,
  OmpBranchResultSchema,
  OmpCommandsResultSchema,
  OmpFastModeResultSchema,
  OmpHostToolsResultSchema,
  OmpLoginProvidersResultSchema,
  OmpMessagesResultSchema,
  OmpModelSchema,
  OmpModelsResultSchema,
  OmpPromptAckSchema,
  OmpRpcCommandSchema,
  OmpRuntimeEventSchema,
  OmpSessionStateSchema,
  OmpSessionStatsSchema,
  type OmpThinkingLevel,
  type OmpFastModeResult,
  type OmpAgentMessage,
  type OmpLoginProvider,
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

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const DEFAULT_COMMANDS_RPC_NAME = "get_available_commands";
/** Allow cold OMP starts the same 30-second budget as other control-plane RPCs. */
const OMP_READY_TIMEOUT_MS = JSONL_RPC_DEFAULT_TIMEOUT_MS;
const OMP_CODEX_CATALOG_PRELOAD_URL_ENV = "OMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL";
const OMP_CODEX_CATALOG_PRELOAD_BRIDGE =
  "data:text/javascript,await%20import(process%2Eenv%2EOMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL)";
const OmpToolInventorySchema = z.object({
  dumpTools: z.array(z.object({ name: z.string() })),
});

export function resolveOmpBackgroundJobsExtensionPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const compiled = fileURLToPath(new URL("./background-jobs-extension.js", moduleUrl));
  const source = fileURLToPath(new URL("./background-jobs-extension.ts", moduleUrl));
  const extension = pathExists(compiled) ? compiled : source;
  return extension.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolveOmpImageSettingsExtensionPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const compiled = fileURLToPath(new URL("./image-settings-extension.js", moduleUrl));
  const source = fileURLToPath(new URL("./image-settings-extension.ts", moduleUrl));
  return (pathExists(compiled) ? compiled : source).replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolveOmpCodexCatalogPreloadPath(
  moduleUrl: string | URL = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const compiled = fileURLToPath(new URL("./codex-catalog-preload.js", moduleUrl));
  const source = fileURLToPath(new URL("./codex-catalog-preload.ts", moduleUrl));
  return (pathExists(compiled) ? compiled : source).replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
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
      const available = await inspectOmpActiveTools(launch, this.options.logger);
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

  private async provisionBundledPlugins(
    command: [string, ...string[]],
    env: NodeJS.ProcessEnv,
    cwd: string,
    hostVerifier: BundledOmpHostVerifier,
    agentId: string | undefined,
  ): Promise<void> {
    const initialization = agentId ? beginBundledOmpInitialization(agentId) : undefined;
    let provisioning: BundledOmpProvisioningResult;
    try {
      provisioning = await provisionBundledOmpPlugins({
        command,
        env,
        cwd,
        hostVerifier,
        onProgress: initialization?.report,
      });
    } finally {
      initialization?.close();
    }
    for (const plugin of provisioning.plugins) {
      if (plugin.error)
        this.options.logger.warn(
          { plugin: plugin.name, error: plugin.error },
          "Bundled OMP plugin provisioning requires explicit management",
        );
    }
  }

  private async prepareLocalModelsLaunch(
    launch: OmpRuntimeLaunch,
    input: OmpStartSessionInput,
  ): Promise<{ bridge: LocalModelBridge | undefined; enabled: boolean }> {
    const bridge = input.localModelGateway ? undefined : this.options.localModelBridge;
    const enabled = bridge?.isEnabled() === true;
    if (enabled) {
      const configuration = await bridge!.getLaunchConfig();
      if (!configuration)
        throw new Error("Local model source is disconnected. Reconnect OMP Desktop.");
      const requested = input.model?.startsWith(`${LOCAL_MODEL_PROVIDER}/`)
        ? input.model.slice(LOCAL_MODEL_PROVIDER.length + 1)
        : input.model;
      const selected = requested
        ? configuration.models.find((model) => `${model.provider}/${model.id}` === requested)
        : configuration.models[0];
      if (!selected) throw new Error("Select an available model from this Desktop.");
      const reference = `${LOCAL_MODEL_PROVIDER}/${selected.provider}/${selected.id}`;
      // The final CLI selector wins over persisted defaults and resumed remote models.
      launch.argv.push("--model", reference);
      launch.model = reference;
      const compiled = fileURLToPath(new URL("./local-models-extension.js", import.meta.url));
      const source = fileURLToPath(new URL("./local-models-extension.ts", import.meta.url));
      launch.argv.push(
        "--extension",
        (existsSync(compiled) ? compiled : source).replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked"),
      );
      launch.env = {
        ...launch.env,
        OMP_DESKTOP_LOCAL_MODEL_BRIDGE: JSON.stringify({
          baseUrl: configuration.baseUrl,
          token: configuration.token,
        }),
      };
    } else if (!input.localModelGateway && input.model?.startsWith(`${LOCAL_MODEL_PROVIDER}/`)) {
      throw new Error("Local model source is disconnected. Reconnect OMP Desktop.");
    }
    return { bridge, enabled };
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    const launch = buildOmpLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    const { bridge, enabled: localModelsEnabled } = await this.prepareLocalModelsLaunch(
      launch,
      input,
    );
    const effectiveCommand = resolveOmpRuntimeCommand(this.command, this.options.runtimeSettings);
    const providerEnv = createProviderEnv({ overlays: [launch.env] });
    const hostVerifier = createBundledOmpHostVerifier();
    // Each cwd may initialize a different native dotenv/profile. Resolve it with
    // the genuine host before launch; the per-profile ledger prevents reseeding.
    await this.provisionBundledPlugins(
      effectiveCommand,
      providerEnv,
      launch.cwd,
      hostVerifier,
      input.env?.PASEO_AGENT_ID,
    );
    await hostVerifier(launch.argv[0], providerEnv);
    installCodexCatalogPreload(launch);
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
      if (!input.localModelGateway) await this.applyBuiltInToolPolicy(launch, effectiveCommand);
      if (input.protocolMode === "rpc-ui") {
        launch.argv.push("--extension", resolveOmpBackgroundJobsExtensionPath());
      }
      if (imageLaunch) launch.argv.push("--extension", resolveOmpImageSettingsExtensionPath());
      const imageToolAllowed = imageToolAllowedByArguments(launch.argv);
      const [command, ...args] = launch.argv;
      await hostVerifier(command, providerEnv);
      const processLaunch: JsonlRpcLaunch = {
        command,
        args,
        cwd: launch.cwd,
        env: launch.env,
      };
      const spawn = this.spawnProcess;
      const processOptions = {
        launch: processLaunch,
        logger: this.options.logger,
        diagnosticName: "OMP RPC",
        ...(spawn ? { spawn: () => spawn(launch) } : {}),
      };
      const process = new JsonlRpcProcess(processOptions);
      const runtimeSession = new OmpCliRuntimeSession(
        process,
        this.commandsRpcName,
        input.getImageGenerationConfig,
        imageLaunch?.token,
        imageToolAllowed,
        bridge,
        localModelsEnabled,
      );
      if (imageLaunch)
        process.onExit(() => {
          void imageLaunch.cleanup().catch((error: unknown) => {
            this.options.logger.warn(
              { error },
              "Could not remove private OMP image settings overlay",
            );
          });
        });
      const handleAbort = () => void process.close(input.signal?.reason).catch(() => undefined);
      input.signal?.addEventListener("abort", handleAbort, { once: true });
      try {
        await negotiateOmpProtocolV2(process, this.options.logger);
        input.signal?.throwIfAborted();
        await runtimeSession.refreshImageSettings();
        return runtimeSession;
      } catch (error) {
        const startupError = error instanceof Error ? error : new Error(String(error));
        await process.close(startupError);
        throw startupError;
      } finally {
        input.signal?.removeEventListener("abort", handleAbort);
      }
    } catch (error) {
      await imageLaunch?.cleanup();
      throw error;
    }
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
  private backgroundJobsEndpoint: { port: number; token: string } | null = null;
  private readonly imageEndpoint = Promise.withResolvers<number>();
  private imageEndpointPort: number | undefined;
  private appliedImageSettings: string | undefined;
  private imageUpdates = Promise.resolve();
  private readonly localModelGatewayEndpoint = Promise.withResolvers<number | Error>();

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
    private readonly getImageGenerationConfig?: OmpImageSettingsGetter,
    private readonly imageToken?: string,
    private readonly imageToolAllowed = true,
    private readonly localModelBridge?: LocalModelBridge,
    private readonly usesLocalModels = false,
  ) {
    process.onMessage((message) => {
      if (message.type === "desktop_local_model_gateway_ready") {
        const endpoint = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (endpoint.success) this.localModelGatewayEndpoint.resolve(endpoint.data.port);
        return;
      }
      if (message.type === "desktop_image_settings_ready") {
        const endpoint = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(message);
        if (endpoint.success) {
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
          })
          .safeParse(message);
        if (endpoint.success) this.backgroundJobsEndpoint = endpoint.data;
        return;
      }
      const event = OmpRuntimeEventSchema.safeParse(message);
      if (event.success) {
        this.emit(event.data);
      }
    });
    process.onExit(({ error }) => {
      this.appliedImageSettings = undefined;
      this.localModelGatewayEndpoint.resolve(new Error("The local OMP model worker stopped"));
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
    if (
      encoded === this.appliedImageSettings &&
      !(config?.enabled && this.imageToolAllowed && config.backend === "chatgpt-subscription")
    )
      return;
    const signal = AbortSignal.timeout(OMP_READY_TIMEOUT_MS);
    const aborted = Promise.withResolvers<never>();
    const onAbort = () =>
      aborted.reject(
        new Error(
          "OMP native image settings bridge did not become available; update OMP to v18.8.7 or newer",
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const readyPort = await Promise.race([this.imageEndpoint.promise, aborted.promise]);
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
      this.appliedImageSettings = encoded;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async refreshImageSettings(): Promise<void> {
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
  ): Promise<OmpPromptAck> {
    this.assertModelSource();
    await this.refreshImageSettings();
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
      // OMP rejects a bare prompt while it is still streaming (for example a queued
      // message drained after abort). Steering admits it into that live run instead.
      streamingBehavior: "steer",
    });
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
    return OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
  }

  async listBackgroundJobs(): Promise<BackgroundProcess[]> {
    if (!this.backgroundJobsEndpoint) return [];
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

  private async requestBackgroundJobs(path: string, init?: { method: "POST" }): Promise<unknown> {
    const endpoint = this.backgroundJobsEndpoint;
    if (!endpoint) throw new Error("OMP background-process bridge is not available yet");
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(init ? 30_000 : 5_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`OMP background-process request failed (${response.status})`);
    return response.json();
  }

  async setFastMode(enabled: boolean): Promise<OmpFastModeResult> {
    return OmpFastModeResultSchema.parse(await this.request({ type: "set_fast_mode", enabled }));
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    const data = OmpMessagesResultSchema.parse(await this.request({ type: "get_messages" }));
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<OmpModel[]> {
    const data = OmpModelsResultSchema.parse(
      await this.request({ type: "get_available_models" }, timeoutMs),
    );
    return data.models ?? [];
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
    return OmpModelSchema.parse(await this.request({ type: "set_model", provider, modelId }));
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
    return data.commands ?? [];
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

  async branch(entryId: string): Promise<{ text: string }> {
    const data = OmpBranchResultSchema.parse(await this.request({ type: "branch", entryId }));
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    this.activeBranchEntryId = entryId;
    return { text: data.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = OmpBranchMessagesResultSchema.parse(
      await this.request({ type: "get_branch_messages" }),
    );
    return data.messages ?? [];
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    this.assertModelSource();
    await this.refreshImageSettings();
    await this.request({ type: "steer", message, ...(images?.length ? { images } : {}) });
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void {
    this.assertModelSource();
    if (!this.getImageGenerationConfig || !this.imageToken) {
      this.process.send({ type: "follow_up", message, ...(images?.length ? { images } : {}) });
      return;
    }
    void this.refreshImageSettings()
      .then(() =>
        this.process.send({ type: "follow_up", message, ...(images?.length ? { images } : {}) }),
      )
      .catch((error: unknown) => {
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

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
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

  private emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
