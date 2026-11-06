import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  OmpMemorySettingsPatchSchema,
  type OmpMemoryBackend,
  type OmpMemorySettings,
  type OmpMemorySettingsPatch,
} from "@omp-desktop/protocol/messages";
import { isMap, parseDocument, type Document } from "yaml";

import { writeFileAtomic } from "../../../atomic-file.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";

const SUPPORTED_BACKENDS: OmpMemoryBackend[] = [
  "off",
  "local",
  "hindsight",
  "mnemopi",
  "sharpshooter",
];
const mutationQueues = new Map<string, Promise<OmpMemorySettings>>();
const LOCAL_MEMORY_MODEL = "local/lfm2-1.2b";
const LOCAL_EMBEDDING_MODELS = {
  en: "BAAI/bge-base-en-v1.5",
  multilingual: "intfloat/multilingual-e5-large",
} as const;
const ENVIRONMENT_FLAG_VALUES: ReadonlySet<string> = new Set([
  "1",
  "Y",
  "y",
  "TRUE",
  "true",
  "YES",
  "yes",
  "ON",
  "on",
]);
const LOCAL_MODEL_PRESET_FIELDS: Partial<Record<string, true>> = {
  useLocalModels: true,
  noEmbeddings: true,
  llmMode: true,
  embeddingModel: true,
  embeddingApiUrl: true,
};

type ConfigRecord = Record<string, unknown>;
type MemoryScoping = OmpMemorySettings["mnemopi"]["scoping"];

export class OmpMemorySettingsConflictError extends Error {
  constructor() {
    super("OMP memory settings changed on disk; reload before saving");
    this.name = "OmpMemorySettingsConflictError";
  }
}

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const agentDir = resolveOmpDiagnosticPaths(env).agentDir;
  const ymlPath = join(agentDir, "config.yml");
  if (existsSync(ymlPath)) return ymlPath;
  const yamlPath = join(agentDir, "config.yaml");
  return existsSync(yamlPath) ? yamlPath : ymlPath;
}

async function readConfigFile(configPath: string): Promise<string> {
  return fs
    .readFile(configPath, "utf8")
    .catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? "{}\n" : Promise.reject(error),
    );
}

function parseConfig(raw: string): Document.Parsed {
  const document = parseDocument(raw.trim() ? raw : "{}\n");
  if (document.errors.length > 0) {
    throw new Error(`Invalid OMP config: ${document.errors[0]?.message ?? "YAML parse failed"}`);
  }
  const root = document.toJS() as unknown;
  if (root != null && (typeof root !== "object" || Array.isArray(root))) {
    throw new Error("Invalid OMP config: root must be a mapping");
  }
  return document;
}

function revisionOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function readMapping(root: ConfigRecord, key: string): ConfigRecord {
  const value = root[key];
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OMP config: ${key} must be a mapping`);
  }
  return value as ConfigRecord;
}

function readBoolean(record: ConfigRecord, key: string, fallback: boolean, path: string): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`Invalid OMP config: ${path} must be boolean`);
  return value;
}

function readNumber(
  record: ConfigRecord,
  key: string,
  fallback: number,
  path: string,
  options: { integer?: boolean; min?: number } = {},
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.min !== undefined && value < options.min)
  ) {
    throw new Error(`Invalid OMP config: ${path} has an invalid numeric value`);
  }
  return value;
}

function readOptionalString(record: ConfigRecord, key: string, path: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid OMP config: ${path} must be a non-empty string`);
  }
  return value.trim();
}

function readString(record: ConfigRecord, key: string, fallback: string, path: string): string {
  return readOptionalString(record, key, path) ?? fallback;
}

