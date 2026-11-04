import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
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

import { importExternalSessionViaOmp, type ExternalSessionSourceInfo } from "./delegate.js";
import { readOmpSessionDescriptor } from "../omp/session-descriptor.js";
import { convertCodexTranscript, summarizeCodexSession } from "./codex-convert.js";

const CODEX_PROVIDER_ID = "codex";

/** Codex stores active rollouts under `~/.codex/sessions/YYYY/MM/DD/`. */
export function resolveCodexSessionsRoots(input?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string[] {
  const env = input?.env ?? process.env;
  const override = env.CODEX_HOME?.trim();
  const codexHome = override
    ? path.resolve(override)
    : path.join(input?.homeDir || homedir(), ".codex");
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

async function listCodexSessionFiles(input?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<string[]> {
  const files: string[] = [];
  for (const root of resolveCodexSessionsRoots(input)) {
    let rootEntries;
    try {
      rootEntries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    await collectJsonlFiles(root, rootEntries, files);
  }
  return files;
}

async function collectJsonlFiles(dir: string, entries: Dirent[], files: string[]): Promise<void> {
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      let subEntries;
      try {
        subEntries = await readdir(fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      await collectJsonlFiles(fullPath, subEntries, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

export async function listCodexImportableSessions(
  options?: ListImportableSessionsOptions & {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  },
): Promise<ImportableProviderSession[]> {
  const files = await listCodexSessionFiles(options);
  const descriptors = await Promise.all(
    files.map(async (filePath) => {
      const summary = await summarizeCodexSession(filePath).catch(() => null);
      if (!summary) return null;
      // The OMP descriptor reader cannot parse rollout headers; build the
      // list entry from the codex summary plus a bounded head/tail read for
      // title/preview via the shared reader on the converted head only.
      const firstPrompt = summary.firstUserMessage;
      const descriptor = await readOmpSessionDescriptor(filePath).catch(() => null);
      return {
        providerHandleId: filePath,
        cwd: summary.cwd,
        title: descriptor?.title ?? firstPrompt?.slice(0, 80) ?? null,
        firstPromptPreview: firstPrompt,
        lastPromptPreview: firstPrompt,
        lastActivityAt: (await statMtime(filePath)) ?? summary.createdAt,
      } satisfies ImportableProviderSession;
    }),
  );
  return descriptors
    .filter((descriptor): descriptor is ImportableProviderSession => descriptor !== null)
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

async function statMtime(filePath: string): Promise<Date | null> {
  try {
    return (await stat(filePath)).mtime;
  } catch {
    return null;
  }
}

/**
 * Facade over the real OMP client for codex imports. Listing reads codex
 * rollouts; import converts a rollout to OMP v3 JSONL, stages it, and resumes
 * through the native OMP runtime.
 */
export class CodexImportClientFacade implements AgentClient {
  readonly provider = CODEX_PROVIDER_ID;
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
    return await listCodexImportableSessions(options);
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const conversion = await convertCodexTranscript({ sourcePath: input.providerHandleId });
    const source: ExternalSessionSourceInfo = {
      provider: CODEX_PROVIDER_ID,
      sessionId: conversion.sessionId,
      sourcePath: input.providerHandleId,
    };
    this.logger.info(
      { provider: CODEX_PROVIDER_ID, sessionId: conversion.sessionId },
      "Importing codex session into OMP runtime",
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

  // Same binary, same catalog, same session runtime as OMP.
  createSession: AgentClient["createSession"] = (...args) => this.ompClient.createSession(...args);
  readHistoryPage: AgentClient["readHistoryPage"];
  streamPersistedSubagentHistory: AgentClient["streamPersistedSubagentHistory"];
  resumeSession: AgentClient["resumeSession"] = (...args) => this.ompClient.resumeSession(...args);
  fetchCatalog: AgentClient["fetchCatalog"] = (...args) => this.ompClient.fetchCatalog(...args);
  isAvailable: AgentClient["isAvailable"] = (...args) => this.ompClient.isAvailable(...args);
}
