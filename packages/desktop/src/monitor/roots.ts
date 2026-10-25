import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { safeLabel } from "./parser.js";
import type { OmpMonitorRoot } from "./types.js";

export const MAX_ROOTS = 64;

export function filesystemFailure(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && !code.startsWith("ERR_");
}

/** Reject roots reached through a symlink/junction as well as symlink leaf entries. */
export async function regularDirectory(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch (error) {
      if (!filesystemFailure(error)) throw error;
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export interface RootResolution {
  roots: OmpMonitorRoot[];
  limited: boolean;
  unreadable: boolean;
}
export interface OmpRootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}
interface RootContext {
  config: string;
  xdg: string | null;
  defaultAgent: string | null;
  platform: NodeJS.Platform;
}
interface ProfileDiscovery {
  names: Set<string>;
  entryCount: number;
  limited: boolean;
  unreadable: boolean;
}

function rootContext(options: OmpRootOptions): RootContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir();
  const config = path.resolve(home, env.PI_CONFIG_DIR || ".omp");
  const xdg =
    platform === "darwin" && env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME, "omp") : null;
  const defaultAgent = env.PI_CODING_AGENT_DIR
    ? path.resolve(env.PI_CODING_AGENT_DIR.replace(/^~(?=$|[\\/])/, home))
    : null;
  return { config, xdg, defaultAgent, platform };
}

async function defaultSessionRoot(context: RootContext): Promise<string> {
  if (context.defaultAgent) return path.join(context.defaultAgent, "sessions");
  if (context.xdg && (await regularDirectory(context.xdg)))
    return path.join(context.xdg, "sessions");
  return path.join(context.config, "agent", "sessions");
}

async function readProfileFolder(folder: string, profiles: ProfileDiscovery): Promise<void> {
  if (!(await regularDirectory(folder))) return;
  try {
    const entries = await opendir(folder);
    for await (const entry of entries) {
      if (++profiles.entryCount > 4_096) {
        profiles.limited = true;
        break;
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (profiles.names.size >= MAX_ROOTS - 1 && !profiles.names.has(entry.name)) {
        profiles.limited = true;
        break;
      }
      profiles.names.add(entry.name);
    }
  } catch (error) {
    if (!filesystemFailure(error)) throw error;
    profiles.unreadable = true;
  }
}

async function discoverProfiles(context: RootContext): Promise<ProfileDiscovery> {
  const profiles: ProfileDiscovery = {
    names: new Set(),
    entryCount: 0,
    limited: false,
    unreadable: false,
  };
  await readProfileFolder(path.join(context.config, "profiles"), profiles);
  if (context.xdg) await readProfileFolder(path.join(context.xdg, "profiles"), profiles);
  return profiles;
}

async function profileSessionRoot(context: RootContext, name: string): Promise<string> {
  const xdgProfile = context.xdg ? path.join(context.xdg, "profiles", name) : null;
  if (xdgProfile && (await regularDirectory(xdgProfile))) return path.join(xdgProfile, "sessions");
  return path.join(context.config, "profiles", name, "agent", "sessions");
}

function uniqueRoots(roots: OmpMonitorRoot[], platform: NodeJS.Platform): OmpMonitorRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = platform === "win32" ? root.path.toLowerCase() : root.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only OMP's default/named-profile session roots; never other tools or custom-session registries. */
export async function resolveOmpMonitorRoots(
  options: OmpRootOptions = {},
): Promise<RootResolution> {
  const context = rootContext(options);
  const roots: OmpMonitorRoot[] = [{ path: await defaultSessionRoot(context), label: "default" }];
  const profiles = await discoverProfiles(context);
  for (const name of [...profiles.names].sort()) {
    roots.push({
      path: await profileSessionRoot(context, name),
      label: safeLabel(name, "profile"),
    });
  }
  return {
    roots: uniqueRoots(roots, context.platform),
    limited: profiles.limited,
    unreadable: profiles.unreadable,
  };
}