function readEnum<T extends string>(
  record: ConfigRecord,
  key: string,
  fallback: T,
  allowed: readonly T[],
  path: string,
): T {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid OMP config: ${path} has an unsupported value`);
  }
  return value as T;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseEnvPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function configuredSecret(
  configValue: unknown,
  envValue?: string,
): OmpMemorySettings["secretState"]["hindsightApiToken"] {
  if (envValue?.trim()) return { configured: true, source: "environment" };
  if (typeof configValue === "string" && configValue.trim()) {
    return { configured: true, source: "config" };
  }
  return { configured: false, source: "none" };
}

// Match the native $flag parser, which is deliberately case- and whitespace-sensitive.
function embeddingsViaApi(env: NodeJS.ProcessEnv): boolean {
  return ENVIRONMENT_FLAG_VALUES.has(env.MNEMOPI_EMBEDDINGS_VIA_API ?? "");
}

function remoteEmbeddingEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  if (env.MNEMOPI_EMBEDDING_API_URL) return "MNEMOPI_EMBEDDING_API_URL";
  if (embeddingsViaApi(env)) return "MNEMOPI_EMBEDDINGS_VIA_API";
  // Native isApiModel falls back to this URL and classifies OpenRouter by substring.
  if (env.OPENROUTER_BASE_URL && !env.OPENROUTER_BASE_URL.toLowerCase().includes("openrouter.ai")) {
    return "OPENROUTER_BASE_URL";
  }
  return undefined;
}

function localModelsConfigured(
  root: ConfigRecord,
  mnemopi: ConfigRecord,
  env: NodeJS.ProcessEnv,
): boolean {
  const roles = root.modelRoles;
  const retry = root.retry;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return false;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) return false;
  const chains = (retry as ConfigRecord).fallbackChains;
  if (!chains || typeof chains !== "object" || Array.isArray(chains)) return false;
  const memoryFallbacks = (chains as ConfigRecord).memory;
  const variant = mnemopi.embeddingVariant === "multilingual" ? "multilingual" : "en";
  return (
    (roles as ConfigRecord).memory === LOCAL_MEMORY_MODEL &&
    Array.isArray(memoryFallbacks) &&
    memoryFallbacks.length === 0 &&
    mnemopi.noEmbeddings !== true &&
    (mnemopi.llmMode ?? "smol") === "smol" &&
    readMnemopiString(mnemopi, "embeddingModel", env) === LOCAL_EMBEDDING_MODELS[variant] &&
    readMnemopiString(mnemopi, "embeddingApiUrl", env) === null &&
    remoteEmbeddingEnvironment(env) === undefined
  );
}

function environmentOverrides(env: NodeJS.ProcessEnv, mnemopi: ConfigRecord): string[] {
  const paths: string[] = [];
  if (embeddingsViaApi(env)) {
    paths.push("mnemopi.embeddingsViaApi");
  }
  if (env.HINDSIGHT_API_URL?.trim()) paths.push("hindsight.apiUrl");
  if (env.HINDSIGHT_API_TOKEN?.trim()) paths.push("hindsight.apiToken");
  if (env.HINDSIGHT_BANK_ID?.trim()) paths.push("hindsight.bankId");
  if (parseEnvBoolean(env.HINDSIGHT_AUTO_RECALL) !== undefined) {
    paths.push("hindsight.autoRecall");
  }
  if (parseEnvBoolean(env.HINDSIGHT_AUTO_RETAIN) !== undefined) {
    paths.push("hindsight.autoRetain");
  }
  if (
    ["global", "per-project", "per-project-tagged"].includes(env.HINDSIGHT_SCOPING?.trim() ?? "")
  ) {
    paths.push("hindsight.scoping");
  }
  if (parseEnvPositiveInteger(env.HINDSIGHT_RETAIN_EVERY_N_TURNS) !== undefined) {
    paths.push("hindsight.retainEveryNTurns");
  }
  for (const key of [
    "embeddingModel",
    "embeddingApiUrl",
    "embeddingApiKey",
    "llmBaseUrl",
    "llmModel",
    "llmApiKey",
  ]) {
    const name = `MNEMOPI_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
    const configured = mnemopi[key];
    if (!(typeof configured === "string" && configured.trim()) && env[name]?.trim()) {
      paths.push(`mnemopi.${key}`);
    }
  }
  return paths;
}

