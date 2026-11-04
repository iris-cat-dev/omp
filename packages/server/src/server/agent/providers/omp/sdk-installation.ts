import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { OMP_SDK_ROOT_ENV } from "./sdk-host-protocol.js";

const sdkMetadata = z.object({
  name: z.literal("@oh-my-pi/pi-coding-agent"),
  version: z.string().min(1),
  ompNodeSdk: z
    .object({
      profile: z.enum(["core", "full"]).optional(),
    })
    .optional(),
});
const sdkIpcModule = z.object({
  ipcEndpoint: z.custom<(dir: string, name: string) => string>(
    (value) => typeof value === "function",
    "The selected SDK native module does not export ipcEndpoint",
  ),
});

export interface OmpSdkInstallation {
  root: string;
  version: string;
  profile: "core" | "full" | "unknown";
  sdkEntry: string;
  rpcEntry: string;
  workerEntry: string;
}

const sdkRequire = createRequire(import.meta.url);

function resolveInstalledSdkRoot(): string | undefined {
  try {
    return path.dirname(sdkRequire.resolve("@oh-my-pi/pi-coding-agent/package.json"));
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "MODULE_NOT_FOUND"
    )
      throw error;
    return undefined;
  }
}

/** Desktop owns its runtime; standalone servers may deliberately select an external CLI. */
export function resolveOmpBackend(
  settings?: Pick<ProviderRuntimeSettings, "ompBackend" | "ompSdkPath" | "env">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): "sdk" | "cli" {
  if (env.PASEO_DESKTOP_MANAGED === "1") return "sdk";
  if (settings?.ompBackend) return settings.ompBackend;
  return settings?.ompSdkPath ||
    settings?.env?.[OMP_SDK_ROOT_ENV] ||
    env[OMP_SDK_ROOT_ENV] ||
    resolveInstalledSdkRoot()
    ? "sdk"
    : "cli";
}

/** Locate the selected SDK, never substituting a CLI executable or another package. */
export async function resolveOmpSdkInstallation(
  settings?: Pick<ProviderRuntimeSettings, "ompSdkPath" | "env">,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<OmpSdkInstallation> {
  let root =
    settings?.ompSdkPath ??
    (env
      ? env[OMP_SDK_ROOT_ENV]
      : (settings?.env?.[OMP_SDK_ROOT_ENV] ?? process.env[OMP_SDK_ROOT_ENV]));
  root ??= resolveInstalledSdkRoot();
  if (!root) {
    throw new Error(
      "No built OMP Node SDK is installed. The SDK backend and cold-history reads (including standalone CLI history) require a built SDK package with an indexed journal module. Set agents.providers.omp.ompSdkPath to that package root, build the project SDK, or package it with OMP_DESKTOP_SDK_SOURCE.",
    );
  }
  if (!path.isAbsolute(root)) throw new Error("OMP SDK package root must be absolute");
  const manifest = sdkMetadata.parse(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
  );
  const required = ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"];
  await Promise.all(
    required.map(async (file) => {
      const filename = path.join(root, "dist", "node", file);
      if (!(await fs.stat(filename)).isFile())
        throw new Error(`OMP Node SDK artifact is not a file: ${filename}`);
    }),
  );
  return {
    root,
    version: manifest.version,
    profile: manifest.ompNodeSdk?.profile ?? "unknown",
    sdkEntry: path.join(root, "dist", "node", "sdk.mjs"),
    rpcEntry: path.join(root, "dist", "node", "rpc.mjs"),
    workerEntry: path.join(root, "dist", "node", "host.mjs"),
  };
}

/** Load only the pure IPC helper from the selected SDK's own native dependency. */
export function resolveOmpSdkBrokerEndpoint(
  installation: OmpSdkInstallation,
  runtimeDir: string,
): string {
  const native = sdkIpcModule.parse(createRequire(installation.sdkEntry)("@oh-my-pi/pi-natives"));
  return native.ipcEndpoint(runtimeDir, "broker");
}
