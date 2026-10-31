import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { OMP_SDK_ROOT_ENV } from "./sdk-host-protocol.js";

const sdkMetadata = z.object({
  name: z.literal("@oh-my-pi/pi-coding-agent"),
  version: z.string().min(1),
});

export interface OmpSdkInstallation {
  root: string;
  version: string;
  sdkEntry: string;
  rpcEntry: string;
  workerEntry: string;
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
  if (!root) {
    try {
      root = path.dirname(
        createRequire(import.meta.url).resolve("@oh-my-pi/pi-coding-agent/package.json"),
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "MODULE_NOT_FOUND"
      )
        throw error;
      throw new Error(
        "OMP SDK backend is selected but no Node SDK is installed. Set agents.providers.omp.ompSdkPath to a built SDK package root, or package it with OMP_DESKTOP_SDK_SOURCE.",
      );
    }
  }
  if (!path.isAbsolute(root)) throw new Error("OMP SDK package root must be absolute");
  const manifest = sdkMetadata.parse(
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")),
  );
  const required = ["sdk.mjs", "rpc.mjs", "host.mjs", "modules.json"];
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
    sdkEntry: path.join(root, "dist", "node", "sdk.mjs"),
    rpcEntry: path.join(root, "dist", "node", "rpc.mjs"),
    workerEntry: path.join(root, "dist", "node", "host.mjs"),
  };
}