function readMnemopiString(
  record: ConfigRecord,
  key: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const name = `MNEMOPI_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
  const configured = record[key];
  if (typeof configured === "string" && !configured.trim()) return env[name]?.trim() || null;
  return readOptionalString(record, key, `mnemopi.${key}`) ?? (env[name]?.trim() || null);
}

function toSettings(
  configPath: string,
  raw: string,
  document: Document.Parsed,
  env: NodeJS.ProcessEnv,
): OmpMemorySettings {
  const root = (document.toJS() ?? {}) as ConfigRecord;
  const memory = readMapping(root, "memory");
  const autolearn = readMapping(root, "autolearn");
  const memories = readMapping(root, "memories");
  const mnemopi = readMapping(root, "mnemopi");
  const hindsight = readMapping(root, "hindsight");
  const scopingValues: MemoryScoping[] = ["global", "per-project", "per-project-tagged"];
  const backend = readEnum(memory, "backend", "off", SUPPORTED_BACKENDS, "memory.backend");

  const configuredHindsightScoping = readEnum(
    hindsight,
    "scoping",
    "per-project-tagged",
    scopingValues,
    "hindsight.scoping",
  );
  const envHindsightScoping = env.HINDSIGHT_SCOPING;
  const hindsightScoping = scopingValues.includes(envHindsightScoping as MemoryScoping)
    ? (envHindsightScoping as MemoryScoping)
    : configuredHindsightScoping;

  const overrides = environmentOverrides(env, mnemopi);
  return {
    configPath,
    revision: revisionOf(raw),
    backend,
    supportedBackends: SUPPORTED_BACKENDS,
    autolearn: {
      enabled: readBoolean(autolearn, "enabled", false, "autolearn.enabled"),
      autoContinue: readBoolean(autolearn, "autoContinue", false, "autolearn.autoContinue"),
    },
    local: {
      minRolloutIdleHours: readNumber(
        memories,
        "minRolloutIdleHours",
        12,
        "memories.minRolloutIdleHours",
        { min: 0 },
      ),
      maxRolloutAgeDays: readNumber(
        memories,
        "maxRolloutAgeDays",
        30,
        "memories.maxRolloutAgeDays",
        { min: Number.EPSILON },
      ),
      summaryInjectionTokenLimit: readNumber(
        memories,
        "summaryInjectionTokenLimit",
        5000,
        "memories.summaryInjectionTokenLimit",
        { integer: true, min: 1 },
      ),
    },
    mnemopi: {
      localModelsConfigured: localModelsConfigured(root, mnemopi, env),
      scoping: readEnum(mnemopi, "scoping", "per-project", scopingValues, "mnemopi.scoping"),
      autoRecall: readBoolean(mnemopi, "autoRecall", true, "mnemopi.autoRecall"),
      autoRetain: readBoolean(mnemopi, "autoRetain", true, "mnemopi.autoRetain"),
      retainEveryNTurns: readNumber(mnemopi, "retainEveryNTurns", 4, "mnemopi.retainEveryNTurns", {
        integer: true,
        min: 1,
      }),
      recallLimit: readNumber(mnemopi, "recallLimit", 8, "mnemopi.recallLimit", {
        integer: true,
        min: 1,
      }),
      recallContextTurns: readNumber(
        mnemopi,
        "recallContextTurns",
        3,
        "mnemopi.recallContextTurns",
        { integer: true, min: 0 },
      ),
      recallMaxQueryChars: readNumber(
        mnemopi,
        "recallMaxQueryChars",
        4000,
        "mnemopi.recallMaxQueryChars",
        { integer: true, min: 1 },
      ),
      injectionTokenLimit: readNumber(
        mnemopi,
        "injectionTokenLimit",
        5000,
        "mnemopi.injectionTokenLimit",
        { integer: true, min: 1 },
      ),
      polyphonicRecall: readBoolean(mnemopi, "polyphonicRecall", false, "mnemopi.polyphonicRecall"),
      enhancedRecall: readBoolean(mnemopi, "enhancedRecall", false, "mnemopi.enhancedRecall"),
      proactiveLinking: readBoolean(mnemopi, "proactiveLinking", false, "mnemopi.proactiveLinking"),
      noEmbeddings: readBoolean(mnemopi, "noEmbeddings", false, "mnemopi.noEmbeddings"),
      embeddingVariant: readEnum(
        mnemopi,
        "embeddingVariant",
        "en",
        ["en", "multilingual"],
        "mnemopi.embeddingVariant",
      ),
      llmMode: readEnum(mnemopi, "llmMode", "smol", ["smol", "remote", "none"], "mnemopi.llmMode"),
      dbPath: readOptionalString(mnemopi, "dbPath", "mnemopi.dbPath"),
      embeddingModel: readMnemopiString(mnemopi, "embeddingModel", env),
      embeddingApiUrl: readMnemopiString(mnemopi, "embeddingApiUrl", env),
      llmBaseUrl: readMnemopiString(mnemopi, "llmBaseUrl", env),
      llmModel: readMnemopiString(mnemopi, "llmModel", env),
    },
    hindsight: {
      apiUrl:
        env.HINDSIGHT_API_URL?.trim() ||
        readString(hindsight, "apiUrl", "http://localhost:8888", "hindsight.apiUrl"),
      scoping: hindsightScoping,
      bankId:
        env.HINDSIGHT_BANK_ID?.trim() ||
        readOptionalString(hindsight, "bankId", "hindsight.bankId"),
      autoRecall:
        parseEnvBoolean(env.HINDSIGHT_AUTO_RECALL) ??
        readBoolean(hindsight, "autoRecall", true, "hindsight.autoRecall"),
      autoRetain:
        parseEnvBoolean(env.HINDSIGHT_AUTO_RETAIN) ??
        readBoolean(hindsight, "autoRetain", true, "hindsight.autoRetain"),
      retainEveryNTurns:
        parseEnvPositiveInteger(env.HINDSIGHT_RETAIN_EVERY_N_TURNS) ??
        readNumber(hindsight, "retainEveryNTurns", 3, "hindsight.retainEveryNTurns", {
          integer: true,
          min: 1,
        }),
    },
    secretState: {
      hindsightApiToken: configuredSecret(hindsight.apiToken, env.HINDSIGHT_API_TOKEN),
      mnemopiEmbeddingApiKey: configuredSecret(
        mnemopi.embeddingApiKey,
        overrides.includes("mnemopi.embeddingApiKey") ? env.MNEMOPI_EMBEDDING_API_KEY : undefined,
      ),
      mnemopiLlmApiKey: configuredSecret(
        mnemopi.llmApiKey,
        overrides.includes("mnemopi.llmApiKey") ? env.MNEMOPI_LLM_API_KEY : undefined,
      ),
    },
    environmentOverrides: overrides,
  };
}

function assertEditableMappings(document: Document.Parsed): void {
  for (const key of ["memory", "autolearn", "memories", "mnemopi", "hindsight"]) {
    const value = document.getIn([key], true);
    if (value != null && !isMap(value)) {
      throw new Error(`Invalid OMP config: ${key} must be a mapping`);
    }
  }
}

function applyObjectPatch(
  document: Document.Parsed,
  prefix: string[],
  patch: Record<string, unknown> | undefined,
  ignoredFields?: Partial<Record<string, true>>,
): void {
  if (!patch) return;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || ignoredFields?.[key]) continue;
    const path = [...prefix, key];
    if (value === null) document.deleteIn(path);
    else document.setIn(path, value);
  }
}

function removeEmptyMappings(document: Document.Parsed): void {
  for (const key of ["memory", "autolearn", "memories", "mnemopi", "hindsight"]) {
    const value = document.getIn([key], true);
    if (isMap(value) && value.items.length === 0) document.deleteIn([key]);
  }
}

function applyLocalModelsPreset(
  document: Document.Parsed,
  patch: NonNullable<OmpMemorySettingsPatch["mnemopi"]>,
  env: NodeJS.ProcessEnv,
): void {
  const remoteEnvironment = remoteEmbeddingEnvironment(env);
  if (remoteEnvironment) {
    throw new Error(
      `Local memory models conflict with ${remoteEnvironment}; remove that environment override first`,
    );
  }
  for (const path of [["modelRoles"], ["retry"], ["retry", "fallbackChains"]]) {
    const value = document.getIn(path, true);
    if (value !== undefined && !isMap(value)) {
      throw new Error(`Invalid OMP config: ${path.join(".")} must be a mapping`);
    }
  }
  const variant = patch.embeddingVariant ?? document.getIn(["mnemopi", "embeddingVariant"]) ?? "en";
  if (variant !== "en" && variant !== "multilingual") {
    throw new Error("Invalid OMP config: mnemopi.embeddingVariant has an unsupported value");
  }
  const embeddingModel = LOCAL_EMBEDDING_MODELS[variant];
  if (
    patch.noEmbeddings === true ||
    (patch.llmMode !== undefined && patch.llmMode !== "smol") ||
    (patch.embeddingModel != null && patch.embeddingModel !== embeddingModel) ||
    patch.embeddingApiUrl != null ||
    patch.llmBaseUrl !== undefined ||
    patch.llmModel !== undefined
  ) {
    throw new Error("Local memory models conflict with explicit memory routing options");
  }
  document.setIn(["modelRoles", "memory"], LOCAL_MEMORY_MODEL);
  document.setIn(["retry", "fallbackChains", "memory"], []);
  document.setIn(["mnemopi", "noEmbeddings"], false);
  document.setIn(["mnemopi", "llmMode"], "smol");
  document.setIn(["mnemopi", "embeddingModel"], embeddingModel);
  document.deleteIn(["mnemopi", "embeddingApiUrl"]);
}

function applyPatch(
  document: Document.Parsed,
  patch: OmpMemorySettingsPatch,
  env: NodeJS.ProcessEnv,
): void {
  assertEditableMappings(document);
  if (patch.backend !== undefined) document.setIn(["memory", "backend"], patch.backend);
  applyObjectPatch(document, ["autolearn"], patch.autolearn);
  applyObjectPatch(document, ["memories"], patch.local);
  const mnemopiPatch = patch.mnemopi;
  if (mnemopiPatch?.useLocalModels) {
    applyLocalModelsPreset(document, mnemopiPatch, env);
    // The command is not native YAML, and preset route fields must survive null reset patches.
    applyObjectPatch(document, ["mnemopi"], mnemopiPatch, LOCAL_MODEL_PRESET_FIELDS);
  } else {
    applyObjectPatch(document, ["mnemopi"], mnemopiPatch);
  }
  applyObjectPatch(document, ["hindsight"], patch.hindsight);
  if (patch.secrets) {
    applyObjectPatch(document, ["hindsight"], {
      apiToken: patch.secrets.hindsightApiToken,
    });
    applyObjectPatch(document, ["mnemopi"], {
      embeddingApiKey: patch.secrets.mnemopiEmbeddingApiKey,
      llmApiKey: patch.secrets.mnemopiLlmApiKey,
    });
  }
  removeEmptyMappings(document);
}

export async function readOmpMemorySettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpMemorySettings> {
  const configPath = resolveConfigPath(env);
  const raw = await readConfigFile(configPath);
  return toSettings(configPath, raw, parseConfig(raw), env);
}

export async function updateOmpMemorySettings(
  expectedRevision: string,
  input: OmpMemorySettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpMemorySettings> {
  const patch = OmpMemorySettingsPatchSchema.parse(input);
  const configPath = resolveConfigPath(env);
  const update = async (): Promise<OmpMemorySettings> => {
    const raw = await readConfigFile(configPath);
    if (revisionOf(raw) !== expectedRevision) throw new OmpMemorySettingsConflictError();
    const document = parseConfig(raw);
    applyPatch(document, patch, env);
    const nextRaw = document.toString();
    const settings = toSettings(configPath, nextRaw, document, env);
    await fs.mkdir(dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, nextRaw);
    return settings;
  };
  const previous = mutationQueues.get(configPath);
  const queued = previous ? previous.then(update, update) : update();
  mutationQueues.set(configPath, queued);
  try {
    return await queued;
  } finally {
    if (mutationQueues.get(configPath) === queued) mutationQueues.delete(configPath);
  }
}
