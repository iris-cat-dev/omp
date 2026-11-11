import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createProviderEnv } from "../../provider-launch-config.js";
import type { LocalModelBridge } from "../../../local-model-bridge.js";
import { hasBundledOmpPlugins } from "../../../bundled-omp-host.js";
import { execCommand } from "../../../../utils/spawn.js";
import {
  prepareOmpLocalModelsLaunch,
  resolveOmpBackgroundJobsExtensionPath,
  resolveOmpImageSettingsExtensionPath,
  resolveOmpServiceTierExtensionPath,
  OMP_SERVICE_TIER_TOKEN_ENV,
  startOmpRpcSession,
} from "./cli-runtime.js";
import { resolveOmpRuntimeHelperPath } from "./sdk-host-command.js";
import { prepareOmpImageSettingsLaunch, OMP_IMAGE_SETTINGS_TOKEN_ENV } from "./image-settings.js";
import { startOmpLocalModelGateway, type OmpLocalModelGatewaySource } from "./local-model-gateway.js";
import {
  resolveOmpSdkInstallation,
  resolveOmpSdkBrokerEndpoint,
  type OmpSdkInstallation,
} from "./sdk-installation.js";
import { resolveOmpSdkHostCommand } from "./sdk-host-command.js";
import {
  OMP_SDK_ROOT_ENV,
  OMP_SDK_LAUNCH_ENV,
  OmpSdkHostLaunchSchema,
} from "./sdk-host-protocol.js";
import type {
  OmpRuntime,
  OmpRuntimeLaunch,
  OmpRuntimeSession,
  OmpStartSessionInput,
} from "./runtime.js";

export * from "./sdk-installation.js";

export interface OmpSdkRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  localModelBridge?: LocalModelBridge;
  disabledBuiltInTools?: readonly string[];
}

/** SDK state stays in a Node child while all Desktop RPC/event contracts remain shared. */
export class OmpSdkRuntime implements OmpRuntime {
  constructor(readonly options: OmpSdkRuntimeOptions) {}

  getInstallation(): Promise<OmpSdkInstallation> {
    return resolveOmpSdkInstallation(this.options.runtimeSettings);
  }

  async resolveBrokerEndpoint(
    runtimeDir: string,
    launchEnv?: Record<string, string>,
  ): Promise<string> {
    const env = createProviderEnv({
      runtimeSettings: this.options.runtimeSettings,
      overlays: [launchEnv],
    });
    const installation = await resolveOmpSdkInstallation(this.options.runtimeSettings, env);
    return resolveOmpSdkBrokerEndpoint(installation, runtimeDir);
  }

