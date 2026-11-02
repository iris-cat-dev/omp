import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as pty from "node-pty";
import { MarkerBuffer } from "./marker-buffer.js";
import { buildSshArguments, resolveSshExecutable } from "./target.js";
import type { RemoteSshTarget } from "./types.js";

export interface SshPtySessionOptions {
  target: RemoteSshTarget;
  remoteCommand: string;
  onTerminal: (data: string) => void;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class SshPtySession {
  private readonly markers = new MarkerBuffer();
  private readonly process: pty.IPty;
  private readonly target: RemoteSshTarget;
  private readonly controlPath: string;
  private readonly sshExecutable: string;
  private readonly commands = new Set<ChildProcessWithoutNullStreams>();
  private interactive = true;
  private closed = false;

  constructor(options: SshPtySessionOptions) {
    this.target = options.target;
    this.sshExecutable = resolveSshExecutable();
    this.controlPath = path.join(
      os.tmpdir(),
      `omp-ssh-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    this.process = pty.spawn(
      this.sshExecutable,
      [
        ...buildSshArguments(options.target, {
          controlPath: this.controlPath,
          controlMaster: true,
        }),
        options.remoteCommand,
      ],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: os.homedir(),
        env,
      },
    );
    this.process.onData((data) => {
      this.markers.push(data);
      if (this.interactive) options.onTerminal(data);
    });
    this.process.onExit(({ exitCode, signal }) => {
      this.closed = true;
      for (const command of this.commands) command.kill();
      this.markers.rejectAll(
        new Error(`SSH exited before deployment completed (exit ${exitCode}, signal ${signal})`),
      );
      this.removeControlSocket();
    });
  }

  writeInput(input: string): void {
    if (!this.interactive || this.closed) {
      throw new Error("The SSH session is not accepting interactive input");
    }
    this.process.write(input);
  }

  writeCommand(command: string): void {
    if (this.closed) throw new Error("The SSH session is closed");
    this.process.write(`${command}\r`);
  }

  waitForLine(marker: string, timeoutMs?: number): Promise<string> {
    return this.markers.waitForLine(marker, timeoutMs);
  }

  finishAuthentication(): void {
    this.interactive = false;
  }

  executeCommand(remoteCommand: string): Promise<string> {
    return this.runMultiplexedCommand(remoteCommand);
  }

  async uploadFile(remotePath: string, contents: Buffer | Readable, expectedHash: string): Promise<void> {
    const directory = path.posix.dirname(remotePath);
    const quotedPath = shellQuote(remotePath);
    const remoteCommand = `umask 077; mkdir -p ${shellQuote(directory)} && cat > ${quotedPath} && if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quotedPath} | awk '{print $1}'; else shasum -a 256 ${quotedPath} | awk '{print $1}'; fi`;
    const actualHash = await this.runMultiplexedCommand(remoteCommand, contents);
    if (actualHash.trim() !== expectedHash) {
      throw new Error(`Remote upload checksum mismatch for ${remotePath}`);
    }
  }

  private async runMultiplexedCommand(remoteCommand: string, input?: Buffer | Readable): Promise<string> {
    if (this.closed) throw new Error("The SSH session is closed");
    const child = spawn(
      this.sshExecutable,
      [
        ...buildSshArguments(this.target, {
          tty: false,
          controlPath: this.controlPath,
          batchMode: true,
        }),
        remoteCommand,
      ],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.commands.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout = `${stdout}${data}`.slice(-4096);
    });
    child.stderr.on("data", (data: string) => {
      stderr = `${stderr}${data}`.slice(-4096);
    });
    const completed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `SSH command failed (exit ${code ?? "unknown"}, signal ${signal ?? "none"}): ${stderr.trim() || "no error output"}`,
          ),
        );
      });
    });
    try {
      if (input) {
        await Promise.all([
          completed,
          pipeline(Buffer.isBuffer(input) ? Readable.from([input]) : input, child.stdin),
        ]);
      } else {
        child.stdin.end();
        await completed;
      }
      return stdout;
    } finally {
      this.commands.delete(child);
      if (child.exitCode === null) child.kill();
    }
  }

  private removeControlSocket(): void {
    try {
      unlinkSync(this.controlPath);
    } catch {
      // OpenSSH normally removes its own control socket.
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const command of this.commands) command.kill();
    this.process.kill();
    this.markers.rejectAll(new Error("SSH deployment was cancelled"));
    this.removeControlSocket();
  }
}
