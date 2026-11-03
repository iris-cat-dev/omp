import { existsSync } from "node:fs";
import path from "node:path";
import type { RemoteSshTarget } from "./types.js";
import { RemoteSshTargetSchema } from "./types.js";

export interface RemoteTargetInfo {
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  home: string;
}

export function parseRemoteTargetInfo(value: string): RemoteTargetInfo {
  const [system, machine, encodedHome, libc] = value.trim().split("|");
  const platform = system === "Linux" ? "linux" : system === "Darwin" ? "darwin" : null;
  const arch = machine === "x86_64" ? "x64" : machine === "arm64" || machine === "aarch64" ? "arm64" : null;
  if (!platform || !arch || !encodedHome) {
    throw new Error(`Unsupported SSH host platform: ${system || "unknown"} ${machine || "unknown"}`);
  }
  if (platform === "linux" && !libc?.startsWith("glibc ")) {
    throw new Error(`Unsupported SSH host libc: ${libc || "unknown"}. Linux remote hosts require glibc; musl is unsupported.`);
  }
  return { platform, arch, home: Buffer.from(encodedHome, "base64").toString("utf8") };
}

export interface SshArgumentOptions {
  tty?: boolean;
  controlPath?: string;
  controlMaster?: boolean;
  batchMode?: boolean;
}

export function resolveSshExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (filePath: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "ssh";

  const pathDirectories = (env.Path ?? env.PATH ?? "")
    .split(path.win32.delimiter)
    .map((directory) => directory.replace(/^"(.*)"$/u, "$1"))
    .filter(Boolean);
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  const directories = systemRoot
    ? [...pathDirectories, path.win32.join(systemRoot, "System32", "OpenSSH")]
    : pathDirectories;
  for (const directory of directories) {
    const candidate = path.win32.join(directory, "ssh.exe");
    if (fileExists(candidate)) return candidate;
  }
  throw new Error("OpenSSH client not found. Install the Windows OpenSSH Client feature.");
}

export function buildSshArguments(
  input: RemoteSshTarget,
  options: SshArgumentOptions = {},
): string[] {
  const target = RemoteSshTargetSchema.parse(input);
  const args = [
    "-o",
    "ConnectTimeout=30",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ];
  if (options.controlPath) args.push("-S", options.controlPath);
  if (options.controlMaster) args.push("-M", "-o", "ControlPersist=no");
  if (options.batchMode) args.push("-o", "BatchMode=yes");
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.identityFile) args.push("-i", target.identityFile);
  args.push(
    options.tty === false ? "-T" : "-tt",
    target.username ? `${target.username}@${target.host}` : target.host,
  );
  return args;
}
