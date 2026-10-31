import { spawn } from "node:child_process";
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
  startOmpRpcSession,
} from "./cli-runtime.js";
import {
  prepareOmpImageSettingsLaunch,
  OMP_IMAGE_SETTINGS_TOKEN_ENV,
} from "./image-settings.js";
import {
  resolveOmpSdkInstallation,
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

  async stopDaemon(input: {
    cwd: string;
    name: string;
    env?: Record<string, string>;
  }): Promise<void> {
    const env = createProviderEnv({
      runtimeSettings: this.options.runtimeSettings,
      overlays: [input.env],
    });
    const installation = await resolveOmpSdkInstallation(
      this.options.runtimeSettings,
      env,
    );
    const [command, ...args] = await resolveOmpSdkHostCommand();
    await execCommand(command, [...args, "--stop-daemon", input.name], {
      cwd: input.cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        [OMP_SDK_ROOT_ENV]: installation.root,
      },
      envMode: "internal",
    });
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    input.signal?.throwIfAborted();
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 24)
      throw new Error("OMP SDK backend requires Node.js 24 or newer");
    const runtimeSettings = this.options.runtimeSettings;
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
    const installation = await resolveOmpSdkInstallation(runtimeSettings, env);
    const command = await resolveOmpSdkHostCommand();
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
      },
    };
    const { bridge, enabled } = await prepareOmpLocalModelsLaunch(
      launch,
      input,
      this.options.localModelBridge,
    );
    const extensions: string[] = [];
    if (launch.protocolMode === "rpc-ui")
      extensions.push(resolveOmpBackgroundJobsExtensionPath());
    const imageLaunch = input.getImageGenerationConfig
      ? await prepareOmpImageSettingsLaunch(command, input.cwd, {
          ...process.env,
          ...launch.env,
        })
      : undefined;
    try {
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
        protocolMode: launch.protocolMode,
        model: launch.model,
        thinkingOptionId: input.thinkingOptionId,
        session: input.session,
        noSession: input.noSession,
        extraArgs: [
          ...(input.extraArgs ?? []),
          ...launch.argv.slice(command.length),
          ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
        ],
        extensions,
        disallowedTools: input.localModelGateway ? [] : denied,
        configFiles: imageLaunch ? [imageLaunch.configPath] : [],
      });
      launch.argv = [...command];
      launch.env = {
        ...launch.env,
        ...(imageLaunch
          ? { [OMP_IMAGE_SETTINGS_TOKEN_ENV]: imageLaunch.token }
          : {}),
        [OMP_SDK_LAUNCH_ENV]: JSON.stringify(payload),
      };
      return await startOmpRpcSession({
        launch,
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
        getImageGenerationConfig: input.getImageGenerationConfig,
        imageSettingsToken: imageLaunch?.token,
        imageToolAllowed: !denied.includes("generate_image"),
        localModelBridge: bridge,
        localModelsEnabled: enabled,
        cleanup: imageLaunch?.cleanup,
      });
    } catch (error) {
      await imageLaunch?.cleanup();
      throw error;
    }
  }
}
