import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../../agent-sdk-types.js";

import {
  generateEntryId,
  importExternalSessionViaOmp,
  type ExternalSessionSourceInfo,
} from "./delegate.js";
import { readOmpSessionDescriptor } from "../omp/session-descriptor.js";
import { convertPiModelChange, isDroppablePiEntry, summarizePiSession } from "./pi-convert.js";

const PI_PROVIDER_ID = "pi";

export const EXTERNAL_PROVIDER_IDS = [PI_PROVIDER_ID, "codex"] as const;

export function isExternalProviderId(provider: string): boolean {
  return (EXTERNAL_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** pi writes one JSONL transcript per session under `~/.pi/agent/sessions/<cwd-slug>/`. */
export function resolvePiSessionsDir(input?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = input?.env ?? process.env;
  const override = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = override
    ? path.resolve(override)
    : path.join(input?.homeDir || homedir(), env.PI_CONFIG_DIR?.trim() || ".pi", "agent");
  return path.join(agentDir, "sessions");
}

async function listPiSessionFiles(input?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string[]> {
  const sessionsDir = resolvePiSessionsDir(input);
  let dirEntries;
  try {
    dirEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    const subDir = path.join(sessionsDir, dirEntry.name);
    let subEntries;
    try {
      subEntries = await readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const subEntry of subEntries) {
      if (subEntry.isFile() && subEntry.name.endsWith(".jsonl")) {
        files.push(path.join(subDir, subEntry.name));
      }
    }
  }
  return files;
}

/**
 * pi and OMP share the same transcript format family (OMP forked pi's v3
 * JSONL), so the OMP descriptor reader parses pi headers/heads/tails directly.
 * Only the model_change shape differs (`{provider, modelId}` vs `model`) and
 * that field is not part of the import-list payload.
 */
export async function listPiImportableSessions(
  options?: ListImportableSessionsOptions & {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  },
): Promise<ImportableProviderSession[]> {
  const files = await listPiSessionFiles(options);
  const descriptors = await Promise.all(
    files.map(async (filePath) => {
      const summary = await summarizePiSession(filePath).catch(() => null);
      if (!summary) return null;
      const descriptor = await readOmpSessionDescriptor(filePath).catch(() => null);
      if (!descriptor) return null;
      return {
        providerHandleId: filePath,
        cwd: descriptor.cwd,
        title: descriptor.title,
        firstPromptPreview: descriptor.firstUserMessage,
        lastPromptPreview: descriptor.lastUserMessage ?? descriptor.firstUserMessage,
        lastActivityAt: descriptor.lastActivityAt,
      } satisfies ImportableProviderSession;
    }),
  );
  return descriptors
    .filter((descriptor): descriptor is ImportableProviderSession => descriptor !== null)
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

/**
 * Convert a pi transcript into an OMP v3 transcript. OMP's chain reader
 * rebuilds history from `parentId` links, so every converted entry gets a
 * fresh sequential id chained to its predecessor; conversation semantics
 * (messages, tool calls, tool results, compactions, model/thinking changes)
 * pass through unchanged.
 */
export async function convertPiTranscript(input: {
  sourcePath: string;
}): Promise<{ sessionId: string; lines: string[] }> {
  const raw = await readFile(input.sourcePath, "utf8");
  const lines: string[] = [];
  let sessionId = "";
  let previousId: string | null = null;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id !== "string" || !entry.id) continue;
      sessionId = entry.id;
      // OMP session headers keep the session uuid as id and are not part of
      // the parentId chain (message chains start at parentId: null), matching
      // native OMP transcripts.
      lines.push(
        JSON.stringify({
          type: "session",
          version: 3,
          id: entry.id,
          timestamp:
            typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
          cwd: typeof entry.cwd === "string" ? entry.cwd : process.cwd(),
        }),
      );
      continue;
    }
    if (isDroppablePiEntry(entry)) continue;
    if (entry.type === "model_change") {
      const converted = convertPiModelChange(entry);
      if (!converted) continue;
      entry = converted;
    }
    const id = generateEntryId();
    lines.push(JSON.stringify({ ...entry, id, parentId: previousId }));
    previousId = id;
  }
  if (!sessionId) {
    throw new Error(`pi transcript has no session header: ${input.sourcePath}`);
  }
  return { sessionId, lines };
}

/**
 * Facade over the real OMP client: identical runtime (imported sessions run
 * on the OMP binary), but listing/import read external transcripts instead of
 * OMP's own session dir. `createSession` is deliberately inherited — the UI
 * never routes new-agent creation to import-only providers.
 */
export class PiImportClientFacade implements AgentClient {
  readonly provider = PI_PROVIDER_ID;
  readonly capabilities: AgentCapabilityFlags;

  constructor(
    private readonly ompClient: AgentClient,
    private readonly logger: Logger,
  ) {
    this.capabilities = {
      ...ompClient.capabilities,
      supportsSessionListing: true,
    };
    this.readHistoryPage = ompClient.readHistoryPage?.bind(ompClient);
    this.streamPersistedSubagentHistory = ompClient.streamPersistedSubagentHistory?.bind(ompClient);
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    return await listPiImportableSessions(options);
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const conversion = await convertPiTranscript({ sourcePath: input.providerHandleId });
    const source: ExternalSessionSourceInfo = {
      provider: PI_PROVIDER_ID,
      sessionId: conversion.sessionId,
      sourcePath: input.providerHandleId,
    };
    this.logger.info(
      { provider: PI_PROVIDER_ID, sessionId: conversion.sessionId },
      "Importing pi session into OMP runtime",
    );
    const { imported } = await importExternalSessionViaOmp({
      ompClient: this.ompClient,
      request: input,
      context,
      conversionSessionId: conversion.sessionId,
      convertedLines: conversion.lines,
      source,
    });
    return imported;
  }

  // Everything below delegates 1:1 to the OMP client: same binary, same
  // catalog, same session runtime.
  createSession: AgentClient["createSession"] = (...args) => this.ompClient.createSession(...args);
  readHistoryPage: AgentClient["readHistoryPage"];
  streamPersistedSubagentHistory: AgentClient["streamPersistedSubagentHistory"];
  resumeSession: AgentClient["resumeSession"] = (...args) => this.ompClient.resumeSession(...args);
  fetchCatalog: AgentClient["fetchCatalog"] = (...args) => this.ompClient.fetchCatalog(...args);
  isAvailable: AgentClient["isAvailable"] = (...args) => this.ompClient.isAvailable(...args);
  getDiagnostic?: AgentClient["getDiagnostic"] = (...args) =>
    (this.ompClient.getDiagnostic as NonNullable<AgentClient["getDiagnostic"]>)(...args);
}
