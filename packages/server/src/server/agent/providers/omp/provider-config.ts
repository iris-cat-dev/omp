import { existsSync, promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { OMP_MODES } from "@omp-desktop/protocol/provider-manifest";
import {
  getOmpBuiltinToolNames,
  OMP_BUILTIN_TOOL_NAMES,
  OMP_LEGACY_BUILTIN_TOOL_NAMES,
} from "@omp-desktop/protocol/omp-builtin-tools";
import { execCommand } from "../../../../utils/spawn.js";
import { parseDocument } from "yaml";
import { z } from "zod";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

const OMP_SESSION_DIR = "~/.omp/agent/sessions";
const DEFAULT_OMP_MODE_ID = "ask";

export const MIN_SUPPORTED_OMP_VERSION = "16.3.9";
export { OMP_MODES };

export const OmpAgentShellModeSchema = z.enum(["auto", "git-bash", "omp-default", "custom"]);
export type OmpAgentShellMode = z.infer<typeof OmpAgentShellModeSchema>;

const OmpAgentShellConfigSchema = z
  .object({
    mode: OmpAgentShellModeSchema,
    path: z.string().min(1).optional(),
  })
  .refine((value) => value.mode !== "custom" || value.path !== undefined, {
    message: "Custom Agent Shell requires a path",
    path: ["path"],
  });

export const OmpProviderParamsSchema = z
  .object({
    sessionDir: z.string().min(1).optional(),
    smolModel: z.string().min(1).optional(),
    slowModel: z.string().min(1).optional(),
    planModel: z.string().min(1).optional(),
    agentShell: OmpAgentShellConfigSchema.optional(),
    disabledBuiltInTools: z.array(z.string()).optional(),
    proxyEnabled: z.boolean().optional(),
  })
  .strict();

export interface OmpRuntimeProviderParams {
  proxyEnabled: boolean;
  disabledBuiltInTools?: readonly string[];
  sessionDir: string;
  agentShell: {
    mode: OmpAgentShellMode;
    path?: string;
  };
}

export interface OmpModelRoleParams {
  smolModel?: string;
  slowModel?: string;
  planModel?: string;
}

export function resolveOmpLaunchMode(
  modeId: string | undefined,
  modelRoleParams: OmpModelRoleParams = {},
): { modeId: string; extraArgs: string[] } {
  const modelRoleArgs = resolveOmpModelRoleArgs(modelRoleParams);
  const resolvedModeId = modeId ?? DEFAULT_OMP_MODE_ID;
  switch (resolvedModeId) {
    case "full":
      return { modeId: "full", extraArgs: ["--approval-mode", "yolo", ...modelRoleArgs] };
    case "write":
      return {
        modeId: "write",
        extraArgs: ["--approval-mode", "write", ...modelRoleArgs],
      };
    case "ask":
      return {
        modeId: "ask",
        extraArgs: ["--approval-mode", "always-ask", ...modelRoleArgs],
      };
    default:
      throw new Error(`Unsupported OMP mode '${resolvedModeId}'`);
  }
}

/**
 * CLI approval flags are runtime-only and are not recorded in session JSONL.
 * Recover an explicitly configured native default for imports, never the CLI's
 * permissive schema default. Creation keeps its existing desktop default.
 */
export async function readOmpImportMode(
  cwd: string,
  env: NodeJS.ProcessEnv,
  command?: ProviderRuntimeSettings["command"],
): Promise<string | undefined> {
  let args: readonly string[] = [];
  if (command?.mode === "replace") {
    args = command.argv.slice(1);
  } else if (command?.mode === "append") {
    args = command.args ?? [];
  }
  // Custom CLI overlays/approval switches may override the files below. Until
  // the native CLI exposes its effective settings, do not infer a grant from a
  // partial configuration view.
  if (
    args.some((arg) => /^(?:--config|--approval-mode)(?:=|$)|^(?:--yolo|--auto-approve)$/.test(arg))
  ) {
    return undefined;
  }
  const agentDir = resolveOmpDiagnosticPaths(env).agentDir;
  const ymlPath = join(agentDir, "config.yml");
  const globalPath = existsSync(ymlPath) ? ymlPath : join(agentDir, "config.yaml");
  const configPaths = [
    globalPath,
    join(cwd, ".omp", "settings.json"),
    join(cwd, ".omp", "config.yml"),
    ...(env.PI_CONFIG_FILES?.split(delimiter).filter(Boolean) ?? []).map((file) =>
      resolve(cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file),
    ),
  ];
  let modeId: string | undefined;
  for (const configPath of configPaths) {
    const raw = await fs
      .readFile(configPath, "utf8")
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
    if (raw === undefined) continue;
    const document = parseDocument(raw);
    if (document.errors.length > 0) {
      throw new Error(`Invalid OMP config: ${configPath}: ${document.errors[0]?.message}`);
    }
    const approvalMode: unknown = document.getIn(["tools", "approvalMode"]);
    if (approvalMode === undefined) continue;
    switch (approvalMode) {
      case "always-ask":
        modeId = "ask";
        break;
      case "write":
        modeId = "write";
        break;
      case "yolo":
        modeId = "full";
        break;
      default:
        throw new Error(`Invalid OMP tools.approvalMode in ${configPath}`);
    }
  }
  return modeId;
}

function resolveOmpModelRoleArgs(modelRoleParams: OmpModelRoleParams): string[] {
  const args: string[] = [];
  if (modelRoleParams.smolModel) args.push("--smol", modelRoleParams.smolModel);
  if (modelRoleParams.slowModel) args.push("--slow", modelRoleParams.slowModel);
  if (modelRoleParams.planModel) args.push("--plan", modelRoleParams.planModel);
  return args;
}

export interface OmpDiagnosticPaths {
  profile: string;
  configRoot: string;
  agentDir: string;
  agentDb: string;
  xdgDataRoot: string;
  xdgStateRoot: string;
  xdgCacheRoot: string;
}

export function resolveOmpDiagnosticPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): OmpDiagnosticPaths {
  const normalizedProfile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
  const profile =
    normalizedProfile && normalizedProfile !== "default" ? normalizedProfile : "default";
  const baseConfigRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const configRoot =
    profile === "default" ? baseConfigRoot : join(baseConfigRoot, "profiles", profile);
  const defaultAgentDir = join(configRoot, "agent");
  const agentDir =
    profile === "default" && env.PI_CODING_AGENT_DIR
      ? resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgentDir;
  const xdgSupported = platform === "linux" || platform === "darwin";
  const resolveXdgRoot = (variable: "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME") => {
    const base = env[variable];
    if (!xdgSupported || agentDir !== defaultAgentDir || !base) return undefined;
    const appRoot = join(base, "omp");
    const candidate = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    return existsSync(candidate) ? candidate : undefined;
  };
  const xdgDataRoot = resolveXdgRoot("XDG_DATA_HOME") ?? configRoot;
  const xdgStateRoot = resolveXdgRoot("XDG_STATE_HOME") ?? configRoot;
  const xdgCacheRoot = resolveXdgRoot("XDG_CACHE_HOME") ?? configRoot;

  return {
    profile,
    configRoot,
    agentDir,
    agentDb: join(xdgDataRoot === configRoot ? agentDir : xdgDataRoot, "agent.db"),
    xdgDataRoot,
    xdgStateRoot,
    xdgCacheRoot,
  };
}

