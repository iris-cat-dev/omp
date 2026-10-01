import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  OmpMarketplacePluginInfoSchema,
  OmpPluginDoctorCheckSchema,
  OmpPluginInfoSchema,
  OmpPluginMarketplaceInfoSchema,
} from "@omp-desktop/protocol/messages";

import type { Logger } from "pino";
import { execCommand } from "../utils/spawn.js";
import { findExecutable } from "../executable-resolution/executable-resolution.js";

/**
 * Thin wrapper around the OMP runtime's own `omp plugin <action>` CLI.
 *
 * The OMP runtime is the plugin authority: it owns discovery, manifest
 * handling, feature gating and health checks. OMP Desktop only shells out to
 * the CLI, normalizes its JSON output, and reports results. No plugin format,
 * state store, or loader is implemented here — that is the daemon plugin
 * runtime's separate concern (and a different upstream feature area).
 */

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const ACTION_TIMEOUT_MS = 60 * 1000;
const DOCTOR_TIMEOUT_MS = 120 * 1000;
const MARKETPLACE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 8 * 1024;

export type OmpPluginRunner = (
  command: string,
  args: string[],
  options: { timeout: number },
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
  /**
   * Returns the proxy URL configured via the host settings UI (PI_PROXY).
   * When set, HTTPS_PROXY/HTTP_PROXY are injected into the spawned omp CLI
   * process so that plugin marketplace git clones and npm installs respect
   * the user's proxy — the omp binary's native git clone does not read
   * PI_PROXY directly.
   */
  getProxyUrl?: () => string | undefined;
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
    plugins: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            version: z.string().optional(),
            category: z.string().optional(),
            keywords: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .default([]),
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

export class OmpPluginCliService {
  private readonly logger: Logger;
  private readonly runner: OmpPluginRunner;
  private readonly resolveOmpCommand: () => Promise<string | null>;
  private readonly marketplacesRegistryPath: string;
  private readonly getProxyUrl: (() => string | undefined) | undefined;
  private inFlight: Promise<unknown> | null = null;

  constructor(options: OmpPluginCliServiceOptions) {
    this.logger = options.logger.child({ module: "omp-plugin-cli" });
    this.getProxyUrl = options.getProxyUrl;
    this.runner =
      options.runner ??
      (async (command, args, runnerOptions) =>
        await execCommand(command, args, {
          timeout: runnerOptions.timeout,
          envMode: "internal",
          envOverlay: this.buildProxyEnv(),
        }));
    this.resolveOmpCommand =
      options.resolveOmpCommand ??
      (async () => process.env.OMP_COMMAND?.trim() || (await findExecutable("omp")) || null);
    this.marketplacesRegistryPath =
      options.marketplacesRegistryPath ?? join(homedir(), ".omp", "marketplaces.json");
  }

  private buildProxyEnv(): Record<string, string> | undefined {
    const proxyUrl = this.getProxyUrl?.();
    if (!proxyUrl) return undefined;
    return { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl };
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
  private async runCli(args: string[], timeout: number): Promise<string> {
    const command = await this.resolveOmpCommand();
    if (!command) {
      throw new OmpPluginUnavailableError();
    }
    try {
      const result = await this.runner(command, ["plugin", ...args], { timeout });
      return `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
      throw new Error(output || `omp plugin ${args[0]} failed`, { cause: error });
    }
  }

  async list(): Promise<OmpPluginListResult> {
    return this.runExclusive(async () => {
      let output: string;
      try {
        output = await this.runCli(["list", "--json"], ACTION_TIMEOUT_MS);
      } catch (error) {
        return {
          plugins: [],
          marketplace: [],
          rawOutput: truncateOutput((error as Error).message),
        };
      }
      const parsed = OmpPluginListJsonSchema.safeParse(parseTrailingJson(output));
      if (parsed.success) {
        // Marketplace-installed plugins have a different CLI shape. Preserve
        // their exact ID and scope: lifecycle commands need both when the same
        // catalog plugin is installed from multiple marketplaces or scopes.
        const fromMarketplace = parsed.data.marketplace.map((marketplacePlugin) => {
          const separator = marketplacePlugin.id.lastIndexOf("@");
          const name =
            separator > 0 ? marketplacePlugin.id.slice(0, separator) : marketplacePlugin.id;
          const entry =
            marketplacePlugin.entries?.find(
              (candidate) => candidate.scope === marketplacePlugin.scope,
            ) ?? marketplacePlugin.entries?.[0];
          return {
            name,
            id: marketplacePlugin.id,
            version: entry?.version ?? marketplacePlugin.version ?? "",
            path: entry?.installPath,
            scope: marketplacePlugin.scope,
            enabled: entry?.enabled !== false,
            description: undefined,
          };
        });
        return {
          plugins: [...parsed.data.npm, ...fromMarketplace],
          marketplace: parsed.data.marketplace,
        };
      }
      this.logger.warn({ output: output.slice(0, 500) }, "Unparseable omp plugin list output");
      return { plugins: [], marketplace: [], rawOutput: truncateOutput(output) };
    });
  }

  async install(input: {
    spec: string;
    scope?: "user" | "project";
    dryRun?: boolean;
  }): Promise<OmpPluginMutateResult> {
    return this.runExclusive(async () => {
      const args = ["install", input.spec, "--json"];
      if (input.scope) args.push("--scope", input.scope);
      if (input.dryRun) args.push("--dry-run");
      let output: string;
      try {
        output = await this.runCli(args, INSTALL_TIMEOUT_MS);
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
        return { ok: true, plugin: asPlugin.data, output: truncateOutput(output) };
      }
      return { ok: true, plugin: null, output: truncateOutput(output) };
    });
  }

  async upgrade(
    name: string,
    scope?: "user" | "project",
  ): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      // Upgrade force-reinstalls the current catalog version and retains enabled
      // state. An explicit scope prevents upgrading another copy of the same ID.
      const args = ["upgrade", name];
      if (scope) args.push("--scope", scope);
      try {
        const output = await this.runCli(args, INSTALL_TIMEOUT_MS);
        return { ok: true, output: truncateOutput(output) };
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
    });
  }

  async remove(
    name: string,
    scope?: "user" | "project",
  ): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const args = ["uninstall", name];
        if (scope) args.push("--scope", scope);
        const output = await this.runCli(args, ACTION_TIMEOUT_MS);
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
  ): Promise<{ ok: boolean }> {
    return this.runExclusive(async () => {
      try {
        const args = [enabled ? "enable" : "disable", name];
        if (scope) args.push("--scope", scope);
        await this.runCli(args, ACTION_TIMEOUT_MS);
      } catch (error) {
        this.logger.warn({ err: error, name, enabled, scope }, "omp plugin enable/disable failed");
        return { ok: false };
      }
      // Verify the registry actually changed: the CLI can exit 0 silently.
      try {
        const output = await this.runCli(["list", "--json"], ACTION_TIMEOUT_MS);
        const parsed = OmpPluginListJsonSchema.safeParse(parseTrailingJson(output));
        if (!parsed.success) return { ok: false };
        const npmEntry = parsed.data.npm.find((item) => item.name === name);
        if (npmEntry) return { ok: npmEntry.enabled === enabled };
        const marketplaceEntry = parsed.data.marketplace.find(
          (item) => item.id === name && (!scope || item.scope === scope),
        );
        const entry =
          marketplaceEntry?.entries?.find((item) => !scope || item.scope === scope) ??
          marketplaceEntry?.entries?.[0];
        return { ok: entry !== undefined && (entry.enabled ?? true) === enabled };
      } catch {
        return { ok: false };
      }
    });
  }

  async doctor(input?: { fix?: boolean }): Promise<OmpPluginDoctorResult> {
    return this.runExclusive(async () => {
      const args = ["doctor", "--json"];
      if (input?.fix) args.push("--fix");
      let output: string;
      try {
        output = await this.runCli(args, DOCTOR_TIMEOUT_MS);
      } catch (error) {
        return { checks: [], rawOutput: truncateOutput((error as Error).message) };
      }
      const parsed = OmpPluginDoctorJsonSchema.safeParse(parseTrailingJson(output));
      if (parsed.success) {
        return { checks: parsed.data };
      }
      return { checks: [], rawOutput: truncateOutput(output) };
    });
  }

  /**
   * Reads the marketplace registry and catalogs directly: the omp CLI ignores
   * `--json` for `plugin marketplace list` (plain text only), so shelling out
   * would force brittle text parsing. Registry layout (verified against the
   * runtime): `~/.omp/marketplaces.json` holds
   * `{ marketplaces: [{ name, sourceType, sourceUri, catalogPath, ... }] }`,
   * and each `catalogPath` file holds `{ plugins: [{ name, description,
   * version, source, ... }] }`.
   */
  async marketplaceList(): Promise<OmpPluginMarketplaceListResult> {
    return this.runExclusive(async () => {
      const registry = await this.readJsonFile(this.marketplacesRegistryPath);
      const entries = OmpMarketplaceRegistryJsonSchema.safeParse(registry);
      if (!entries.success) {
        const raw = registry === null ? undefined : JSON.stringify(registry);
        if (raw) {
          this.logger.warn(
            { path: this.marketplacesRegistryPath },
            "Unparseable marketplaces registry",
          );
        }
        return { marketplaces: [], rawOutput: raw ? truncateOutput(raw) : undefined };
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

  async marketplaceAdd(input: { source: string }): Promise<{
    ok: boolean;
    marketplace?: OmpPluginMarketplaceListResult["marketplaces"][number] | null;
    output?: string;
  }> {
    return this.runExclusive(async () => {
      const beforeRegistry = await this.readJsonFile(this.marketplacesRegistryPath);
      const beforeEntries = OmpMarketplaceRegistryJsonSchema.safeParse(beforeRegistry);
      const beforeNames = new Set(
        beforeEntries.success ? beforeEntries.data.marketplaces.map((entry) => entry.name) : [],
      );
      let output: string;
      try {
        output = await this.runCli(
          ["marketplace", "add", input.source, "--json"],
          MARKETPLACE_TIMEOUT_MS,
        );
      } catch (error) {
        return { ok: false, output: truncateOutput((error as Error).message) };
      }
      return {
        ok: true,
        marketplace: await this.extractAddedMarketplace(beforeNames),
        output: truncateOutput(output),
      };
    });
  }

  async marketplaceRemove(input: { name: string }): Promise<{ ok: boolean; output?: string }> {
    return this.runExclusive(async () => {
      try {
        const output = await this.runCli(
          ["marketplace", "remove", input.name, "--json"],
          ACTION_TIMEOUT_MS,
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
  ): Promise<OmpPluginMarketplaceListResult["marketplaces"][number] | null> {
    const registry = await this.readJsonFile(this.marketplacesRegistryPath);
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
