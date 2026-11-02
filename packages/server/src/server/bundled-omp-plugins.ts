import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { execCommand, spawnProcess } from "../utils/spawn.js";
import type { AgentInitializationPhase } from "@omp-desktop/protocol/messages";
import {
  createProviderEnv,
  mergeRuntimeSettings,
  resolveProviderCommandPrefix,
  toRuntimeSettings,
  type ProviderOverride,
  type ProviderRuntimeSettings,
} from "./agent/provider-launch-config.js";
import {
  createBundledOmpHostVerifier,
  createSha256FileCache,
  BUNDLED_OMP_HOST,
  hasBundledOmpPlugins,
  sha256RegularFile,
  type BundledOmpHostVerifier,
  type Sha256FileHasher,
} from "./bundled-omp-host.js";

const PLUGIN_NAMES = [
  "omp-bridge-chatpro",
  "omp-workbuddy-plugin",
  "omp-wechat-connector",
] as const;
const OWNER = "omp-desktop-private-bundled-plugins-v1\n";
const NAMESPACE = "desktop-bundled-plugins";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z
  .object({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024 * 1024),
  })
  .strict();
const pluginSchema = z
  .object({
    name: z.enum(PLUGIN_NAMES),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    directory: z.enum(PLUGIN_NAMES),
    files: z.array(fileSchema).min(1).max(100_000),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    host: z
      .object({
        version: z.literal(BUNDLED_OMP_HOST.version),
        sha256: z.literal(BUNDLED_OMP_HOST.sha256),
        platform: z.literal(BUNDLED_OMP_HOST.platform),
        arch: z.literal(BUNDLED_OMP_HOST.arch),
      })
      .strict(),
    plugins: z.array(pluginSchema).length(PLUGIN_NAMES.length),
  })
  .strict();
const stateSchema = z.enum([
  "pending",
  "linking",
  "completed",
  "preserved",
  "uninstalled",
  "failed",
]);
const entrySchema = z
  .object({
    state: stateSchema,
    version: z.string(),
    manifestSha256: digestSchema,
    packageSha256: digestSchema,
    error: z.string().optional(),
  })
  .strict();
const ledgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    plugins: z.record(z.enum(PLUGIN_NAMES), entrySchema),
  })
  .strict();
type Plugin = z.infer<typeof pluginSchema>;
type Ledger = z.infer<typeof ledgerSchema>;
type SeedEntry = z.infer<typeof entrySchema>;

// Cache content hashes, never a validation success: every invocation still
// walks the complete inventory and checks file identities and metadata.
let cachedPayload:
  | {
      root: string;
      manifestSha256: string;
      hashFile: Sha256FileHasher;
    }
  | undefined;

export interface BundledOmpProvisioningResult {
  /** These are seeding-history outcomes, not a replacement native plugin registry. */
  plugins: Array<{ name: string; state: SeedEntry["state"]; error?: string }>;
}

