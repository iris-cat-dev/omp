import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";

export interface PtyShellTransport {
  writeCommand(command: string): void;
  waitForBlock(startMarker: string, endMarker: string, timeoutMs?: number): Promise<string>;
}

const UPLOAD_BATCH_BYTES = 192 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Even shell source must fit the remote terminal's canonical input line limit.
// Adjacent quoted strings separated by escaped newlines preserve the argument.
function quoteShellScript(script: string): string {
  const parts: string[] = [];
  let part = "";
  let length = 0;
  for (const character of script) {
    part += character;
    if (++length === 128) {
      parts.push(shellQuote(part));
      part = "";
      length = 0;
    }
  }
  if (part) parts.push(shellQuote(part));
  return parts.join("\\\n");
}

export class PtyShellCommands {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly transport: PtyShellTransport) {}

  executeCommand(command: string): Promise<string> {
    return this.enqueue(() => this.runCommand(command));
  }

  uploadFile(remotePath: string, contents: Buffer | Readable, expectedHash: string): Promise<void> {
    // Observe source errors even while waiting for the shell or an earlier operation.
    let sourceError: Error | undefined;
    const onSourceError = (error: Error) => {
      sourceError = error;
    };
    if (!Buffer.isBuffer(contents)) contents.on("error", onSourceError);
    return this.enqueue(async () => {
      try {
        if (sourceError) throw sourceError;
        const quotedPath = shellQuote(remotePath);
        await this.runCommand(
          `umask 077; mkdir -p -- ${shellQuote(path.posix.dirname(remotePath))} && : > ${quotedPath}`,
        );
        const batch = Buffer.allocUnsafe(UPLOAD_BATCH_BYTES);
        let used = 0;
        const sendBatch = async () => {
          if (sourceError) throw sourceError;
          const terminator = `OMP_UPLOAD_${randomUUID().replaceAll("-", "")}`;
          const encoded = batch
            .subarray(0, used)
            .toString("base64")
            .replace(/.{1,76}/g, "$&\n");
          await this.runCommand(
            `umask 077; if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; else base64 -D; fi >> ${quotedPath} <<'${terminator}'\n${encoded}${terminator}`,
          );
          used = 0;
        };
        const source = Buffer.isBuffer(contents) ? [contents] : contents;
        for await (const chunk of source) {
          if (sourceError) throw sourceError;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          let offset = 0;
          while (offset < bytes.length) {
            const count = Math.min(batch.length - used, bytes.length - offset);
            bytes.copy(batch, used, offset, offset + count);
            used += count;
            offset += count;
            if (used === batch.length) await sendBatch();
          }
        }
        if (sourceError) throw sourceError;
        if (used) await sendBatch();
        const actualHash = await this.runCommand(
          `if command -v sha256sum >/dev/null 2>&1; then sha256sum < ${quotedPath}; else shasum -a 256 < ${quotedPath}; fi`,
        );
        if (actualHash.trim().split(/\s+/)[0] !== expectedHash) {
          throw new Error(`Remote upload checksum mismatch for ${remotePath}`);
        }
      } finally {
        if (!Buffer.isBuffer(contents)) contents.off("error", onSourceError);
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runCommand(command: string): Promise<string> {
    const token = randomUUID().replaceAll("-", "");
    const start = `__OMP_START_${token}__`;
    const end = `__OMP_END_${token}__`;
    const setupFailure = Buffer.from("Unable to create private remote command output").toString(
      "base64",
    );
    const failSetup = `printf '\\n%s\\n1\\n:\\n%s\\n%s\\n' '${start}' '${setupFailure}' '${end}'; exit 1`;
    const script = [
      "umask 077",
      `omp_output=$(mktemp) || { ${failSetup}; }`,
      `omp_error=$(mktemp) || { rm -f "$omp_output"; ${failSetup}; }`,
      `omp_status=$(mktemp) || { rm -f "$omp_output" "$omp_error"; ${failSetup}; }`,
      `trap 'rm -f "$omp_output" "$omp_error" "$omp_status"' 0`,
      // The outer pipe captures stdout; fd 3 bypasses the inner stderr pipe.
      // Both tails stay bounded on disk, and the status survives both pipelines.
      `if { { /bin/sh -c ${shellQuote(command)} </dev/null 3>&-; printf '%s\\n' "$?" > "$omp_status"; } 2>&1 1>&3 | tail -c 4096 > "$omp_error"; } 3>&1 | tail -c 4096 > "$omp_output"; then`,
      `  IFS= read -r omp_code < "$omp_status" || omp_code=1`,
      "else omp_code=1; fi",
      `printf '\\n%s\\n%s\\n' '${start}' "$omp_code"`,
      `base64 < "$omp_output" | fold -w 76`,
      `printf '\\n:\\n'`,
      `base64 < "$omp_error" | fold -w 76`,
      `printf '\\n%s\\n' '${end}'`,
    ].join("\n");
    const completed = this.transport.waitForBlock(start, end, COMMAND_TIMEOUT_MS);
    try {
      this.transport.writeCommand(`/bin/sh -c ${quoteShellScript(script)}`);
    } catch (error) {
      // A closed transport rejects its registered waiter as well.
      void completed.catch(() => undefined);
      throw error;
    }
    const block = (await completed).trim().split("\n");
    const status = block.shift();
    if (!status || !/^\d+$/.test(status)) throw new Error("Invalid remote command status");
    const separator = block.indexOf(":");
    if (separator < 0) throw new Error("Invalid remote command output");
    const output = Buffer.from(block.slice(0, separator).join(""), "base64").toString("utf8");
    const error = Buffer.from(block.slice(separator + 1).join(""), "base64").toString("utf8");
    if (status !== "0") {
      throw new Error(
        `Remote command failed (exit ${status}): ${error.trim() || output.trim() || "no error output"}`,
      );
    }
    return output;
  }
}
