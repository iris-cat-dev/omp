import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyPluginClientTrust,
  PluginClientTrustDocumentSchema,
  type PluginClientTrustDocument,
  type PluginClientTrustRequest,
} from "@omp-desktop/protocol/plugin-client-trust";

export function createPluginClientTrustStore(userDataPath: string) {
  const filePath = path.join(userDataPath, "plugin-client-trust.json");
  let queue = Promise.resolve();

  async function read(): Promise<PluginClientTrustDocument | null> {
    try {
      return PluginClientTrustDocumentSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function persist(document: PluginClientTrustDocument): Promise<void> {
    await mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document), { mode: 0o600 });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return function access({ operation, initial }: PluginClientTrustRequest): Promise<boolean | null> {
    const pending = queue.then(async () => {
      const saved = await read();
      const document = saved ?? initial;
      // Only the first committed operation imports the renderer's old approvals.
      if (!document) return null;
      const result = applyPluginClientTrust(document, operation);
      if (saved === null || operation.action !== "check") await persist(document);
      return result;
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
}