export interface ValidatedBundledOmpPayload {
  manifest: z.infer<typeof manifestSchema>;
  manifestSha256: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Windows aliases, ADS, dot segments and case-fold collisions must not escape the inventory. */
function assertSafeRelativePath(path: string): void {
  let invalid = path.includes("\\");
  for (const part of path.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[<>:"|?*]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(part)
    ) {
      invalid = true;
      break;
    }
    for (let index = 0; index < part.length; index++) {
      const code = part.charCodeAt(index);
      if (code < 32 || code === 127) {
        invalid = true;
        break;
      }
    }
    if (invalid) break;
  }
  if (invalid) throw new Error(`Unsafe bundled plugin file path: ${path}`);
}

async function regularPath(root: string, relative: string): Promise<string> {
  assertSafeRelativePath(relative);
  const parts = relative.split("/");
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const info = await lstat(file);
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    ) {
      throw new Error(`Bundled plugin payload contains a non-regular file or symlink: ${file}`);
    }
  }
  return file;
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Bundled plugin directory must not be a symlink: ${path}`);
  }
}

async function verifyPackage(
  root: string,
  plugin: Plugin,
  hashFile: Sha256FileHasher = sha256RegularFile,
): Promise<void> {
  await assertDirectory(root);
  const expected = new Map<string, z.infer<typeof fileSchema>>();
  const folded = new Set<string>();
  for (const file of plugin.files) {
    assertSafeRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (folded.has(key)) throw new Error(`Duplicate bundled plugin file: ${file.path}`);
    folded.add(key);
    expected.set(file.path, file);
  }
  const visited = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      assertSafeRelativePath(path);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`Symlink in bundled plugin package: ${path}`);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile() && expected.has(path)) {
        const file = expected.get(path)!;
        if (info.size !== file.bytes || (await hashFile(join(root, path))) !== file.sha256) {
          throw new Error(`Bundled plugin integrity check failed: ${plugin.name}/${path}`);
        }
        visited.add(path);
      } else {
        throw new Error(`Unmanifested or non-regular bundled plugin path: ${plugin.name}/${path}`);
      }
    }
  };
  await visit("");
  if (visited.size !== expected.size)
    throw new Error(`Bundled plugin files are missing: ${plugin.name}`);
  const packagePath = await regularPath(root, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    omp?: unknown;
    pi?: unknown;
  };
  if (pkg.name !== plugin.name || pkg.version !== plugin.version || (!pkg.omp && !pkg.pi)) {
    throw new Error(
      `Bundled package identity or native plugin manifest is invalid: ${plugin.name}`,
    );
  }
}

/** Validate the complete payload before any native plugin state can change. */
export async function validateBundledOmpPayload(
  payload: string,
): Promise<ValidatedBundledOmpPayload> {
  if (!isAbsolute(payload))
    throw new Error("OMP_DESKTOP_BUNDLED_PLUGINS must be an absolute directory.");
  await assertDirectory(payload);
  const manifestPath = await regularPath(payload, "manifest.json");
  if ((await lstat(manifestPath)).size > 32 * 1024 * 1024)
    throw new Error("Bundled plugin manifest is too large.");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const manifestSha256 = digest(raw);
  let verification = cachedPayload;
  if (
    !verification ||
    verification.root !== payload ||
    verification.manifestSha256 !== manifestSha256
  ) {
    verification = { root: payload, manifestSha256, hashFile: createSha256FileCache() };
    cachedPayload = verification;
  }
  const names = new Set<string>();
  for (const plugin of manifest.plugins) {
    if (plugin.directory !== plugin.name || names.has(plugin.name))
      throw new Error(
        "Bundled plugin manifest contains duplicate or mismatched package directories.",
      );
    names.add(plugin.name);
    await verifyPackage(join(payload, plugin.directory), plugin, verification.hashFile);
  }
  for (const item of await readdir(payload)) {
    if (item !== "manifest.json" && !names.has(item))
      throw new Error(`Unmanifested bundled payload entry: ${item}`);
  }
  return { manifest, manifestSha256 };
}

async function atomicJson(file: string, value: unknown, assertHeld: () => void): Promise<void> {
  assertHeld();
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertHeld();
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function ownedNamespace(profileRoot: string, assertHeld: () => void): Promise<string> {
  await mkdir(profileRoot, { recursive: true });
  const canonicalRoot = await realpath(profileRoot);
  const namespace = join(canonicalRoot, NAMESPACE);
  try {
    await lstat(namespace);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const stage = join(canonicalRoot, `.${NAMESPACE}-${randomUUID()}.tmp`);
    await mkdir(stage, { mode: 0o700 });
    try {
      const marker = await open(join(stage, "owner"), "wx", 0o600);
      try {
        await marker.writeFile(OWNER);
        await marker.sync();
      } finally {
        await marker.close();
      }
      // Publish only a fully owned namespace; interrupted writes stay unpublished.
      assertHeld();
      await rename(stage, namespace);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  await assertDirectory(namespace);
  const markerPath = await regularPath(namespace, "owner");
  if ((await readFile(markerPath, "utf8")) !== OWNER)
    throw new Error(`Refusing to adopt an unowned bundled plugin directory: ${namespace}`);
  return namespace;
}

interface ProvisioningLease {
  assertHeld: () => void;
  signal: AbortSignal;
  release: () => Promise<void>;
}

const nativePathsSchema = z
  .object({
    dataRoot: z.string().refine(isAbsolute, "Native OMP dataRoot must be absolute"),
    pluginsRoot: z.string().refine(isAbsolute, "Native OMP pluginsRoot must be absolute"),
  })
  .strict();
const leaseReceiptSchema = z
  .object({
    lease: z.object({ version: z.literal(1), kind: z.literal("desktop-bundled-plugins") }).strict(),
    paths: nativePathsSchema,
  })
  .strict();

async function sameNativePaths(
  left: z.infer<typeof nativePathsSchema>,
  right: z.infer<typeof nativePathsSchema>,
): Promise<boolean> {
  return (
    (await realpath(left.dataRoot)) === (await realpath(right.dataRoot)) &&
    (await realpath(left.pluginsRoot)) === (await realpath(right.pluginsRoot))
  );
}

/** The protected native child, never a PID file, owns the cross-process lease. */
async function acquireProvisioningLease(
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv,
  cwd: string,
  paths: z.infer<typeof nativePathsSchema>,
  hostVerifier: BundledOmpHostVerifier,
): Promise<ProvisioningLease> {
  await hostVerifier(command[0], env);
  const child = spawnProcess(command[0], [...command.slice(1), "plugin", "lease", "--json"], {
    envMode: "internal",
    env,
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  let failure: Error | undefined;
  let releasing = false;
  let closed = false;
  let receiptSeen = false;
  let output = "";
  let outputBytes = 0;
  // This workspace targets ES2023, before Promise.withResolvers is available.
  let resolveReceipt!: (value: unknown) => void;
  let rejectReceipt!: (error: Error) => void;
  const receipt = new Promise<unknown>((resolve, reject) => {
    resolveReceipt = resolve;
    rejectReceipt = reject;
  });
  const fail = () => {
    failure ??= new Error(
      "Native OMP bundled-plugin provisioning lease was lost. No automatic retry was performed.",
    );
    controller.abort();
    rejectReceipt(failure);
  };
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  child.once("exit", (code, signal) => {
    if (!releasing || code !== 0 || signal !== null) fail();
  });
  child.once("error", fail);
  child.stdin!.on("error", fail);
  child.stderr!.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 16 * 1024) {
      fail();
      child.kill();
    }
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 16 * 1024 || receiptSeen) {
      fail();
      child.kill();
      return;
    }
    output += chunk;
    const newline = output.indexOf("\n");
    if (newline === -1) return;
    try {
      if (output.slice(newline + 1).length) throw new Error("Unexpected lease output");
      const parsed: unknown = JSON.parse(output.slice(0, newline));
      receiptSeen = true;
      resolveReceipt(parsed);
    } catch {
      fail();
      child.kill();
    }
  });
  const assertHeld = () => {
    if (failure || closed || child.exitCode !== null || child.signalCode !== null) {
      throw failure ?? new Error("Native OMP bundled-plugin provisioning lease is no longer held.");
    }
  };
  const waitForClose = async (milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native OMP provisioning lease did not exit.")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const release = async () => {
    try {
      assertHeld();
    } catch (error) {
      failure ??= error as Error;
    }
    releasing = true;
    if (!closed) child.stdin!.end();
    try {
      await waitForClose(5_000);
    } catch (error) {
      child.kill();
      await waitForClose(5_000);
      throw error;
    }
    if (failure) throw failure;
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const raw = await Promise.race([
      receipt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out acquiring native OMP provisioning lease.")),
          60_000,
        );
      }),
    ]);
    const parsed = leaseReceiptSchema.parse(raw);
    if (!(await sameNativePaths(parsed.paths, paths)))
      throw new Error("Native OMP lease resolved different profile paths.");
    assertHeld();
    return { assertHeld, signal: controller.signal, release };
  } catch (error) {
    releasing = true;
    child.stdin!.end();
    child.kill();
    await waitForClose(5_000);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return z.record(z.string(), z.unknown()).parse(value);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function nativeReservations(pluginsRoot: string): Promise<Set<string>> {
  const names = new Set<string>();
  // Read-only protection for broken/disabled installs that native list cannot resolve.
  for (const [file, key] of [
    ["package.json", "dependencies"],
    ["omp-plugins.lock.json", "plugins"],
    ["installed_plugins.json", "plugins"],
  ] as const) {
    const object = await readObject(join(pluginsRoot, file));
    if (object?.[key] === undefined) continue;
    const entries = z.record(z.string(), z.unknown()).parse(object[key]);
    for (const name of Object.keys(entries))
      names.add(
        file === "installed_plugins.json"
          ? name.slice(0, name.lastIndexOf("@") > 0 ? name.lastIndexOf("@") : undefined)
          : name,
      );
  }
  for (const name of PLUGIN_NAMES) {
    try {
      await lstat(join(pluginsRoot, "node_modules", name));
      names.add(name);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return names;
}

const listSchema = z
  .object({
    npm: z.array(
      z
        .object({ name: z.string(), version: z.string(), path: z.string(), enabled: z.boolean() })
        .passthrough(),
    ),
    marketplace: z.array(z.object({ id: z.string() }).passthrough()),
    paths: nativePathsSchema,
  })
  .passthrough();

export interface OmpPluginInvocation {
  command: [string, ...string[]];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Only an explicit leading launch verb belongs to session startup, not management. */
export function normalizeOmpPluginCommand(
  command: readonly [string, ...string[]],
): [string, ...string[]] {
  return [command[0], ...command.slice(command[1] === "launch" ? 2 : 1)];
}

/** Use the provider's existing command/env rules; native initialization owns dotenv/profile resolution. */
export async function resolveOmpPluginInvocation(options: {
  provider?: ProviderOverride;
  runtimeSettings?: ProviderRuntimeSettings;
  env?: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<OmpPluginInvocation> {
  const baseEnv = options.env ?? process.env;
  const settings = mergeRuntimeSettings(options.runtimeSettings, toRuntimeSettings(options.provider));
  const prefix = await resolveProviderCommandPrefix(
    settings?.command,
    () => baseEnv.OMP_COMMAND?.trim() || "omp",
  );
  return {
    command: normalizeOmpPluginCommand([prefix.command, ...prefix.args]),
    env: createProviderEnv({ baseEnv, runtimeSettings: settings }),
    cwd: options.cwd,
  };
}

const linkOutcomeSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false), preserved: z.literal(true), name: z.string() }),
  z.object({
    linked: z.literal(true),
    preserved: z.literal(false),
    name: z.string(),
    plugin: listSchema.shape.npm.element,
  }),
]);

/** Validate the native committing receipt before recording a completed seed. */
async function confirmNativeLink(
  outcome: z.infer<typeof linkOutcomeSchema>,
  plugin: Plugin,
  target: string,
): Promise<"completed" | "preserved"> {
  if (outcome.name !== plugin.name) {
    throw new Error(`Native OMP returned a different plugin identity for ${plugin.name}.`);
  }
  if (!outcome.linked) return "preserved";
  if (
    outcome.plugin.version !== plugin.version ||
    !outcome.plugin.enabled ||
    (await realpath(outcome.plugin.path)) !== (await realpath(target))
  ) {
    throw new Error(`Native OMP did not confirm the linked ${plugin.name} package.`);
  }
  return "completed";
}

async function listNative(
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
) {
  const { stdout } = await execCommand(
    command[0],
    [...command.slice(1), "plugin", "list", "--json"],
    {
      envMode: "internal",
      env,
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    },
  );
  return listSchema.parse(JSON.parse(stdout.trim()));
}

/** Copy one regular source through owned handles without following a replaced symlink. */
async function copyRegularFile(source: string, target: string): Promise<void> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await input.stat()).isFile())
      throw new Error(`Bundled source changed during staging: ${source}`);
    const output = await open(target, "wx", 0o600);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function loadSeedLedger(
  namespace: string,
  plugins: readonly Plugin[],
  manifestSha256: string,
  assertHeld: () => void,
): Promise<Ledger> {
  const ledgerFile = join(namespace, "ledger.json");
  try {
    await regularPath(namespace, "ledger.json");
    return ledgerSchema.parse(JSON.parse(await readFile(ledgerFile, "utf8")));
  } catch (readFailure) {
    if (!isMissing(readFailure)) {
      throw new Error(
        `Bundled plugin ledger is unreadable or corrupt: ${ledgerFile}. Restore it rather than deleting it; it preserves uninstall choices.`,
        { cause: readFailure },
      );
    }
    try {
      if ((await readdir(join(namespace, "packages"))).length) {
        throw new Error(
          "Bundled plugin ledger is missing but snapshots exist. Restore the ledger; automatic reseeding is unsafe.",
          { cause: readFailure },
        );
      }
    } catch (snapshotFailure) {
      if (!isMissing(snapshotFailure)) throw snapshotFailure;
    }
  }
  const ledger: Ledger = {
    schemaVersion: 1,
    plugins: Object.fromEntries(
      plugins.map((plugin) => [
        plugin.name,
        {
          state: "pending",
          version: plugin.version,
          manifestSha256,
          packageSha256: digest(JSON.stringify(plugin)),
        },
      ]),
    ) as Ledger["plugins"],
  };
  await atomicJson(ledgerFile, ledger, assertHeld);
  return ledger;
}

/** Reconcile only a previous intent; this transition never authorizes another link. */
async function reconcilePreviousSeed(
  entry: SeedEntry,
  present: boolean,
  ledgerFile: string,
  ledger: Ledger,
  assertHeld: () => void,
): Promise<void> {
  const previousState = entry.state;
  const previousError = entry.error;
  if (entry.state === "linking") {
    entry.state = "failed";
    entry.error =
      "A previous seed attempt was interrupted. Automatic relinking is disabled to preserve user choices; use the normal Plugins page to manage this plugin.";
  }
  if (entry.state === "completed" && !present) entry.state = "uninstalled";
  if (entry.state === "failed" && present) {
    entry.state = "preserved";
    delete entry.error;
  }
  // An uninstall tombstone is permanent even if the user later installs manually.
  if (entry.state !== previousState || entry.error !== previousError) {
    await atomicJson(ledgerFile, ledger, assertHeld);
  }
}

async function stagePackage(
  namespace: string,
  payload: string,
  plugin: Plugin,
  packageSha256: string,
  assertHeld: () => void,
): Promise<string> {
  const packages = join(namespace, "packages");
  await mkdir(packages, { recursive: true, mode: 0o700 });
  await assertDirectory(packages);
  const destination = join(packages, `${plugin.name}-${packageSha256}`);
  try {
    await lstat(destination);
    await verifyPackage(destination, plugin);
    return destination;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const stage = join(packages, `.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const file of plugin.files) {
      const source = await regularPath(join(payload, plugin.directory), file.path);
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyRegularFile(source, target);
    }
    await verifyPackage(stage, plugin);
    // Service-owned snapshots are never edited/replaced by future app updates.
    // Executable bits stay available for packaged helper programs on Windows.
    for (const file of plugin.files) await chmod(join(stage, file.path), 0o555);
    // Windows readers can briefly deny delete sharing. Retry only this unpublished
    // owned-directory move, never a possibly committed native plugin mutation.
    for (let attempt = 0; ; attempt += 1) {
      assertHeld();
      try {
        await rename(stage, destination);
        return destination;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          (error as NodeJS.ErrnoException).code !== "EPERM" ||
          attempt === 7
        ) {
          throw error;
        }
        await delay(25 * 2 ** attempt);
      }
    }
  } finally {
    // Only this invocation's freshly allocated stage is eligible for cleanup.
    await rm(stage, { recursive: true, force: true });
  }
}

