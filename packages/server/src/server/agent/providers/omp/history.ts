import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AgentProvider, AgentStreamEvent } from "../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";
import { OmpHistoryMapper, type OmpCapturedUserMessageEntry } from "./message-history.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import type { OmpRuntimeSession } from "./runtime.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";
import { buildOmpModelId, readOmpAssistantModel } from "./subagent-model.js";

interface OmpSessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

function extractOmpSubagentModel(entries: readonly OmpSessionEntry[]): string | null {
  let resolvedModel: string | null = null;
  for (const entry of entries) {
    let candidate: string | null = null;
    if (entry.type === "model_change") {
      candidate =
        buildOmpModelId(entry.provider, entry.modelId) ??
        (typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null);
    } else if (entry.type === "message" && entry.message) {
      candidate = readOmpAssistantModel(entry.message);
    }
    resolvedModel = candidate ?? resolvedModel;
  }
  return resolvedModel;
}

export async function* streamOmpHistory(input: {
  sessionFile?: string;
  runtimeSession?: OmpRuntimeSession;
  provider: AgentProvider;
  visitedSessionFiles?: Set<string>;
  blobDir?: string;
}): AsyncGenerator<AgentStreamEvent> {
  if (!input.sessionFile) {
    return;
  }
  const visitedSessionFiles = input.visitedSessionFiles ?? new Set<string>();
  if (visitedSessionFiles.has(input.sessionFile)) {
    return;
  }
  visitedSessionFiles.add(input.sessionFile);
  let entries: OmpSessionEntry[];
  try {
    entries = await readActiveOmpEntryChain(
      input.sessionFile,
      input.runtimeSession?.activeBranchEntryId,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const messages: OmpAgentMessage[] = [];
  const userEntries: OmpCapturedUserMessageEntry[] = [];
  for (const entry of entries) {
    const mapped = mapEntryMessage(entry);
    if (!mapped) continue;
    messages.push(mapped);
    if (mapped.role === "user" && entry.id) {
      userEntries.push({ id: entry.id, text: textOf(mapped.content) });
    }
  }
  const mapper = new OmpHistoryMapper(input.provider, userEntries, OMP_HISTORY_MAPPER_HOOKS);
  for (const entry of entries) {
    const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
    if (entry.type === "compaction") {
      const event: AgentStreamEvent = {
        type: "timeline",
        provider: input.provider,
        item: {
          type: "compaction",
          status: "completed",
          ...(typeof entry.tokensBefore === "number" ? { preTokens: entry.tokensBefore } : {}),
        },
      };
      yield timestamp ? { ...event, timestamp } : event;
      continue;
    }
    const message = mapEntryMessage(entry);
    if (!message) continue;
    await resolveMessageImageBlobs(message, input.blobDir);
    for (const event of mapper.mapMessages([message])) {
      yield timestamp && event.type === "timeline" ? { ...event, timestamp } : event;
    }
  }
  for (const transcript of readSubagentTranscripts(messages, input.sessionFile)) {
    yield* replaySubagentTranscript(transcript, input.provider, visitedSessionFiles, input.blobDir);
  }
}

async function resolveMessageImageBlobs(message: OmpAgentMessage, blobDir?: string): Promise<void> {
  if (message.role !== "user" || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type !== "image") continue;
    const match = /^blob:sha256:([a-f0-9]{64})$/.exec(block.data);
    if (!match) continue;
    blobDir ??= join(dirname(resolveOmpDiagnosticPaths().agentDb), "blobs");
    block.data = (await readFile(join(blobDir, match[1]!))).toString("base64");
  }
}

async function* replaySubagentTranscript(
  transcript: OmpSubagentTranscript,
  provider: AgentProvider,
  visitedSessionFiles: Set<string>,
  blobDir?: string,
): AsyncGenerator<AgentStreamEvent> {
  const childEntries = await readActiveOmpEntryChain(transcript.sessionFile).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const resolvedModel = extractOmpSubagentModel(childEntries);
  const firstTimestamp = normalizeProviderReplayTimestamp(childEntries[0]?.timestamp);
  yield subagentUpsert(transcript, provider, "running", firstTimestamp, resolvedModel);
  for await (const event of streamOmpHistory({
    sessionFile: transcript.sessionFile,
    provider,
    visitedSessionFiles,
    blobDir,
  })) {
    if (event.type === "timeline") {
      yield {
        type: "provider_subagent",
        provider,
        event: {
          type: "timeline",
          id: transcript.id,
          item: event.item,
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        },
      };
    } else if (event.type === "provider_subagent") {
      yield event;
    }
  }
  const lastTimestamp = normalizeProviderReplayTimestamp(childEntries.at(-1)?.timestamp);
  yield subagentUpsert(transcript, provider, transcript.status, lastTimestamp, resolvedModel);
}

function subagentUpsert(
  transcript: OmpSubagentTranscript,
  provider: AgentProvider,
  status: OmpSubagentTranscript["status"] | "running",
  timestamp: string | null,
  resolvedModel: string | null,
): AgentStreamEvent {
  return {
    type: "provider_subagent",
    provider,
    event: {
      type: "upsert",
      id: transcript.id,
      title: transcript.title,
      model: resolvedModel,
      status,
      toolCallId: transcript.toolCallId,
      ...(timestamp ? { timestamp } : {}),
    },
  };
}

interface OmpSubagentTranscript {
  id: string;
  title: string;
  toolCallId: string;
  sessionFile: string;
  status: "completed" | "failed" | "canceled";
}

function readSubagentTranscripts(
  messages: readonly OmpAgentMessage[],
  parentSessionFile: string,
): OmpSubagentTranscript[] {
  const taskCalls = collectTaskCalls(messages);
  const transcripts: OmpSubagentTranscript[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "task") continue;
    const call = taskCalls.get(message.toolCallId);
    if (!call) continue;
    const results = readTaskResults(message);
    for (const result of results) {
      transcripts.push({
        id: result.id,
        title: result.agent ?? call.title,
        toolCallId: message.toolCallId,
        sessionFile: join(stripExtension(parentSessionFile), `${basename(result.id)}.jsonl`),
        status: taskResultStatus(result, message.isError === true),
      });
    }
    if (results.length > 0) continue;
    const legacy = readLegacyTranscript(message, call.title);
    if (legacy) transcripts.push(legacy);
  }
  return transcripts;
}

