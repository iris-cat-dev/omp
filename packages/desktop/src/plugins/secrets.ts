import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
const SecretDocumentSchema = z.record(z.string(), z.string());
export const LocalPluginSecretRequestSchema = z.object({ key: z.string().min(1).max(256), operation: z.enum(["configured", "get", "set", "delete"]), value: z.string().optional() });
export class LocalPluginSecrets {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly userDataPath: string) {}
  invoke(installationId: string, raw: unknown, authorize: () => void): Promise<unknown> {
    const input = LocalPluginSecretRequestSchema.parse(raw);
    const operation = (this.queues.get(installationId) ?? Promise.resolve()).then(async () => {
      authorize();
      const directory = path.join(this.userDataPath, "desktop-plugins", "data", installationId);
      const filename = path.join(directory, "secrets.json");
      let document: Record<string, string>;
      try { document = SecretDocumentSchema.parse(JSON.parse(await readFile(filename, "utf8"))); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; document = {}; }
      authorize();
      const encrypted = document[input.key];
      if (input.operation === "configured") return encrypted !== undefined;
      if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("Secure local plugin secret storage is unavailable on this platform.");
      if (input.operation === "get") return encrypted === undefined ? null : safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      if (input.operation === "set") { if (input.value === undefined) throw new TypeError("Setting a plugin secret requires a value."); document[input.key] = safeStorage.encryptString(input.value).toString("base64"); }
      else delete document[input.key];
      await mkdir(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 }); authorize(); await rename(temporary, filename); }
      catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
      return undefined;
    });
    this.queues.set(installationId, operation.catch(() => undefined));
    return operation;
  }
  async clear(installationId: string): Promise<void> { await this.queues.get(installationId); await rm(path.join(this.userDataPath, "desktop-plugins", "data", installationId), { recursive: true, force: true }); }
}