async function verifyProvisioningPayload(
  payload: string,
  command: string,
  env: NodeJS.ProcessEnv,
  hostVerifier: BundledOmpHostVerifier,
  onProgress: ((phase: AgentInitializationPhase) => void) | undefined,
): Promise<ValidatedBundledOmpPayload> {
  onProgress?.("verifying");
  await hostVerifier(command, env);
  const validated = await validateBundledOmpPayload(payload).catch((error: unknown) => {
    throw new Error(
      `Bundled plugin payload at ${payload} is missing, corrupt or incompatible. Reinstall the compatible private Desktop package. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  onProgress?.("preparing");
  return validated;
}

/** Also called before each provider launch, using that launch's exact cwd/env/command prefix. */
export async function provisionBundledOmpPlugins(
  options: {
    env?: NodeJS.ProcessEnv;
    command?: [string, ...string[]];
    cwd?: string;
    hostVerifier?: BundledOmpHostVerifier;
    onProgress?: (phase: AgentInitializationPhase) => void;
  } = {},
): Promise<BundledOmpProvisioningResult> {
  const env = { ...(options.env ?? process.env) };
  if (!hasBundledOmpPlugins(env)) return { plugins: [] };
  const payload = env.OMP_DESKTOP_BUNDLED_PLUGINS!.trim();
  const command = normalizeOmpPluginCommand(options.command ?? [env.OMP_COMMAND?.trim() || "omp"]);
  const cwd = options.cwd ?? process.cwd();
  const hostVerifier = options.hostVerifier ?? createBundledOmpHostVerifier();
  const { manifest, manifestSha256 } = await verifyProvisioningPayload(
    payload,
    command[0],
    env,
    hostVerifier,
    options.onProgress,
  );
  let listed = await listNative(command, env, cwd);
  const profileRoot = listed.paths.dataRoot;
  const pluginsRoot = listed.paths.pluginsRoot;
  const lease = await acquireProvisioningLease(command, env, cwd, listed.paths, hostVerifier);
  try {
    lease.assertHeld();
    const namespace = await ownedNamespace(profileRoot, lease.assertHeld);
    lease.assertHeld();
    // Another process may have seeded while this invocation waited for its lease.
    listed = await listNative(command, env, cwd, lease.signal);
    lease.assertHeld();
    if (!(await sameNativePaths(listed.paths, { dataRoot: profileRoot, pluginsRoot }))) {
      throw new Error(
        "Native OMP profile paths changed during provisioning. Retry with stable provider environment and dotenv files.",
      );
    }
    const ledgerFile = join(namespace, "ledger.json");
    const ledger = await loadSeedLedger(
      namespace,
      manifest.plugins,
      manifestSha256,
      lease.assertHeld,
    );
    for (const plugin of manifest.plugins) {
      lease.assertHeld();
      const entry = ledger.plugins[plugin.name];
      const reservations = await nativeReservations(pluginsRoot);
      const native = listed.npm.find((item) => item.name === plugin.name);
      const marketplace = listed.marketplace.some(
        (item) => item.id.slice(0, item.id.lastIndexOf("@")) === plugin.name,
      );
      const present = native !== undefined || marketplace || reservations.has(plugin.name);
      if (entry.state !== "pending") {
        await reconcilePreviousSeed(entry, present, ledgerFile, ledger, lease.assertHeld);
        continue;
      }
      // A pending entry from an older application keeps its original version choice.
      if (entry.packageSha256 !== digest(JSON.stringify(plugin))) {
        entry.state = "failed";
        entry.error =
          "The payload changed before first provisioning completed. Use the normal Plugins page for an explicit installation; no automatic upgrade was performed.";
        await atomicJson(ledgerFile, ledger, lease.assertHeld);
        continue;
      }
      try {
        options.onProgress?.("installing");
        const target = await stagePackage(
          namespace,
          payload,
          plugin,
          entry.packageSha256,
          lease.assertHeld,
        );
        lease.assertHeld();
        // This durable intent must precede the potentially committing native operation.
        entry.state = "linking";
        await atomicJson(ledgerFile, ledger, lease.assertHeld);
        // The native manager arbitrates every reservation under the SAME lock as
        // ordinary installs/config changes. A preflight list can never authorize replacement.
        await hostVerifier(command[0], env);
        lease.assertHeld();
        const { stdout } = await execCommand(
          command[0],
          [...command.slice(1), "plugin", "link", target, "--if-missing", "--json"],
          {
            envMode: "internal",
            env,
            cwd,
            timeout: 60_000,
            maxBuffer: 8 * 1024 * 1024,
            signal: lease.signal,
          },
        );
        lease.assertHeld();
        const outcome = linkOutcomeSchema.parse(JSON.parse(stdout.trim()));
        entry.state = await confirmNativeLink(outcome, plugin, target);
        listed = await listNative(command, env, cwd, lease.signal);
        lease.assertHeld();
        delete entry.error;
      } catch (error) {
        // A dead lease cannot authorize any further ledger writes, even failure.
        lease.assertHeld();
        entry.state = "failed";
        entry.error = `Automatic seed failed: ${error instanceof Error ? error.message : String(error)}. No automatic retry will replace user state. Use the normal Plugins page for explicit installation.`;
      }
      await atomicJson(ledgerFile, ledger, lease.assertHeld);
    }
    const plugins: BundledOmpProvisioningResult["plugins"] = [];
    for (const name of PLUGIN_NAMES) {
      const entry = ledger.plugins[name];
      const outcome: BundledOmpProvisioningResult["plugins"][number] = { name, state: entry.state };
      if (entry.error) outcome.error = entry.error;
      plugins.push(outcome);
    }
    return { plugins };
  } finally {
    await lease.release();
  }
}
