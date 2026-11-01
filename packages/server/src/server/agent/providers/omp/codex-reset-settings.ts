import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { OmpCodexResetSettings } from "@omp-desktop/protocol/messages";
import { isMap, parseDocument, type Document } from "yaml";

import { writeFileAtomic } from "../../../atomic-file.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";

const mutationQueues = new Map<string, Promise<OmpCodexResetSettings>>();
const dottedKey = "codexResets.autoRedeem";

function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  const agentDir = resolveOmpDiagnosticPaths(env).agentDir;
  const ymlPath = join(agentDir, "config.yml");
  if (existsSync(ymlPath)) return ymlPath;
  const yamlPath = join(agentDir, "config.yaml");
  return existsSync(yamlPath) ? yamlPath : ymlPath;
}

async function readConfig(configPath: string): Promise<Document.Parsed> {
  const raw = await fs
    .readFile(configPath, "utf8")
    .catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? "{}\n" : Promise.reject(error),
    );
  const document = parseDocument(raw.trim() ? raw : "{}\n");
  if (document.errors.length > 0) {
    throw new Error(`Invalid OMP config: ${document.errors[0]?.message ?? "YAML parse failed"}`);
  }
  if (document.contents != null && !isMap(document.contents)) {
    throw new Error("Invalid OMP config: root must be a mapping");
  }
  if (document.has("codexResets") && !isMap(document.get("codexResets", true))) {
    throw new Error("Invalid OMP config: codexResets must be a mapping");
  }
  if (document.has(dottedKey)) readMode(document.get(dottedKey));
  if (document.hasIn(["codexResets", "autoRedeem"])) {
    readMode(document.getIn(["codexResets", "autoRedeem"]));
  }
  return document;
}

function readMode(value: unknown): OmpCodexResetSettings["autoRedeem"] {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === "unset" || value === "yes" || value === "no") return value;
  throw new Error("Invalid OMP config: codexResets.autoRedeem must be unset, yes, or no");
}

function toSettings(configPath: string, document: Document.Parsed): OmpCodexResetSettings {
  // Native Settings reads nested paths; quoted dotted legacy keys do not override them.
  return {
    configPath,
    autoRedeem: document.hasIn(["codexResets", "autoRedeem"])
      ? readMode(document.getIn(["codexResets", "autoRedeem"]))
      : "unset",
  };
}

export async function readOmpCodexResetSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpCodexResetSettings> {
  const configPath = resolveConfigPath(env);
  return toSettings(configPath, await readConfig(configPath));
}

export async function updateOmpCodexResetSettings(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmpCodexResetSettings> {
  if (typeof enabled !== "boolean") throw new Error("OMP automatic reset-card use must be boolean");
  const configPath = resolveConfigPath(env);
  const update = async (): Promise<OmpCodexResetSettings> => {
    const document = await readConfig(configPath);
    const mode = enabled ? "yes" : "no";
    document.setIn(["codexResets", "autoRedeem"], mode);
    if (document.has(dottedKey)) document.set(dottedKey, mode);
    await fs.mkdir(dirname(configPath), { recursive: true });
    await writeFileAtomic(configPath, document.toString());
    return toSettings(configPath, document);
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
