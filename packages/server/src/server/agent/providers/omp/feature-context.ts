import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";
import { OmpModelSchema, type OmpModel } from "./rpc-types.js";

interface FeatureEvidenceDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...parameters: unknown[]): Record<string, unknown>[] };
  close(): void;
}

interface FeatureDatabaseEvidence {
  records: Record<string, unknown>[];
  modelEvidenceMatches?: boolean | null;
}

type FeatureDatabaseEvidenceInput =
  | { file: string; table: "auth_credentials" }
  | { file: string; table: "model_cache"; modelProvider: string; verifyModel?: OmpModel | null };

function modelIdentityClass(model: OmpModel): unknown {
  const identity = model.identity;
  return typeof identity === "object" && identity !== null
    ? Reflect.get(identity, "class")
    : undefined;
}

function canIdentifyModelNamespace(namespace: unknown, model: OmpModel): boolean {
  // Bare caches are unscoped. Official Codex uses a version-only namespace;
  // opaque endpoint/account scopes must be reconfirmed through the native catalog.
  if (namespace === model.provider) return true;
  if (
    model.provider !== "openai-codex" ||
    typeof namespace !== "string" ||
    !/^openai-codex:\d+\.\d+\.\d+$/.test(namespace)
  )
    return false;
  try {
    const endpoint = new URL(model.baseUrl ?? "");
    return (
      endpoint.origin === "https://chatgpt.com" && /^\/backend-api(?:\/|$)/.test(endpoint.pathname)
    );
  } catch {
    return false;
  }
}

/** Compare only capability-bearing fields; native context fitting is not a capability change. */
export function matchesOmpFeatureModel(
  declaration: OmpModel | undefined,
  model: OmpModel | null,
): boolean {
  if (
    !declaration ||
    !model ||
    declaration.provider !== model.provider ||
    declaration.id !== model.id ||
    !declaration.api ||
    declaration.api !== model.api ||
    declaration.baseUrl !== model.baseUrl ||
    modelIdentityClass(declaration) !== modelIdentityClass(model)
  )
    return false;
  const tiers = declaration.serviceTiers;
  const nativeTiers = model.serviceTiers;
  if (tiers === undefined || nativeTiers === undefined) return tiers === nativeTiers;
  return (
    tiers.length === nativeTiers.length &&
    tiers.every((tier) => nativeTiers.includes(tier)) &&
    nativeTiers.every((tier) => tiers.includes(tier))
  );
}

function matchesModelDeclaration(payload: unknown, model: OmpModel | null): boolean {
  if (!model || typeof payload !== "string") return false;
  let entries: unknown;
  try {
    entries = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!Array.isArray(entries)) return false;
  let declaration: OmpModel | undefined;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("provider" in entry) ||
      entry.provider !== model.provider ||
      !("id" in entry) ||
      entry.id !== model.id
    )
      continue;
    const parsed = OmpModelSchema.safeParse(entry);
    if (!parsed.success || declaration) return false;
    declaration = parsed.data;
  }
  return matchesOmpFeatureModel(declaration, model);
}

async function readFeatureDatabaseEvidence(
  input: FeatureDatabaseEvidenceInput,
): Promise<FeatureDatabaseEvidence> {
  const { file, table } = input;
  try {
    await fs.access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    throw error;
  }
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, options: { readOnly: boolean }) => FeatureEvidenceDatabase;
  };
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    // Keep declaration payloads and their key metadata in one committed snapshot.
    database.exec("BEGIN");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (!tables.some((entry) => entry.name === table)) return { records: [] };
    if (input.table === "auth_credentials") {
      return { records: database.prepare("SELECT * FROM auth_credentials ORDER BY id").all() };
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
    const verifyModel = input.verifyModel;
    const verifyDeclaration = verifyModel !== undefined && rows.length > 0;
    // A missing namespace-to-session binding is not a proven declaration mismatch.
    let modelEvidenceMatches: boolean | null | undefined;
    if (verifyDeclaration) modelEvidenceMatches = verifyModel ? null : false;
    for (const row of rows) {
      const currentRefresh = refresh.find(
        (entry) =>
          entry.provider_id === row.provider_id && entry.payload_updated_at === row.updated_at,
      );
      if (currentRefresh) row.authoritative = currentRefresh.authoritative;
      delete row.updated_at;
      const missingHash = typeof row.models_hash !== "string" || row.models_hash.length === 0;
      const verifyRow =
        verifyDeclaration &&
        rows.length === 1 &&
        verifyModel != null &&
        canIdentifyModelNamespace(row.provider_id, verifyModel);
      if (missingHash || verifyRow) {
        const payload = database
          .prepare("SELECT models FROM model_cache WHERE provider_id = ?")
          .all(row.provider_id)[0]?.models;
        // Older caches and integrity triggers may leave no trustworthy hash.
        // Keep verification-only payloads out of the metadata cache key.
        if (missingHash) row.models = payload;
        if (verifyRow) {
          modelEvidenceMatches = matchesModelDeclaration(payload, verifyModel!);
        }
      }
    }
    return { records: rows, modelEvidenceMatches };
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
  /** null requires same-runtime catalog reconfirmation; undefined means no model evidence/check. */
  modelEvidenceMatches?: boolean | null;
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
  verifyModel?: OmpModel | null;
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
    (await readFeatureDatabaseEvidence({ file: paths.agentDb, table: "auth_credentials" })).records;
  hash.update(JSON.stringify(credentials));
  const configurationKey = hash.copy().digest("hex");
  const models: FeatureDatabaseEvidence = input.modelProvider
    ? await readFeatureDatabaseEvidence({
        file: join(dirname(paths.agentDb), "models.db"),
        table: "model_cache",
        modelProvider: input.modelProvider,
        verifyModel: input.verifyModel,
      })
    : { records: [] };
  if (input.modelProvider) hash.update(JSON.stringify(models.records));
  return {
    key: hash.digest("hex"),
    configurationKey,
    hasModelEvidence: models.records.length > 0,
    modelEvidenceMatches: models.modelEvidenceMatches,
  };
}
