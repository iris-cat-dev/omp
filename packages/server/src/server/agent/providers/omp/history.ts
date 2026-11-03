import { access, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AgentProvider, AgentStreamEvent } from "../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";
import { OmpHistoryMapper, type OmpCapturedUserMessageEntry } from "./message-history.js";
import { OmpAgentMessageSchema, type OmpAgentMessage } from "./rpc-types.js";
import type { OmpRuntimeSession } from "./runtime.js";
import type { OmpSubagentSnapshot } from "./subagent-rpc.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";
import { buildOmpModelId, readOmpAssistantModel } from "./subagent-model.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

interface OmpSessionEntry {
  type?: string;
  id: string;
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

export interface OmpHistoryInput {
  sessionFile?: string;
  runtimeSession?: OmpRuntimeSession;
  provider: AgentProvider;
  subagentSnapshots?: readonly OmpSubagentSnapshot[];
  visitedSessionFiles?: Set<string>;
  blobDir?: string;
  onSubagentTranscript?: (id: string, messages: readonly OmpAgentMessage[]) => void;
  onOwnAssistant?: (message: Extract<OmpAgentMessage, { role: "assistant" }>) => void;
}

/** Replay native children even when the parent's durable timeline was already primed. */
export async function* streamOmpSubagentHistory(
  input: OmpHistoryInput,
): AsyncGenerator<AgentStreamEvent> {
  if (!input.sessionFile) return;
  const visitedSessionFiles = input.visitedSessionFiles ?? new Set<string>();
  if (visitedSessionFiles.has(input.sessionFile)) return;
  visitedSessionFiles.add(input.sessionFile);
  let entries: OmpSessionEntry[];
  try {
    entries = await readActiveOmpEntryChain(
      input.sessionFile,
      input.runtimeSession?.activeBranchEntryId,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const messages = entries.flatMap((entry) => {
    const message = mapEntryMessage(entry);
    return message ? [message] : [];
  });
  for (const transcript of readSubagentTranscripts(
    messages,
    input.sessionFile,
    input.subagentSnapshots,
  )) {
    yield* replaySubagentTranscript(
      transcript,
      input.provider,
      visitedSessionFiles,
      input.blobDir,
      input.subagentSnapshots,
      input.onSubagentTranscript,
    );
  }
}

export async function* streamOmpHistory(input: OmpHistoryInput): AsyncGenerator<AgentStreamEvent> {
  if (!input.sessionFile) {
    return;
  }
  const visitedSessionFiles = input.visitedSessionFiles ?? new Set<string>();
  if (visitedSessionFiles.has(input.sessionFile)) {
    return;
  }
  visitedSessionFiles.add(input.sessionFile);
  let entries: OmpSessionEntry[];
  let nativeHeaderMs: number | null = null;
  try {
    entries = await readActiveOmpEntryChain(
      input.sessionFile,
      input.runtimeSession?.activeBranchEntryId,
      (header) => {
        const stamp = normalizeProviderReplayTimestamp(header.timestamp);
        nativeHeaderMs = stamp ? new Date(stamp).getTime() : null;
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  yield* streamOmpHistoryEntries(
    { ...input, sessionFile: input.sessionFile, nativeHeaderMs },
    entries,
    visitedSessionFiles,
  );
}

async function* streamOmpHistoryEntries(
  input: OmpHistoryInput & { sessionFile: string; nativeHeaderMs: number | null },
  entries: readonly OmpSessionEntry[],
  visitedSessionFiles: Set<string>,
  subagentId?: string,
): AsyncGenerator<AgentStreamEvent> {
  const messages: OmpAgentMessage[] = [];
  const userEntries: OmpCapturedUserMessageEntry[] = [];
  collectOmpHistoryMessages(entries, messages, userEntries);
  if (subagentId) input.onSubagentTranscript?.(subagentId, messages);
  const imageOutputDir =
    input.blobDir ?? join(dirname(resolveOmpDiagnosticPaths().agentDb), "blobs");
  const mapper = new OmpHistoryMapper(input.provider, userEntries, {
    ...OMP_HISTORY_MAPPER_HOOKS,
    mapToolDetail: (toolCall, result, context) =>
      mapOmpToolDetail(toolCall, result, { ...context, imageOutputDir }),
  });
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
    const ownsNativeUsage = observeNativeHistoryUsage(
      message,
      timestamp,
      input.nativeHeaderMs,
      subagentId ? undefined : input.onOwnAssistant,
    );
    await resolveMessageImageBlobs(message, input.blobDir);
    for (const event of mapper.mapMessages([message], { countNativeUsage: ownsNativeUsage })) {
      yield timestamp && event.type === "timeline" ? { ...event, timestamp } : event;
    }
  }
  for (const transcript of readSubagentTranscripts(
    messages,
    input.sessionFile,
    subagentId ? undefined : input.subagentSnapshots,
  )) {
    yield* replaySubagentTranscript(
      transcript,
      input.provider,
      visitedSessionFiles,
      input.blobDir,
      input.subagentSnapshots,
      input.onSubagentTranscript,
    );
  }
}

function collectOmpHistoryMessages(
  entries: readonly OmpSessionEntry[],
  messages: OmpAgentMessage[],
  userEntries: OmpCapturedUserMessageEntry[],
): void {
  for (const entry of entries) {
    const mapped = mapEntryMessage(entry);
    if (!mapped) continue;
    messages.push(mapped);
    if (mapped.role === "user") {
      userEntries.push({ id: entry.id, text: textOf(mapped.content) });
    }
  }
}

function observeNativeHistoryUsage(
  message: OmpAgentMessage,
  timestamp: string | null,
  nativeHeaderMs: number | null,
  onOwnAssistant?: (message: Extract<OmpAgentMessage, { role: "assistant" }>) => void,
): boolean {
  // A copied response can fall inside the replay tolerance, but is not this file's own speed reference.
  const ownsNativeUsage =
    nativeHeaderMs !== null &&
    timestamp !== null &&
    new Date(timestamp).getTime() >= nativeHeaderMs &&
    (message.role !== "assistant" ||
      (typeof message.timestamp === "number" && message.timestamp >= nativeHeaderMs));
  if (message.role === "assistant" && ownsNativeUsage) onOwnAssistant?.(message);
  return ownsNativeUsage;
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
  snapshots?: readonly OmpSubagentSnapshot[],
  onSubagentTranscript?: OmpHistoryInput["onSubagentTranscript"],
): AsyncGenerator<AgentStreamEvent> {
  const snapshot = snapshots?.find((child) => child.id === transcript.id);
  if (snapshot) {
    transcript.sessionFile = snapshot.sessionFile ?? transcript.sessionFile;
    transcript.title = snapshot.agent;
    transcript.toolCallId = snapshot.parentToolCallId ?? transcript.toolCallId;
  }
  if (visitedSessionFiles.has(transcript.sessionFile)) return;
  visitedSessionFiles.add(transcript.sessionFile);
  let nativeHeaderMs: number | null = null;
  const childEntries = await readActiveOmpEntryChain(
    transcript.sessionFile,
    undefined,
    (header) => {
      const stamp = normalizeProviderReplayTimestamp(header.timestamp);
      nativeHeaderMs = stamp ? new Date(stamp).getTime() : null;
    },
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const resolvedModel = extractOmpSubagentModel(childEntries);
  const firstTimestamp = normalizeProviderReplayTimestamp(childEntries[0]?.timestamp);
  yield subagentUpsert(transcript, provider, undefined, firstTimestamp, resolvedModel);
  for await (const event of streamOmpHistoryEntries(
    {
      sessionFile: transcript.sessionFile,
      provider,
      blobDir,
      subagentSnapshots: snapshots,
      onSubagentTranscript,
      nativeHeaderMs,
    },
    childEntries,
    visitedSessionFiles,
    transcript.id,
  )) {
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
  const status = snapshot
    ? nativeSubagentStatus(snapshot.status)
    : await recoverPersistedSubagentStatus(transcript, childEntries);
  yield subagentUpsert(transcript, provider, status, lastTimestamp, resolvedModel);
}

function subagentUpsert(
  transcript: OmpSubagentTranscript,
  provider: AgentProvider,
  status: OmpSubagentTranscript["status"],
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
      ...(status ? { status } : {}),
      toolCallId: transcript.toolCallId,
      ...(timestamp ? { timestamp } : {}),
    },
  };
}

interface OmpSubagentTranscript {
  id: string;
  title: string;
  toolCallId?: string;
  sessionFile: string;
  status?: "running" | "completed" | "failed" | "canceled";
}

function readSubagentTranscripts(
  messages: readonly OmpAgentMessage[],
  parentSessionFile: string,
  snapshots?: readonly OmpSubagentSnapshot[],
): OmpSubagentTranscript[] {
  const taskCalls = collectTaskCalls(messages);
  const transcripts = new Map<string, OmpSubagentTranscript>();
  for (const message of messages) {
    const details =
      recordOf(Reflect.get(message, "details")) ?? recordOf(recordOf(message.content)?.details);
    if (message.role === "custom" && Reflect.get(message, "customType") === "async-result") {
      const jobs = details?.jobs;
      if (!Array.isArray(jobs)) continue;
      for (const value of jobs) {
        const job = recordOf(value);
        if (!job || job.type !== "task") continue;
        const id = typeof job.agentId === "string" ? job.agentId : job.jobId;
        if (typeof id !== "string" || !id) continue;
        const existing = transcripts.get(id);
        transcripts.set(id, {
          id,
          title: existing?.title ?? (typeof job.label === "string" ? job.label : "OMP subagent"),
          toolCallId: existing?.toolCallId ?? String(job.jobId),
          sessionFile: existing?.sessionFile ?? childSessionFile(parentSessionFile, id),
          status: nativeSubagentStatus(job.status),
        });
      }
      continue;
    }
    if (message.role !== "toolResult" || message.toolName !== "task") continue;
    const title = taskCalls.get(message.toolCallId)?.title ?? "OMP subagent";
    const results = readTaskResults(message);
    const resultIds = new Set(results.map((result) => result.id));
    const progress = details?.progress;
    if (Array.isArray(progress)) {
      for (const value of progress) {
        const child = recordOf(value);
        if (!child || typeof child.id !== "string" || !child.id || resultIds.has(child.id))
          continue;
        const existing = transcripts.get(child.id);
        transcripts.set(child.id, {
          id: child.id,
          title: typeof child.agent === "string" ? child.agent : (existing?.title ?? title),
          toolCallId: message.toolCallId,
          sessionFile:
            typeof child.sessionFile === "string"
              ? child.sessionFile
              : (existing?.sessionFile ?? childSessionFile(parentSessionFile, child.id)),
          // The dispatch-time running/pending row says nothing about the history's current state.
          status:
            child.status === "running" || child.status === "pending"
              ? undefined
              : nativeSubagentStatus(child.status),
        });
      }
    }
    for (const result of results) {
      const existing = transcripts.get(result.id);
      transcripts.set(result.id, {
        id: result.id,
        title: result.agent ?? existing?.title ?? title,
        toolCallId: message.toolCallId,
        sessionFile:
          result.sessionFile ??
          existing?.sessionFile ??
          childSessionFile(parentSessionFile, result.id),
        status: taskResultStatus(result),
      });
    }
    const async = recordOf(details?.async);
    if (
      results.length === 0 &&
      (!Array.isArray(progress) || progress.length === 0) &&
      async?.type === "task" &&
      typeof async.jobId === "string"
    ) {
      const id = async.jobId;
      transcripts.set(id, {
        id,
        title,
        toolCallId: message.toolCallId,
        sessionFile: childSessionFile(parentSessionFile, id),
        status: async.state === "running" ? undefined : nativeSubagentStatus(async.state),
      });
    }
    if (results.length > 0 || (Array.isArray(progress) && progress.length > 0) || async) continue;
    const legacy = readLegacyTranscript(message, title);
    if (legacy) transcripts.set(legacy.id, legacy);
  }
  // Root snapshots can predate the parent task result; never rediscover the root roster in recursion.
  for (const snapshot of snapshots ?? []) {
    if (!snapshot.sessionFile) continue;
    const existing = transcripts.get(snapshot.id);
    transcripts.set(snapshot.id, {
      id: snapshot.id,
      title: snapshot.agent,
      toolCallId: snapshot.parentToolCallId ?? existing?.toolCallId,
      sessionFile: snapshot.sessionFile,
      status: nativeSubagentStatus(snapshot.status),
    });
  }
  return [...transcripts.values()];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function childSessionFile(parentSessionFile: string, id: string): string {
  return join(stripExtension(parentSessionFile), `${id}.jsonl`);
}

function nativeSubagentStatus(status: unknown): OmpSubagentTranscript["status"] {
  if (status === "pending" || status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted" || status === "canceled" || status === "cancelled") return "canceled";
  return undefined;
}

async function recoverPersistedSubagentStatus(
  transcript: OmpSubagentTranscript,
  entries: readonly OmpSessionEntry[],
): Promise<OmpSubagentTranscript["status"]> {
  try {
    await access(`${transcript.sessionFile}.tombstone`);
    return "canceled";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (transcript.status) return transcript.status;
  let exit: Record<string, unknown> | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.customType === "session_exit") {
      exit ??= recordOf(entry.data);
      continue;
    }
    const message = entry.message;
    if (!message) continue;
    if (message.role === "assistant") {
      if (message.stopReason === "aborted") return "canceled";
      if (message.stopReason === "error" || message.errorMessage) return "failed";
      if (
        Array.isArray(message.content) &&
        !message.content.some((block) => recordOf(block)?.type === "toolCall")
      )
        return "completed";
    }
    if (message.role === "toolResult" && message.toolName === "yield")
      return message.isError ? "failed" : "completed";
    if (exit?.kind === "fatal") return "failed";
    if (
      exit?.kind === "normal" &&
      (!Array.isArray(exit.pendingToolCalls) || exit.pendingToolCalls.length === 0)
    )
      return "completed";
    // An unfinished transcript without an authoritative live roster is interrupted, not still running.
    return "canceled";
  }
  return "canceled";
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
  sessionFile?: string;
}

function readTaskResults(
  message: Extract<OmpAgentMessage, { role: "toolResult" }>,
): OmpTaskResult[] {
  const details = recordOf(message.details) ?? recordOf(recordOf(message.content)?.details);
  const results = details?.results;
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
        ...(typeof Reflect.get(result, "sessionFile") === "string"
          ? { sessionFile: Reflect.get(result, "sessionFile") as string }
          : {}),
        aborted: Reflect.get(result, "aborted") === true,
      },
    ];
  });
}

function taskResultStatus(result: OmpTaskResult): "completed" | "failed" | "canceled" {
  if (result.aborted) return "canceled";
  if (result.error || (result.exitCode !== undefined && result.exitCode !== 0)) return "failed";
  return "completed";
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
  onSessionHeader?: (header: OmpSessionEntry) => void,
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
  const header = entries.find((entry) => entry.type === "session");
  if (header) onSessionHeader?.(header);
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let leafId: string | undefined;
  let selfSelectedLeafId: string | undefined;
  for (const entry of entries) {
    if (typeof entry.activeLeafId === "string") leafId = entry.activeLeafId;
    else if (entry.activeLeafId === null) leafId = undefined;
    else leafId = selfSelectedLeafId = entry.id;
  }
  if (leafId !== undefined && !byId.has(leafId)) leafId = selfSelectedLeafId;
  let current =
    (activeEntryId ? byId.get(activeEntryId) : undefined) ??
    (leafId ? byId.get(leafId) : undefined);
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
  // Native JSONL persists custom messages at the top level, unlike live role:custom messages.
  // `custom` entries are plugin state, not visible messages, and remain filtered below.
  if (entry.type === "custom_message") {
    if (typeof entry.customType !== "string") return null;
    const parsed = OmpAgentMessageSchema.safeParse({
      ...entry,
      role: "custom",
      entryId: entry.id,
    });
    return parsed.success ? parsed.data : null;
  }
  const message = entry.message;
  if (message && typeof message.role === "string") {
    if (message.role === "system" || message.role === "developer") {
      return null;
    }
    if (["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role)) {
      return {
        ...message,
        ...(message.role === "custom" || message.role === "assistant" ? { entryId: entry.id } : {}),
      } as unknown as OmpAgentMessage;
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
    type === "model_usage" ||
    type === "credential_pin" ||
    type === "ttsr_injection" ||
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
