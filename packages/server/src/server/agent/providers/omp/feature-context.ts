import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";

interface FeatureEvidenceDatabase {
  prepare(sql: string): { all(...parameters: unknown[]): Record<string, unknown>[] };
  close(): void;
}

type FeatureDatabaseEvidenceInput =
  | { file: string; table: "auth_credentials" }
  | { file: string; table: "model_cache"; modelProvider: string };

async function readFeatureDatabaseEvidence(
  input: FeatureDatabaseEvidenceInput,
): Promise<Record<string, unknown>[]> {
  const { file, table } = input;
  try {
    await fs.access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, options: { readOnly: boolean }) => FeatureEvidenceDatabase;
  };
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (!tables.some((entry) => entry.name === table)) return [];
    if (input.table === "auth_credentials") {
      return database.prepare("SELECT * FROM auth_credentials ORDER BY id").all();
    }
    // Native payload hashes cover committed declarations (including WAL).
    // Exclude freshness timestamps: checking the same roster again does not
    // change capabilities, and creating an empty database is not new evidence.
    const columns = database
      .prepare("PRAGMA table_info(model_cache)")
      .all()
      .map((column) => String(column.name))
      .filter((name) => name !== "models");
    const projection = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    // Cache namespaces retain the model provider prefix before any native
    // endpoint/account/version scope. Startup may populate unrelated providers;
    // those declarations cannot invalidate this selected model's evidence.
    const prefix = `${input.modelProvider}:`;
    const rows = database
      .prepare(`SELECT ${projection} FROM model_cache
        WHERE provider_id = ? OR substr(provider_id, 1, ?) = ? ORDER BY provider_id`)
      .all(input.modelProvider, prefix.length, prefix);
    const refresh = tables.some((entry) => entry.name === "model_cache_refresh")
      ? database.prepare("SELECT * FROM model_cache_refresh").all()
      : [];
    for (const row of rows) {
      const currentRefresh = refresh.find(
        (entry) =>
          entry.provider_id === row.provider_id && entry.payload_updated_at === row.updated_at,
      );
      if (currentRefresh) row.authoritative = currentRefresh.authoritative;
      delete row.updated_at;
      if (typeof row.models_hash !== "string" || row.models_hash.length === 0) {
        // Older caches and native integrity triggers may leave no trustworthy
        // hash; use the payload itself rather than mtime or a guessed default.
        row.models = database
          .prepare("SELECT models FROM model_cache WHERE provider_id = ?")
          .all(row.provider_id)[0]?.models;
      }
    }
    return rows;
  } finally {
    database.close();
  }
}

function addCommandConfigFiles(
  files: Set<string>,
  cwd: string,
  commandArgs: readonly string[],
): void {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index]!;
    let file: string | undefined;
    if (argument === "--config") file = commandArgs[++index];
    else if (argument.startsWith("--config=")) file = argument.slice("--config=".length);
    if (file)
      files.add(resolve(cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file));
  }
}

export interface OmpFeatureContext {
  key: string;
  configurationKey: string;
  hasModelEvidence: boolean;
}

/** Fingerprint local evidence, never credentials or selected tier values in a cache/log key. */
export async function fingerprintOmpFeatureContext(input: {
  config: AgentSessionConfig;
  runtimeSettings?: ProviderRuntimeSettings;
  runtimeFiles: string[];
  runtimeIdentity: unknown;
  desktopConfigDir?: string;
  credentialEvidence?: unknown;
  commandArgs?: readonly string[];
  modelProvider?: string;
}): Promise<OmpFeatureContext> {
  const env = { ...process.env, ...input.runtimeSettings?.env };
  const paths = resolveOmpDiagnosticPaths(env);
  const files = new Set(input.runtimeFiles);
  for (const name of ["config.yml", "config.yaml", "settings.json", "models.yml", "models.yaml"]) {
    files.add(join(paths.agentDir, name));
  }
  files.add(join(paths.agentDir, ".env"));
  for (let directory = resolve(input.config.cwd); ; directory = dirname(directory)) {
    for (const name of [
      "config.yml",
      "config.yaml",
      "settings.json",
      "models.yml",
      "models.yaml",
    ]) {
      files.add(join(directory, ".omp", name));
    }
    files.add(join(directory, ".env"));
    files.add(join(directory, ".env.local"));
    if (dirname(directory) === directory) break;
  }
  for (const file of env.PI_CONFIG_FILES?.split(delimiter).filter(Boolean) ?? []) {
    files.add(
      resolve(input.config.cwd, file.startsWith("~/") ? join(homedir(), file.slice(2)) : file),
    );
  }
  addCommandConfigFiles(files, input.config.cwd, input.commandArgs ?? []);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      cwd: resolve(input.config.cwd),
      model: input.config.model,
      modeId: input.config.modeId,
      thinkingOptionId: input.config.thinkingOptionId,
      account: input.config.featureValues?.oauth_account_credential ?? "automatic",
      proxyPolicy: input.config.proxyPolicy,
      env,
      runtimeSettings: input.runtimeSettings,
      runtimeIdentity: input.runtimeIdentity,
      desktopConfigDir: input.desktopConfigDir,
      profile: paths.profile,
      agentDir: paths.agentDir,
    }),
  );
  for (const file of [...files].sort()) {
    hash.update(file);
    try {
      // Runtime binaries can be large; their installation identity and metadata
      // suffice. Config contents catch equal-size/equal-mtime edits as well.
      if (input.runtimeFiles.includes(file)) {
        const stat = await fs.stat(file);
        hash.update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
      } else {
        hash.update(await fs.readFile(file));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing");
    }
  }
  const credentials =
    input.credentialEvidence ??
    (await readFeatureDatabaseEvidence({ file: paths.agentDb, table: "auth_credentials" }));
  hash.update(JSON.stringify(credentials));
  const configurationKey = hash.copy().digest("hex");
  const models = input.modelProvider
    ? await readFeatureDatabaseEvidence({
        file: join(dirname(paths.agentDb), "models.db"),
        table: "model_cache",
        modelProvider: input.modelProvider,
      })
    : [];
  if (input.modelProvider) hash.update(JSON.stringify(models));
  return {
    key: hash.digest("hex"),
    configurationKey,
    hasModelEvidence: models.length > 0,
  };
}