export function formatOmpVersionSupport(versionOutput: string): string {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return `unknown (minimum ${MIN_SUPPORTED_OMP_VERSION})`;
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = MIN_SUPPORTED_OMP_VERSION.split(".").map(Number);
  const supported =
    installed[0]! > minimum[0]! ||
    (installed[0] === minimum[0] &&
      (installed[1]! > minimum[1]! ||
        (installed[1] === minimum[1]! && installed[2]! >= minimum[2]!)));
  return `${match[1]}.${match[2]}.${match[3]} (${supported ? "supported" : "unsupported"}; minimum ${MIN_SUPPORTED_OMP_VERSION})`;
}

export function resolveOmpProviderParams(providerParams: unknown): {
  runtimeProviderParams: OmpRuntimeProviderParams;
  modelRoleParams: OmpModelRoleParams;
} {
  const params = OmpProviderParamsSchema.parse(providerParams ?? {});
  return {
    runtimeProviderParams: {
      sessionDir: params.sessionDir ?? OMP_SESSION_DIR,
      proxyEnabled: params.proxyEnabled !== false,
      agentShell: params.agentShell ?? { mode: "auto" },
      ...(params.disabledBuiltInTools !== undefined
        ? { disabledBuiltInTools: params.disabledBuiltInTools }
        : {}),
    },
    modelRoleParams: {
      ...(params.smolModel ? { smolModel: params.smolModel } : {}),
      ...(params.slowModel ? { slowModel: params.slowModel } : {}),
      ...(params.planModel ? { planModel: params.planModel } : {}),
    },
  };
}

