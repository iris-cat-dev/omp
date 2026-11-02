import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  OmpMarketplacePluginInfoSchema,
  OmpPluginDoctorCheckSchema,
  OmpPluginInfoSchema,
  OmpPluginMarketplaceCatalogEntrySchema,
  OmpPluginMarketplaceInfoSchema,
} from "@omp-desktop/protocol/messages";

import type { Logger } from "pino";
import { execCommand } from "../utils/spawn.js";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import {
  provisionBundledOmpPlugins,
  resolveOmpPluginInvocation,
  type OmpPluginInvocation,
} from "./bundled-omp-plugins.js";
import { createBundledOmpHostVerifier, hasBundledOmpPlugins } from "./bundled-omp-host.js";
import {
  createProviderEnv,
  toRuntimeSettings,
  type ProviderOverride,
} from "./agent/provider-launch-config.js";
import {
  resolveOmpBackend,
  resolveOmpSdkInstallation,
} from "./agent/providers/omp/sdk-installation.js";
import { resolveOmpSdkHostCommand } from "./agent/providers/omp/sdk-host-command.js";
import { OMP_SDK_ROOT_ENV } from "./agent/providers/omp/sdk-host-protocol.js";

/**
 * Thin wrapper around the selected OMP runtime's own plugin command.
 *
 * The OMP runtime owns discovery, manifests, feature gating and health checks.
 * Desktop runs its command in a dedicated SDK host or CLI process and normalizes
 * the output. No plugin format, state store or loader is implemented here.
 */

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const ACTION_TIMEOUT_MS = 60 * 1000;
const DOCTOR_TIMEOUT_MS = 120 * 1000;
const MARKETPLACE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 8 * 1024;

