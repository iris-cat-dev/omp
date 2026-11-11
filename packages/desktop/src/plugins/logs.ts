import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { LocalPluginLogEntrySchema, type LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
export class LocalPluginLogs {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly userDataPath: string) {}
  append(installationId: string, stream: LocalPluginLogEntry["stream"], message: string): void {
    const entry: LocalPluginLogEntry = { timestamp: new Date().toISOString(), stream, message: message.slice(0, 16_384) };
    const directory = path.join(this.userDataPath, "desktop-plugins", "logs");
    const operation = (this.queues.get(installationId) ?? Promise.resolve()).then(async () => { await mkdir(directory, { recursive: true }); await appendFile(path.join(directory, `${installationId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); });
    this.queues.set(installationId, operation.catch((error) => { console.error("[Desktop plugins] Failed to persist plugin log", error); }));
  }
  async get(installationId: string): Promise<LocalPluginLogEntry[]> {
    await this.queues.get(installationId);
    let file;
    try { file = await open(path.join(this.userDataPath, "desktop-plugins", "logs", `${installationId}.jsonl`), "r"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - 256 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      return lines.filter(Boolean).slice(-500).map((line) => LocalPluginLogEntrySchema.parse(JSON.parse(line)));
    } finally { await file.close(); }
  }
}