  async stopDaemon(input: {
    cwd: string;
    name: string;
    id: string;
    env?: Record<string, string>;
  }): Promise<void> {
    const env = createProviderEnv({
      runtimeSettings: this.options.runtimeSettings,
      overlays: [input.env],
    });
    const installation = await resolveOmpSdkInstallation(this.options.runtimeSettings, env);
    const [command, ...args] = await resolveOmpSdkHostCommand();
    await execCommand(command, [...args, "--stop-daemon", input.name], {
      cwd: input.cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        [OMP_SDK_ROOT_ENV]: installation.root,
        OMP_DESKTOP_STOP_DAEMON_ID: input.id,
      },
      envMode: "internal",
    });
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    const preparationStartedAt = performance.now();
    input.signal?.throwIfAborted();
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24) throw new Error("OMP SDK backend requires Node.js 24 or newer");
    const runtimeSettings = this.options.runtimeSettings;
    const env = this.createSdkSessionEnv(runtimeSettings, input);
    const installation = await resolveOmpSdkInstallation(runtimeSettings, env);
    const command = await resolveOmpSdkHostCommand();
    const serviceTierToken = randomUUID();
    const launch: OmpRuntimeLaunch = {
      cwd: input.cwd,
      argv: [...command],
      protocolMode: input.protocolMode ?? "rpc",
      model: input.model,
      thinkingOptionId: input.thinkingOptionId,
      session: input.session,
      noSession: input.noSession,
      systemPrompt: input.systemPrompt,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        [OMP_SDK_ROOT_ENV]: installation.root,
        [OMP_SERVICE_TIER_TOKEN_ENV]: serviceTierToken,
      },
    };
    const { bridge, enabled } = await prepareOmpLocalModelsLaunch(
      launch,
      input,
      this.options.localModelBridge,
    );
    const extensions = input.sandbox ? [] : [resolveOmpServiceTierExtensionPath()];
    if (!input.sandbox && launch.protocolMode === "rpc-ui") extensions.push(resolveOmpBackgroundJobsExtensionPath());
    const imageLaunch = !input.sandbox && input.getImageGenerationConfig
      ? await prepareOmpImageSettingsLaunch(command, input.cwd, {
          ...process.env,
          ...launch.env,
        })
      : undefined;
    let modelSource: OmpLocalModelGatewaySource | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => cleanupPromise ??= Promise.all([
      imageLaunch?.cleanup(),
      modelSource?.close(),
    ]).then(() => undefined);
    try {
      if (input.sandbox && !enabled) {
        modelSource = await startOmpLocalModelGateway(sourceInput => this.startSession({
          ...sourceInput,
          cwd: env.HOME || env.USERPROFILE || sourceInput.cwd,
          signal: input.signal,
          env: { ...input.env, ...sourceInput.env },
          proxyPolicy: input.proxyPolicy,
        }), input.signal);
        if (input.model && !modelSource.models.some(model => `${model.provider}/${model.id}` === input.model)) {
          throw new Error(`Sandbox model is unavailable: ${input.model}`);
        }
        launch.env = {
          ...launch.env,
          OMP_DESKTOP_SANDBOX_MODEL_BRIDGE: JSON.stringify(modelSource.launchConfig),
        };
      }
      const denied = this.configureSdkHostLaunch(
        input,
        launch,
        command,
        extensions,
        runtimeSettings,
        imageLaunch,
      );
      input.signal?.throwIfAborted();
      input.onActivity?.("prepareMs", performance.now() - preparationStartedAt);
      const startStartedAt = performance.now();
      const session = await startOmpRpcSession({
        launch,
        enableAskDialog: !input.sandbox,
        // This is our Node host, not an external provider command. The shared
        // transport's default spawn strips ELECTRON_RUN_AS_NODE, which makes a
        // packaged Desktop executable re-enter its GUI/CLI dispatch instead.
        // Keep it in the host environment so SDK worker subprocesses inherit it.
        spawnProcess: (hostLaunch) => {
          const [executable, ...args] = hostLaunch.argv;
          return spawn(executable, args, {
            cwd: hostLaunch.cwd,
            env: hostLaunch.env,
            stdio: "pipe",
            windowsHide: true,
          });
        },
        logger: this.options.logger,
        signal: input.signal,
        onRetirementCreated: input.onRetirementCreated,
        getImageGenerationConfig: input.sandbox ? undefined : input.getImageGenerationConfig,
        imageSettingsToken: imageLaunch?.token,
        imageToolAllowed: !input.sandbox && !denied.includes("generate_image"),
        localModelBridge: bridge,
        localModelsEnabled: enabled && !launch.env?.OMP_DESKTOP_SANDBOX_MODEL_BRIDGE,
        serviceTierToken,
        cleanup,
      });
      if (input.sandbox) {
        try {
          input.signal?.throwIfAborted();
          const state = await session.getState();
          if (!state.model || (launch.model && `${state.model.provider}/${state.model.id}` !== launch.model)) {
            throw new Error(`Sandbox model is unavailable: ${launch.model ?? "saved or configured model"}`);
          }
          input.signal?.throwIfAborted();
        } catch (error) {
          await session.close();
          throw error;
        }
      }
      input.onActivity?.("startMs", performance.now() - startStartedAt);
      return session;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private createSdkSessionEnv(
    runtimeSettings: ProviderRuntimeSettings | undefined,
    input: OmpStartSessionInput,
  ): NodeJS.ProcessEnv {
    const configuredCommand = runtimeSettings?.command;
    const defaultBinary = process.env.OMP_COMMAND?.trim() || "omp";
    if (
      configuredCommand &&
      configuredCommand.mode !== "default" &&
      !(
        configuredCommand.mode === "replace" &&
        configuredCommand.argv.length === 1 &&
        configuredCommand.argv[0] === defaultBinary
      )
    ) {
      throw new Error(
        "OMP SDK backend does not execute custom CLI commands; remove the command override or select the CLI backend",
      );
    }
    const env = createProviderEnv({ runtimeSettings, overlays: [input.env] });
    if (hasBundledOmpPlugins(env)) {
      throw new Error(
        "This plugin-bound CLI distribution cannot use the SDK backend; select CLI or package SDK-compatible plugins separately",
      );
    }
    return env;
  }

  private configureSdkHostLaunch(
    input: OmpStartSessionInput,
    launch: OmpRuntimeLaunch,
    command: readonly string[],
    extensions: string[],
    runtimeSettings: ProviderRuntimeSettings | undefined,
    imageLaunch: { configPath: string; token: string } | undefined,
  ): string[] {
    if (imageLaunch) extensions.push(resolveOmpImageSettingsExtensionPath());
    const denied = [
      ...new Set([
        ...(runtimeSettings?.disallowedTools ?? []),
        ...(this.options.disabledBuiltInTools ?? []),
      ]),
    ];
    const systemPrompt = input.systemPrompt?.trim();
    const payload = OmpSdkHostLaunchSchema.parse({
      cwd: input.cwd,
      sandbox: input.sandbox,
      systemPrompt: input.sandbox ? input.systemPrompt : undefined,
      modelBridgeExtension: input.sandbox
        ? launch.env?.OMP_DESKTOP_SANDBOX_MODEL_BRIDGE
          ? resolveOmpRuntimeHelperPath("sandbox-models-extension", import.meta.url)
          : launch.env?.OMP_DESKTOP_LOCAL_MODEL_BRIDGE
            ? resolveOmpRuntimeHelperPath("local-models-extension", import.meta.url)
            : undefined
        : undefined,
      proxyPolicy: input.proxyPolicy ?? runtimeSettings?.proxyPolicy,
      protocolMode: launch.protocolMode,
      model: launch.model,
      desktopPluginPrompts: !input.sandbox,
      thinkingOptionId: input.thinkingOptionId,
      session: input.session,
      noSession: input.noSession,
      extraArgs: input.sandbox ? [] : [
        ...(input.extraArgs ?? []),
        ...launch.argv.slice(command.length),
        ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
      ],
      extensions: input.sandbox ? [] : extensions,
      disallowedTools: input.localModelGateway ? [] : denied,
      configFiles: !input.sandbox && imageLaunch ? [imageLaunch.configPath] : [],
    });
    launch.argv = [...command];
    launch.env = {
      ...launch.env,
      ...(imageLaunch ? { [OMP_IMAGE_SETTINGS_TOKEN_ENV]: imageLaunch.token } : {}),
      [OMP_SDK_LAUNCH_ENV]: JSON.stringify(payload),
    };
    return denied;
  }
}