export type OmpPluginRunner = (
  command: string,
  args: string[],
  options: { timeout: number; cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** Minimal surface the service needs so tests can stub the runner. */
export interface OmpPluginCliServiceOptions {
  logger: Logger;
  /** Defaults to the real execCommand-backed runner. */
  runner?: OmpPluginRunner;
  /** Defaults to resolving `omp` via OMP_COMMAND env or PATH lookup. */
  resolveOmpCommand?: () => Promise<string | null>;
  /**
   * Overrides the omp marketplaces registry location for tests. Defaults to
   * `~/.omp/marketplaces.json` (the runtime's own config root).
   */
  marketplacesRegistryPath?: string;
  /** Live provider settings; management must target the same profile as sessions. */
  getProviderConfig?: () => ProviderOverride | undefined;
}

const OmpPluginListJsonSchema = z
  .object({
    // `npm` is required: without it the defaults would accept any object,
    // including the bare plugin object `omp plugin install` prints.
    npm: z.array(OmpPluginInfoSchema),
    marketplace: z.array(OmpMarketplacePluginInfoSchema).default([]),
  })
  .passthrough();

const OmpPluginDoctorJsonSchema = z.array(OmpPluginDoctorCheckSchema);

/** `~/.omp/marketplaces.json` registry: entries with name + sourceUri + catalogPath. */
const OmpMarketplaceRegistryJsonSchema = z
  .object({
    marketplaces: z
      .array(
        z
          .object({
            name: z.string().min(1),
            sourceUri: z.string().optional(),
            catalogPath: z.string(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/** Marketplace catalog file (cache copy): plugins array with catalog metadata. */
const OmpPluginMarketplaceCatalogJsonSchema = z
  .object({
    plugins: z.array(OmpPluginMarketplaceCatalogEntrySchema).default([]),
  })
  .passthrough();

const TrailingJsonSchema = z.object({
  npm: z.array(OmpPluginInfoSchema),
  marketplace: z.array(OmpMarketplacePluginInfoSchema).default([]),
});

function truncateOutput(value: string): string {
  const combined = value.trim();
  return combined.length <= MAX_OUTPUT_CHARS ? combined : combined.slice(-MAX_OUTPUT_CHARS);
}

/** Parses the JSON payload out of CLI stdout even when progress lines precede it. */
function parseTrailingJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lastBrace = trimmed.lastIndexOf("}");
    const lastBracket = trimmed.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);
    if (end === -1) return null;
    const start = trimmed.search(/[[{]/);
    if (start === -1 || start >= end) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function extractPluginName(spec: string): string {
  // "pi-memory@1.2.0" -> "pi-memory"; "@scope/name@2.0.0" -> "@scope/name".
  const atSlash = spec.indexOf("@");
  if (atSlash === 0) {
    const versionAt = spec.indexOf("@", 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

export class OmpPluginUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ?? "OMP CLI is not available on this host");
    this.name = "OmpPluginUnavailableError";
  }
}

export interface OmpPluginListResult {
  plugins: z.infer<typeof OmpPluginInfoSchema>[];
  marketplace: z.infer<typeof OmpMarketplacePluginInfoSchema>[];
  rawOutput?: string;
}

export interface OmpPluginMarketplaceListResult {
  marketplaces: z.infer<typeof OmpPluginMarketplaceInfoSchema>[];
  rawOutput?: string;
}

export interface OmpPluginDoctorResult {
  checks: z.infer<typeof OmpPluginDoctorCheckSchema>[];
  rawOutput?: string;
}

export interface OmpPluginMutateResult {
  ok: boolean;
  plugin?: z.infer<typeof OmpPluginInfoSchema> | null;
  output?: string;
}

function normalizeMarketplacePlugins(
  summaries: z.infer<typeof OmpMarketplacePluginInfoSchema>[],
): z.infer<typeof OmpPluginInfoSchema>[] {
  const plugins: z.infer<typeof OmpPluginInfoSchema>[] = [];
  for (const summary of summaries) {
    const separator = summary.id.lastIndexOf("@");
    const name = separator > 0 ? summary.id.slice(0, separator) : summary.id;
    const entries = summary.entries?.length ? summary.entries : [undefined];
    for (const entry of entries) {
      const scope = entry?.scope ?? summary.scope;
      plugins.push({
        ...entry,
        name,
        id: summary.id,
        version: entry?.version ?? summary.version ?? "",
        path: entry?.installPath,
        scope,
        shadowedBy: scope === "project" ? undefined : summary.shadowedBy,
        // Native installed entries omit `enabled` when enabled. A summary with
        // no installed entry, however, does not establish any enabled state.
        enabled: entry ? (entry.enabled ?? true) : undefined,
      });
    }
  }
  return plugins;
}

export class OmpPluginCliService {
  private readonly logger: Logger;
  private readonly runner: OmpPluginRunner;
  private readonly resolveOmpCommand: () => Promise<string | null>;
  private readonly marketplacesRegistryPath: string | undefined;
  private readonly getProviderConfig: (() => ProviderOverride | undefined) | undefined;
  private inFlight: Promise<unknown> | null = null;

  constructor(options: OmpPluginCliServiceOptions) {
    this.logger = options.logger.child({ module: "omp-plugin-cli" });
    this.getProviderConfig = options.getProviderConfig;
    this.runner =
      options.runner ??
      (async (command, args, runnerOptions) =>
        await execCommand(command, args, {
          timeout: runnerOptions.timeout,
          cwd: runnerOptions.cwd,
          envMode: "internal",
          env: runnerOptions.env,
        }));
    this.resolveOmpCommand =
      options.resolveOmpCommand ??
      (async () => process.env.OMP_COMMAND?.trim() || (await findExecutable("omp")) || null);
    this.marketplacesRegistryPath = options.marketplacesRegistryPath;
  }


  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Concurrent callers (e.g. list + marketplaceList fired together by the UI)
    // queue instead of failing: the CLI and the marketplaces registry are
    // shared mutable state, so serialize; overlapping is expected, not an error.
    const previous = this.inFlight;
    const run = previous
      ? previous.then(
          () => operation(),
          () => operation(), // previous failure must not block queued operations
        )
      : operation();
    // Track settlement without deriving a rejecting chain: cleanup must never
    // turn into an unhandled rejection when a queued run fails with no waiter.
    void run.then(
      (value) => {
        if (this.inFlight === run) this.inFlight = null;
        return value;
      },
      () => {
        if (this.inFlight === run) this.inFlight = null;
        // Swallowed here on purpose: the caller's `run` promise carries the
        // rejection; this derived chain only performs bookkeeping.
        return null;
      },
    );
    this.inFlight = run;
    return run as Promise<T>;
  }
  private async runCli(
    args: string[],
    timeout: number,
    cwd?: string,
    scope?: "user" | "project",
  ): Promise<string> {
    if (scope === "project" && cwd === undefined) {
      throw new Error("Project plugin operations require an explicit project cwd");
    }
    const workingDirectory = cwd ?? process.cwd();
    if (cwd !== undefined) {
      if (!isAbsolute(cwd)) {
        throw new Error("Plugin cwd must be an existing absolute directory");
      }
      const directory = await stat(cwd).catch(() => null);
      if (!directory?.isDirectory()) {
        throw new Error(`Plugin cwd is not an existing directory: ${cwd}`);
      }
    }
    const provider = this.getProviderConfig?.();
    let invocation: OmpPluginInvocation;
    if (resolveOmpBackend(provider) === "sdk") {
      const runtimeSettings = toRuntimeSettings(provider);
      const env = createProviderEnv({
        runtimeSettings,
      });
      if (hasBundledOmpPlugins(env)) {
        throw new Error(
          "This plugin-bound CLI distribution cannot use the SDK backend; select CLI or package SDK-compatible plugins separately",
        );
      }
      const installation = await resolveOmpSdkInstallation(runtimeSettings, env);
      invocation = {
        command: await resolveOmpSdkHostCommand(),
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          [OMP_SDK_ROOT_ENV]: installation.root,
        },
        cwd: workingDirectory,
      };
    } else {
      const command = provider?.command?.[0] ?? (await this.resolveOmpCommand());
      if (!command) throw new OmpPluginUnavailableError();
      invocation = await resolveOmpPluginInvocation({
        provider,
        env: { ...process.env, OMP_COMMAND: command },
        cwd: workingDirectory,
      });
      const hostVerifier = createBundledOmpHostVerifier();
      await hostVerifier(invocation.command[0], invocation.env);
      // First-use setup must finish before native management, not before the
      // daemon begins listening. Large private runtimes may require file staging.
      const provisioning = await provisionBundledOmpPlugins({
        ...invocation,
        hostVerifier,
      });
      for (const plugin of provisioning.plugins) {
        if (plugin.error)
          this.logger.error({ plugin: plugin.name, state: plugin.state }, plugin.error);
      }
      await hostVerifier(invocation.command[0], invocation.env);
    }
    try {
      const result = await this.runner(
        invocation.command[0],
        [...invocation.command.slice(1), "plugin", ...args],
        {
          timeout,
          cwd: workingDirectory,
          env: invocation.env,
        },
      );
      return `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
      throw new Error(output || `omp plugin ${args[0]} failed`, {
        cause: error,
      });
    }
  }

  async list(cwd?: string): Promise<OmpPluginListResult> {
    return this.runExclusive(async () => {
      let output: string;
      try {
        output = await this.runCli(["list", "--json"], ACTION_TIMEOUT_MS, cwd);
      } catch (error) {
        return {
          plugins: [],
          marketplace: [],
          rawOutput: truncateOutput((error as Error).message),
        };
      }
      const parsed = OmpPluginListJsonSchema.safeParse(parseTrailingJson(output));
      if (parsed.success) {
        const fromMarketplace = normalizeMarketplacePlugins(parsed.data.marketplace);
        return {
          plugins: [...parsed.data.npm, ...fromMarketplace],
          marketplace: parsed.data.marketplace,
        };
      }
      this.logger.warn({ output: output.slice(0, 500) }, "Unparseable omp plugin list output");
      return {
        plugins: [],
        marketplace: [],
        rawOutput: truncateOutput(output),
      };
    });
  }

  async install(input: {
    spec: string;
    scope?: "user" | "project";
    dryRun?: boolean;
    cwd?: string;
  }): Promise<OmpPluginMutateResult> {
    return this.runExclusive(async () => {
      const args = ["install", input.spec, "--json"];
      if (input.scope) args.push("--scope", input.scope);
      if (input.dryRun) args.push("--dry-run");
      let output: string;
      try {
        output = await this.runCli(args, INSTALL_TIMEOUT_MS, input.cwd, input.scope);
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
      const json = parseTrailingJson(output);
      const asList = TrailingJsonSchema.safeParse(json);
      if (asList.success) {
        const name = extractPluginName(input.spec);
        const plugin = asList.data.npm.find((entry) => entry.name === name) ?? null;
        return { ok: true, plugin, output: truncateOutput(output) };
      }
      // Some omp versions print the installed plugin object itself.
      const asPlugin = OmpPluginInfoSchema.safeParse(json);
      if (asPlugin.success) {
        return {
          ok: true,
          plugin: asPlugin.data,
          output: truncateOutput(output),
        };
      }
      return { ok: true, plugin: null, output: truncateOutput(output) };
    });
  }

  async upgrade(
    name: string,
    scope?: "user" | "project",
    cwd?: string,
  ): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      // Upgrade force-reinstalls the current catalog version and retains enabled
      // state. An explicit scope prevents upgrading another copy of the same ID.
      const args = ["upgrade", name];
      if (scope) args.push("--scope", scope);
      try {
        const output = await this.runCli(args, INSTALL_TIMEOUT_MS, cwd, scope);
        return { ok: true, output: truncateOutput(output) };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  async remove(
    name: string,
    scope?: "user" | "project",
    cwd?: string,
  ): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const args = ["uninstall", name];
        if (scope) args.push("--scope", scope);
        const output = await this.runCli(args, ACTION_TIMEOUT_MS, cwd, scope);
        return { ok: true, output: truncateOutput(output) };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  async setEnabled(
    name: string,
    enabled: boolean,
    scope?: "user" | "project",
    cwd?: string,
  ): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const args = [enabled ? "enable" : "disable", name];
        if (scope) args.push("--scope", scope);
        await this.runCli(args, ACTION_TIMEOUT_MS, cwd, scope);
      } catch (error) {
        this.logger.warn({ err: error, name, enabled, scope }, "omp plugin enable/disable failed");
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
      // Verify the registry actually changed: the CLI can exit 0 silently.
      try {
        const output = await this.runCli(["list", "--json"], ACTION_TIMEOUT_MS, cwd, scope);
        const parsed = OmpPluginListJsonSchema.safeParse(parseTrailingJson(output));
        if (!parsed.success) {
          return {
            ok: false,
            output: "Could not verify plugin state: invalid CLI list output",
          };
        }
        const npmEntry = parsed.data.npm.find((item) => item.name === name);
        const candidates = normalizeMarketplacePlugins(parsed.data.marketplace).filter(
          (item) => item.id === name && (scope === undefined || item.scope === scope),
        );
        // With no scope native chooses the unique applicable install, not user.
        // Never claim success for an ambiguous or differently scoped readback.
        const entry = npmEntry ?? (candidates.length === 1 ? candidates[0] : undefined);
        return entry?.enabled === enabled
          ? { ok: true }
          : {
              ok: false,
              output: "CLI readback did not confirm the requested plugin state",
            };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  async doctor(input?: { fix?: boolean; cwd?: string }): Promise<OmpPluginDoctorResult> {
    return this.runExclusive(async () => {
      const args = ["doctor", "--json"];
      if (input?.fix) args.push("--fix");
      let output: string;
      try {
        output = await this.runCli(args, DOCTOR_TIMEOUT_MS, input?.cwd);
      } catch (error) {
        return {
          checks: [],
          rawOutput: truncateOutput((error as Error).message),
        };
      }
      const parsed = OmpPluginDoctorJsonSchema.safeParse(parseTrailingJson(output));
      if (parsed.success) {
        return { checks: parsed.data };
      }
      return { checks: [], rawOutput: truncateOutput(output) };
    });
  }

  private async resolveMarketplacesRegistryPath(cwd?: string): Promise<string> {
    if (this.marketplacesRegistryPath) return this.marketplacesRegistryPath;
    const output = await this.runCli(["list", "--json"], ACTION_TIMEOUT_MS, cwd);
    const nativePaths = z
      .object({
        paths: z.object({ pluginsRoot: z.string().refine(isAbsolute) }),
      })
      .safeParse(parseTrailingJson(output));
    if (nativePaths.success)
      return join(dirname(nativePaths.data.paths.pluginsRoot), "marketplaces.json");
    if (hasBundledOmpPlugins())
      throw new Error("The private OMP host did not return authoritative plugin paths.");
    return join(homedir(), ".omp", "marketplaces.json");
  }

  /**
   * Reads the marketplace registry and catalogs directly: the omp CLI ignores
   * `--json` for `plugin marketplace list` (plain text only), so shelling out
   * would force brittle text parsing. Registry layout (verified against the
   * runtime): the resolved native data root's `marketplaces.json` holds
   * `{ marketplaces: [{ name, sourceType, sourceUri, catalogPath, ... }] }`,
   * and each `catalogPath` file holds `{ plugins: [{ name, description,
   * version, source, ... }] }`.
   */
  async marketplaceList(cwd?: string): Promise<OmpPluginMarketplaceListResult> {
    return this.runExclusive(async () => {
      const registryPath = await this.resolveMarketplacesRegistryPath(cwd);
      const registry = await this.readJsonFile(registryPath);
      const entries = OmpMarketplaceRegistryJsonSchema.safeParse(registry);
      if (!entries.success) {
        const raw = registry === null ? undefined : JSON.stringify(registry);
        if (raw) {
          this.logger.warn({ path: registryPath }, "Unparseable marketplaces registry");
        }
        return {
          marketplaces: [],
          rawOutput: raw ? truncateOutput(raw) : undefined,
        };
      }
      const marketplaces = await Promise.all(
        entries.data.marketplaces.map(async (entry) => {
          const catalog = await this.readJsonFile(entry.catalogPath);
          const parsedCatalog = OmpPluginMarketplaceCatalogJsonSchema.safeParse(catalog);
          const info: z.infer<typeof OmpPluginMarketplaceInfoSchema> = {
            name: entry.name,
            source: entry.sourceUri,
            plugins: parsedCatalog.success ? parsedCatalog.data.plugins : [],
          };
          return info;
        }),
      );
      return { marketplaces };
    });
  }

  private async readJsonFile(path: string): Promise<unknown> {
    try {
      return await readFile(path, "utf8").then((content) => JSON.parse(content));
    } catch {
      return null;
    }
  }

  async marketplaceAdd(input: { source: string; cwd?: string }): Promise<{
    ok: boolean;
    marketplace?: OmpPluginMarketplaceListResult["marketplaces"][number] | null;
    output?: string;
  }> {
    return this.runExclusive(async () => {
      const registryPath = await this.resolveMarketplacesRegistryPath(input.cwd);
      const beforeRegistry = await this.readJsonFile(registryPath);
      const beforeEntries = OmpMarketplaceRegistryJsonSchema.safeParse(beforeRegistry);
      const beforeNames = new Set(
        beforeEntries.success ? beforeEntries.data.marketplaces.map((entry) => entry.name) : [],
      );
      let output: string;
      try {
        output = await this.runCli(
          ["marketplace", "add", input.source, "--json"],
          MARKETPLACE_TIMEOUT_MS,
          input.cwd,
        );
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
      return {
        ok: true,
        marketplace: await this.extractAddedMarketplace(beforeNames, registryPath),
        output: truncateOutput(output),
      };
    });
  }

  async marketplaceRemove(input: {
    name: string;
    cwd?: string;
  }): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const output = await this.runCli(
          ["marketplace", "remove", input.name, "--json"],
          ACTION_TIMEOUT_MS,
          input.cwd,
        );
        return { ok: true, output: truncateOutput(output) };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  async marketplaceUpdate(input: {
    name: string;
    cwd?: string;
  }): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const output = await this.runCli(
          ["marketplace", "update", input.name],
          MARKETPLACE_TIMEOUT_MS,
          input.cwd,
        );
        return { ok: true, output: truncateOutput(output) };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  /**
   * Best-effort extraction of the added marketplace. The CLI's `add` output is
   * plain text (`--json` is ignored here too), so instead of parsing it we
   * re-read the registry and pick the entry that was not present before.
   */
  private async extractAddedMarketplace(
    beforeNames: ReadonlySet<string>,
    registryPath: string,
  ): Promise<OmpPluginMarketplaceListResult["marketplaces"][number] | null> {
    const registry = await this.readJsonFile(registryPath);
    const entries = OmpMarketplaceRegistryJsonSchema.safeParse(registry);
    if (!entries.success) return null;
    const added = entries.data.marketplaces.filter((entry) => !beforeNames.has(entry.name));
    const last = added[added.length - 1];
    if (!last) return null;
    const catalog = await this.readJsonFile(last.catalogPath);
    const parsedCatalog = OmpPluginMarketplaceCatalogJsonSchema.safeParse(catalog);
    return {
      name: last.name,
      source: last.sourceUri,
      plugins: parsedCatalog.success ? parsedCatalog.data.plugins : [],
    };
  }
}