function collectTaskCalls(messages: readonly OmpAgentMessage[]): Map<string, { title: string }> {
  const taskCalls = new Map<string, { title: string }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.name !== "task" || typeof block.id !== "string") {
        continue;
      }
      const args = block.arguments;
      const title =
        args && typeof args === "object" && typeof Reflect.get(args, "agent") === "string"
          ? Reflect.get(args, "agent")
          : "OMP subagent";
      taskCalls.set(block.id, { title });
    }
  }
  return taskCalls;
}

function readLegacyTranscript(
  message: Extract<OmpAgentMessage, { role: "toolResult" }>,
  title: string,
): OmpSubagentTranscript | null {
  const text = taskResultText(message);
  const sessionFile = text.match(/(?:session|transcript)(?: file)?:\s*(?<path>\/\S+\.jsonl)/i)
    ?.groups?.path;
  if (!sessionFile) return null;
  const fileName = basename(sessionFile);
  const extension = extname(fileName);
  return {
    id: extension ? fileName.slice(0, -extension.length) : fileName,
    title,
    toolCallId: message.toolCallId,
    sessionFile,
    status: message.isError ? "failed" : "completed",
  };
}

interface OmpTaskResult {
  id: string;
  agent?: string;
  exitCode?: number;
  error?: unknown;
  aborted?: boolean;
}

function readTaskResults(
  message: Extract<OmpAgentMessage, { role: "toolResult" }>,
): OmpTaskResult[] {
  const details =
    Reflect.get(message, "details") ??
    (message.content && typeof message.content === "object"
      ? Reflect.get(message.content, "details")
      : undefined);
  const results =
    details && typeof details === "object" ? Reflect.get(details, "results") : undefined;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const id = Reflect.get(result, "id");
    if (typeof id !== "string" || !id) return [];
    const agent = Reflect.get(result, "agent");
    const exitCode = Reflect.get(result, "exitCode");
    return [
      {
        id,
        ...(typeof agent === "string" ? { agent } : {}),
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        error: Reflect.get(result, "error"),
        aborted: Reflect.get(result, "aborted") === true,
      },
    ];
  });
}

function taskResultStatus(
  result: OmpTaskResult,
  messageIsError: boolean,
): "completed" | "failed" | "canceled" {
  if (messageIsError || result.error || (result.exitCode !== undefined && result.exitCode !== 0)) {
    return "failed";
  }
  return result.aborted ? "canceled" : "completed";
}

function taskResultText(message: Extract<OmpAgentMessage, { role: "toolResult" }>): string {
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) =>
          block &&
          typeof block === "object" &&
          Reflect.get(block, "type") === "text" &&
          typeof Reflect.get(block, "text") === "string"
            ? [Reflect.get(block, "text") as string]
            : [],
        )
        .join("\n")
    : "";
}

function stripExtension(filePath: string): string {
  const extension = extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

export async function readActiveOmpEntryChain(
  sessionFile: string,
  activeEntryId?: string,
): Promise<OmpSessionEntry[]> {
  const content = await readFile(sessionFile, "utf8");
  const entries = content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as OmpSessionEntry;
      return value && typeof value === "object" && typeof value.id === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id!, entry]));
  const parentIds = new Set(entries.flatMap((entry) => (entry.parentId ? [entry.parentId] : [])));
  const leaves = entries.filter((entry) => !parentIds.has(entry.id!));
  let current: OmpSessionEntry | undefined =
    (activeEntryId ? byId.get(activeEntryId) : undefined) ?? leaves.at(-1) ?? entries.at(-1);
  const chain: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  while (current?.id && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.toReversed();
}

function mapEntryMessage(entry: OmpSessionEntry): OmpAgentMessage | null {
  const message = entry.message;
  if (message && typeof message.role === "string") {
    if (message.role === "system" || message.role === "developer") {
      return null;
    }
    if (["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role)) {
      return message as unknown as OmpAgentMessage;
    }
    return visibleFallback(message.role, message);
  }
  if (!entry.type || isControlEntryType(entry.type)) {
    return null;
  }
  return visibleFallback(entry.type, entry);
}

function isControlEntryType(type: string): boolean {
  return (
    type === "session" ||
    type === "session_init" ||
    type === "system" ||
    type === "title" ||
    type === "title_change" ||
    type === "custom" ||
    type === "system_prompt" ||
    type === "model_change" ||
    type === "credential_pin" ||
    type === "ttsr_injection" ||
    type === "custom_message" ||
    type === "thinking_level_change" ||
    type === "service_tier_change" ||
    type === "tool_execution" ||
    type === "compaction" ||
    type.startsWith("tool_execution_")
  );
}

function visibleFallback(role: string, value: Record<string, unknown>): OmpAgentMessage {
  let text = "Unsupported history record";
  if (typeof value.content === "string") {
    text = value.content;
  } else if (typeof value.text === "string") {
    text = value.text;
  }
  return { role: "custom", content: `[${role}] ${text}` } as OmpAgentMessage;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}
