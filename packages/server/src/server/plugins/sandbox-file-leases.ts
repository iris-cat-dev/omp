import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  openOmpSandboxFiles,
  type OmpSandboxFiles,
} from "../agent/providers/omp/sandbox-files.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";

const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const byteLimit = z.number().int().positive().max(MAX_MEDIA_BYTES);
const handleFields = { handle: z.string().min(1) };
const pathFields = { ...handleFields, path: z.string().min(1) };
const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), root: z.string().min(1), maxBytes: byteLimit.optional() }).strict(),
  z.object({ action: z.literal("read"), ...pathFields, maxBytes: byteLimit.optional() }).strict(),
  z.object({ action: z.literal("write"), ...pathFields, contentBase64: z.string(), maxBytes: byteLimit.optional(), exclusive: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("list"), ...pathFields }).strict(),
  z.object({ action: z.literal("mkdir"), ...pathFields }).strict(),
  z.object({ action: z.literal("remove"), ...pathFields }).strict(),
  z.object({ action: z.literal("close"), ...handleFields }).strict(),
]);

interface SandboxFileLease {
  installationId: string;
  generation: number;
  maxBytes: number;
  files: OmpSandboxFiles;
}

/** Opaque handles are installation- and generation-bound, never model tools. */
export class SandboxFileLeases {
  private readonly leases = new Map<string, SandboxFileLease>();

  constructor(private readonly runtimeSettings: () => ProviderRuntimeSettings | undefined) {}

  async invoke(
    installationId: string,
    generation: number,
    input: unknown,
    isCurrent: () => boolean,
  ): Promise<unknown> {
    const operation = operationSchema.parse(input);
    if (operation.action === "open") {
      if (!isCurrent()) throw new Error("Plugin sandbox generation is no longer active");
      const files = await openOmpSandboxFiles(operation.root, this.runtimeSettings());
      if (!isCurrent()) {
        files.close();
        throw new Error("Plugin sandbox generation is no longer active");
      }
      const handle = randomUUID();
      this.leases.set(handle, {
        installationId,
        generation,
        files,
        maxBytes: operation.maxBytes ?? MAX_MEDIA_BYTES,
      });
      return { handle };
    }

    const lease = this.leases.get(operation.handle);
    if (!lease || lease.installationId !== installationId || lease.generation !== generation) {
      throw new Error("Plugin sandbox handle is not owned by this installation generation");
    }
    if (operation.action === "close") {
      this.leases.delete(operation.handle);
      lease.files.close();
      return { ok: true };
    }
    if (!isCurrent()) throw new Error("Plugin sandbox generation is no longer active");

    switch (operation.action) {
      case "read": {
        const limit = Math.min(operation.maxBytes ?? lease.maxBytes, lease.maxBytes);
        return { contentBase64: lease.files.read(operation.path, limit).toString("base64") };
      }
      case "write": {
        const limit = Math.min(operation.maxBytes ?? lease.maxBytes, lease.maxBytes);
        if (operation.contentBase64.length > Math.ceil(limit / 3) * 4) {
          throw new Error("Sandbox media exceeds the granted size limit");
        }
        const encoded = z.base64().parse(operation.contentBase64);
        const content = Buffer.from(encoded, "base64");
        if (content.length > limit) throw new Error("Sandbox media exceeds the granted size limit");
        lease.files.write(operation.path, content, { exclusive: operation.exclusive });
        return { ok: true };
      }
      case "list":
        return { entries: lease.files.list(operation.path) };
      case "mkdir":
        lease.files.mkdir(operation.path);
        return { ok: true };
      case "remove":
        lease.files.remove(operation.path);
        return { ok: true };
    }
  }

  revoke(installationId: string): void {
    for (const [handle, lease] of this.leases) {
      if (lease.installationId !== installationId) continue;
      this.leases.delete(handle);
      lease.files.close();
    }
  }

  close(): void {
    for (const lease of this.leases.values()) lease.files.close();
    this.leases.clear();
  }
}