const KNOWN_BUILTIN_TOOLS: Record<string, true> = Object.fromEntries(
  [...OMP_BUILTIN_TOOL_NAMES, ...OMP_LEGACY_BUILTIN_TOOL_NAMES].map((name) => [name, true]),
);
const TOOL_FLAGS = /^(?:--tools(?:=.*)?|--no-tools)$/;

export function assertOmpBuiltinToolNames(disabled: readonly string[]): void {
  const unknown = disabled.filter((name) => !Object.hasOwn(KNOWN_BUILTIN_TOOLS, name));
  if (unknown.length > 0) {
    throw new Error(`Unknown OMP built-in tools: ${unknown.join(", ")}`);
  }
  if (new Set(disabled).size !== disabled.length) {
    throw new Error("Disabled OMP built-in tools must not contain duplicates");
  }
}

export function resolveOmpBuiltinToolArgs(
  disabled: readonly string[],
  versionOutput: string,
  helpOutput: string,
  configuredArgs: readonly string[],
): string[] {
  assertOmpBuiltinToolNames(disabled);
  if (disabled.length === 0) return [];
  if (configuredArgs.some((arg) => TOOL_FLAGS.test(arg))) {
    throw new Error(
      "OMP built-in tool settings conflict with a configured --tools or --no-tools argument. Remove the custom tool flag first.",
    );
  }
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1];
  const manifest = getOmpBuiltinToolNames(version);
  if (!/--tools(?:[=\s]|$)/.test(helpOutput) || !/--no-tools(?:[\s]|$)/.test(helpOutput)) {
    throw new Error(
      "This OMP binary does not support --tools and --no-tools. Update OMP to a supported version or clear the disabled tools.",
    );
  }
  const activeDisabled = new Set(disabled.filter((name) => manifest.includes(name)));
  if (activeDisabled.size === 0) return [];
  const enabled = manifest.filter((name) => !activeDisabled.has(name));
  return enabled.length === 0 ? ["--no-tools"] : ["--tools", enabled.join(",")];
}

/** Validate before persisting, so an unsupported executable cannot yield a false success. */
export function validateOmpBuiltinToolConfigSync(
  disabled: readonly string[],
  command: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertOmpBuiltinToolNames(disabled);
  if (disabled.length === 0) return;
  if (!command[0]) throw new Error("OMP built-in tool settings require an executable command");
  const [binary, ...configuredArgs] = command;
  if (configuredArgs.some((arg) => TOOL_FLAGS.test(arg))) {
    throw new Error(
      "OMP built-in tool settings conflict with a configured tool-selection argument",
    );
  }
  const run = (flag: string): string => {
    const result = spawnSync(binary, [...configuredArgs, flag], {
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Cannot inspect OMP executable "${binary}" (${flag}): ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}. Check the configured command or clear the disabled tools.`,
      );
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  const version = run("--version");
  const help = run("--help");
  resolveOmpBuiltinToolArgs(disabled, version, help, configuredArgs);
}

export async function resolveOmpBuiltinToolArgsForLaunch(
  disabled: readonly string[],
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  assertOmpBuiltinToolNames(disabled);
  if (disabled.length === 0) return [];
  if (!command[0]) throw new Error("OMP built-in tool settings require an executable command");
  const [binary, ...configuredArgs] = command;
  if (configuredArgs.some((arg) => TOOL_FLAGS.test(arg))) {
    throw new Error(
      "OMP built-in tool settings conflict with a configured tool-selection argument",
    );
  }
  try {
    const [version, help] = await Promise.all(
      ["--version", "--help"].map((flag) =>
        execCommand(binary, [...configuredArgs, flag], {
          envMode: "internal",
          env,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        }),
      ),
    );
    return resolveOmpBuiltinToolArgs(
      disabled,
      `${version.stdout}\n${version.stderr}`,
      `${help.stdout}\n${help.stderr}`,
      configuredArgs,
    );
  } catch (error) {
    throw new Error(
      `Cannot verify OMP built-in tool settings for "${binary}": ${error instanceof Error ? error.message : String(error)}. Check the configured command or clear the disabled tools.`,
      { cause: error },
    );
  }
}

export function mergeOmpRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) return undefined;
  return {
    command: override?.command ?? base?.command,
    env: base?.env || override?.env ? { ...base?.env, ...override?.env } : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}
