import { Buffer } from "node:buffer";

type PluginLogStream = "stdout" | "stderr";
interface PluginOutputChild {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: () => void): unknown;
}
const MAX_LOG_LINE_BYTES = 16 * 1024;

export class PluginOutputCapture {
  private readonly pending = new Map<PluginLogStream, Buffer>([
    ["stdout", Buffer.alloc(0)], ["stderr", Buffer.alloc(0)],
  ]);
  private readonly overflowed = new Set<PluginLogStream>();
  private readonly lastActivity = new Map<PluginLogStream, number>();
  private activitySequence = 0;
  private flushed = false;

  constructor(child: PluginOutputChild, private readonly emit: (stream: PluginLogStream, message: string, truncated: boolean) => void) {
    child.stdout?.on("data", chunk => this.write("stdout", chunk));
    child.stderr?.on("data", chunk => this.write("stderr", chunk));
    child.on("close", () => this.flush());
  }

  private write(stream: PluginLogStream, chunk: Buffer | string): void {
    if (this.flushed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(0x0a, offset);
      const end = newline === -1 ? data.length : newline;
      this.append(stream, data.subarray(offset, end));
      if (newline === -1) return;
      this.emitLine(stream);
      offset = newline + 1;
    }
  }

  private append(stream: PluginLogStream, chunk: Buffer): void {
    if (chunk.length > 0) this.lastActivity.set(stream, ++this.activitySequence);
    const current = this.pending.get(stream)!;
    const remaining = MAX_LOG_LINE_BYTES - current.length;
    if (chunk.length > remaining) this.overflowed.add(stream);
    if (remaining <= 0) return;
    this.pending.set(stream, Buffer.concat([current, chunk.subarray(0, remaining)]));
  }

  private emitLine(stream: PluginLogStream): void {
    let line = this.pending.get(stream)!;
    const truncated = this.overflowed.has(stream);
    if (!truncated && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    this.emit(stream, line.toString("utf8"), truncated);
    this.pending.set(stream, Buffer.alloc(0));
    this.overflowed.delete(stream);
    this.lastActivity.delete(stream);
  }

  private flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    const pendingStreams = (["stdout", "stderr"] as const)
      .filter(stream => this.pending.get(stream)!.length > 0 || this.overflowed.has(stream))
      .sort((left, right) => this.lastActivity.get(left)! - this.lastActivity.get(right)!);
    for (const stream of pendingStreams) this.emitLine(stream);
  }
}
