import { createRequire } from "node:module";
import * as path from "node:path";
import { z } from "zod";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { resolveOmpSdkInstallation } from "./sdk-installation.js";

export interface OmpSandboxFileStat { isDirectory: boolean; size: number; modifiedAt: number }
export interface OmpSandboxFileEntry extends OmpSandboxFileStat { name: string }
export interface OmpSandboxFiles {
  read(path: string, maxBytes?: number): Buffer;
  write(path: string, bytes: Buffer, options?: { exclusive?: boolean }): void;
  list(path: string): OmpSandboxFileEntry[];
  stat(path: string): OmpSandboxFileStat;
  mkdir(path: string): void;
  remove(path: string): void;
  close(): void;
}
const filesSchema = z.object({
  read: z.custom<OmpSandboxFiles["read"]>((value) => typeof value === "function"),
  write: z.custom<OmpSandboxFiles["write"]>((value) => typeof value === "function"),
  list: z.custom<OmpSandboxFiles["list"]>((value) => typeof value === "function"),
  stat: z.custom<OmpSandboxFiles["stat"]>((value) => typeof value === "function"),
  mkdir: z.custom<OmpSandboxFiles["mkdir"]>((value) => typeof value === "function"),
  remove: z.custom<OmpSandboxFiles["remove"]>((value) => typeof value === "function"),
  close: z.custom<OmpSandboxFiles["close"]>((value) => typeof value === "function"),
});
const moduleSchema = z.object({
  SANDBOX_FS_VERSION: z.literal(1),
  openSandboxFs: z.custom<(options: { root: string; maxBytes: number }) => Promise<OmpSandboxFiles>>((value) => typeof value === "function"),
});

/** Trusted plugin host media lease; this API is never mounted as a model tool. */
export async function openOmpSandboxFiles(root: string, runtimeSettings?: ProviderRuntimeSettings): Promise<OmpSandboxFiles> {
  const installation = await resolveOmpSdkInstallation(runtimeSettings);
  const module = moduleSchema.parse(createRequire(import.meta.url)(path.join(installation.root, "dist", "node", "sandbox.mjs")));
  return filesSchema.parse(await module.openSandboxFs({ root, maxBytes: 200 * 1024 * 1024 }));
}
