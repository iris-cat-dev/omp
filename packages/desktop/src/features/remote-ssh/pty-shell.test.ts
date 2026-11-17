import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MarkerBuffer } from "./marker-buffer.js";
import { PtyShellCommands, type PtyShellTransport } from "./pty-shell.js";

function findShell(): string {
  const executable = process.platform === "win32" ? "sh.exe" : "sh";
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, executable));
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (root) candidates.push(path.join(root, "Git", "bin", "sh.exe"));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "sh.exe"));
    }
  }
  const shellPath = candidates.find((candidate) => existsSync(candidate));
  if (!shellPath)
    throw new Error("PTY shell regression tests require POSIX sh on PATH (or Git for Windows)");
  return shellPath;
}

function remotePath(localPath: string): string {
  const normalized = localPath.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hash(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

class ShellTransport implements PtyShellTransport {
  readonly process: ChildProcessWithoutNullStreams;
  readonly commands = new PtyShellCommands(this);
  readonly writes: string[] = [];
  readonly outputLines: string[] = [];
  gateReply?: (index: number, block: string) => Promise<string>;
  private readonly markers = new MarkerBuffer();
  private replies = 0;
  private output = "";

  constructor() {
    const executable = findShell();
    const shellDirectory = path.dirname(executable);
    this.process = spawn(executable, ["-s"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: [
          shellDirectory,
          path.resolve(shellDirectory, "../usr/bin"),
          process.env.PATH ?? "",
        ].join(path.delimiter),
      },
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (data: string) => {
      this.output += data;
      let newline: number;
      while ((newline = this.output.indexOf("\n")) >= 0) {
        this.outputLines.push(this.output.slice(0, newline));
        this.output = this.output.slice(newline + 1);
      }
      // ConPTY produces CRLF and may split any marker or encoded output chunk.
      const terminalOutput = data.replaceAll("\n", "\r\n");
      for (let offset = 0; offset < terminalOutput.length; offset += 17) {
        this.markers.push(terminalOutput.slice(offset, offset + 17));
      }
    });
    this.process.stderr.on("data", (data: Buffer) => this.markers.push(data.toString("utf8")));
    this.process.once("error", (error) => this.markers.rejectAll(error));
    this.process.once("close", () => this.markers.rejectAll(new Error("Shell session closed")));
    this.process.stdin.on("error", (error) => this.markers.rejectAll(error));
  }

  writeCommand(command: string): void {
    this.writes.push(command);
    // Pipes use LF; the production PTY's CR is translated to LF by the terminal.
    this.process.stdin.write(`${command}\n`);
  }

  async waitForBlock(start: string, end: string, timeoutMs?: number): Promise<string> {
    expect(start.length).toBeLessThan(100);
    expect(end.length).toBeLessThan(100);
    const index = ++this.replies;
    const block = await this.markers.waitForBlock(start, end, timeoutMs);
    return this.gateReply ? this.gateReply(index, block) : block;
  }

  assertTerminalSafe(): void {
    for (const command of this.writes) {
      for (const line of command.split("\n")) {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024);
      }
    }
    for (const line of this.outputLines) expect(line.length).toBeLessThanOrEqual(76);
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const closed = Promise.withResolvers<void>();
    this.process.once("close", () => closed.resolve());
    this.process.stdin.end();
    await closed.promise;
  }
}

const shells: ShellTransport[] = [];
const directories: string[] = [];

function shell(): ShellTransport {
  const transport = new ShellTransport();
  shells.push(transport);
  return transport;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-pty-shell-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(shells.splice(0).map((transport) => transport.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PtyShellCommands over a real POSIX shell", () => {
  it("isolates exit and shell state, reports errors, and reuses the same session", async () => {
    const transport = shell();
    await expect(
      transport.commands.executeCommand("printf 'failure details' >&2; exit 23"),
    ).rejects.toThrow("Remote command failed (exit 23): failure details");
    await expect(
      transport.commands.executeCommand("OMP_PRIVATE_VALUE=changed; cd /; exit 0"),
    ).resolves.toBe("");
    await expect(
      transport.commands.executeCommand("printf '%s' \"${OMP_PRIVATE_VALUE-unset}\""),
    ).resolves.toBe("unset");
    await expect(
      transport.commands.executeCommand("printf 'still connected'; printf ' with stderr' >&2"),
    ).resolves.toBe("still connected");
    transport.assertTerminalSafe();
  });

  it("bounds stdout and stderr separately while keeping successful stdout clean", async () => {
    const transport = shell();
    await expect(
      transport.commands.executeCommand(
        "awk 'BEGIN { for (i=0; i<6000; i++) printf \"x\" }'; printf warning >&2",
      ),
    ).resolves.toBe("x".repeat(4096));
    await expect(
      transport.commands.executeCommand(
        "printf discarded; awk 'BEGIN { for (i=0; i<6000; i++) printf \"e\" }' >&2; exit 4",
      ),
    ).rejects.toThrow(`Remote command failed (exit 4): ${"e".repeat(4096)}`);
    transport.assertTerminalSafe();
  });

  it("sends long commands and quoted Unicode without exceeding terminal input lines", async () => {
    const transport = shell();
    const text = `${"'界".repeat(1800)} final`;
    const result = await transport.commands.executeCommand(`printf '%s' ${quote(text)}`);
    expect(result).toBe(Buffer.from(text).subarray(-4096).toString("utf8"));
    transport.assertTerminalSafe();
  });

  it.each([0, 1, 2, 3, 196607, 196608, 196609, 590123])(
    "uploads %i arbitrary binary bytes across encoding and batch boundaries",
    async (length) => {
      const transport = shell();
      const directory = await temporaryDirectory();
      const destination = path.join(directory, "parent's directory", "binary's file.bin");
      const contents = randomBytes(length);
      const source = Readable.from(
        (async function* () {
          yield contents.subarray(0, 1);
          yield contents.subarray(1, 3);
          yield contents.subarray(3);
        })(),
      );
      await transport.commands.uploadFile(remotePath(destination), source, hash(contents));
      expect(await readFile(destination)).toEqual(contents);
      transport.assertTerminalSafe();
    },
    30_000,
  );

  it("truncates once, accepts Buffer input, and does not append an older upload", async () => {
    const transport = shell();
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "replace.bin");
    const first = randomBytes(200000);
    await transport.commands.uploadFile(remotePath(destination), first, hash(first));
    const replacement = Buffer.from([0, 255, 13, 10, 1]);
    await transport.commands.uploadFile(remotePath(destination), replacement, hash(replacement));
    expect(await readFile(destination)).toEqual(replacement);
    transport.assertTerminalSafe();
  }, 30_000);

  it("waits for each batch acknowledgement before consuming more of the stream", async () => {
    const transport = shell();
    const directory = await temporaryDirectory();
    const batch = randomBytes(192 * 1024);
    const allBytes = Buffer.concat([batch, batch, batch, batch]);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let produced = 0;
    transport.gateReply = async (index, block) => {
      if (index === 2) {
        received.resolve();
        await release.promise;
      }
      return block;
    };
    const source = Readable.from(
      (async function* () {
        for (let index = 0; index < 4; index++) {
          produced++;
          yield batch;
        }
      })(),
      { highWaterMark: 1 },
    );
    const uploaded = transport.commands.uploadFile(
      remotePath(path.join(directory, "paced.bin")),
      source,
      hash(allBytes),
    );
    await received.promise;
    try {
      expect(produced).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
      await uploaded;
    }
    expect(await readFile(path.join(directory, "paced.bin"))).toEqual(allBytes);
    transport.assertTerminalSafe();
  }, 30_000);

  it("rejects source failures and leaves the interactive session usable", async () => {
    const transport = shell();
    const directory = await temporaryDirectory();
    const source = Readable.from(
      (async function* () {
        yield randomBytes(192 * 1024);
        throw new Error("source stopped producing bytes");
      })(),
    );
    await expect(
      transport.commands.uploadFile(
        remotePath(path.join(directory, "partial.bin")),
        source,
        "unused",
      ),
    ).rejects.toThrow("source stopped producing bytes");
    await expect(transport.commands.executeCommand("printf recovered")).resolves.toBe("recovered");
    transport.assertTerminalSafe();
  });

  it("rejects checksum mismatches and remote filesystem errors without closing the session", async () => {
    const transport = shell();
    const directory = await temporaryDirectory();
    const destination = path.join(directory, "checksum.bin");
    const contents = Buffer.from("actual contents");
    await expect(
      transport.commands.uploadFile(remotePath(destination), contents, "0".repeat(64)),
    ).rejects.toThrow("Remote upload checksum mismatch");
    await expect(
      transport.commands.uploadFile(
        `${remotePath(destination)}/child.bin`,
        contents,
        hash(contents),
      ),
    ).rejects.toThrow("Remote command failed");
    await expect(transport.commands.executeCommand("printf recovered")).resolves.toBe("recovered");
    transport.assertTerminalSafe();
  });

  it("serializes concurrent operations and continues after a rejected command", async () => {
    const transport = shell();
    const first = transport.commands.executeCommand("printf first-error >&2; exit 9");
    const second = transport.commands.executeCommand("printf second-success");
    await expect(first).rejects.toThrow("first-error");
    await expect(second).resolves.toBe("second-success");
    transport.assertTerminalSafe();
  });
});
