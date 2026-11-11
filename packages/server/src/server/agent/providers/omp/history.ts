import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import type { AgentTimelineFetchOptions, AgentTimelineFetchResult, AgentTimelineRow } from "../../agent-timeline-store-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { selectProjectedTimelinePage, type TimelineProjectionMode } from "../../timeline-projection.js";
import { InMemoryAgentTimelineStore } from "../../agent-timeline-store.js";
import { isSystemInjectedEnvelope } from "../../agent-prompt.js";
import { resolveOmpSdkInstallation } from "./sdk-installation.js";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";
import { OmpHistoryMapper, type OmpCapturedUserMessageEntry, type OmpHistoryIdentityState } from "./message-history.js";
import { OmpAgentMessageSchema, type OmpAgentMessage } from "./rpc-types.js";
import type { OmpRuntimeSession } from "./runtime.js";
import type { OmpSubagentSnapshot } from "./subagent-rpc.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { resolveOmpDiagnosticPaths } from "./provider-config.js";
import { buildOmpModelId, readOmpAssistantModel } from "./subagent-model.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { readLocalSubmission } from "./local-submission.js";

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
  runtimeSettings?: Pick<ProviderRuntimeSettings, "ompSdkPath" | "env">;
  provider: AgentProvider;
  subagentSnapshots?: readonly OmpSubagentSnapshot[];
  visitedSessionFiles?: Set<string>;
  blobDir?: string;
  onSubagentTranscript?: (id: string, messages: readonly OmpAgentMessage[]) => void;
  onOwnAssistant?: (message: Extract<OmpAgentMessage, { role: "assistant" }>) => void;
}

interface OmpIndexedEntry {
  id: string;
  type: string;
  checksum: string;
  length: number;
  metadata: OmpSessionEntry;
}
interface OmpJournalStats {
  bytesRead: number;
  entriesParsed: number;
  indexBytesRead: number;
  indexEntriesParsed: number;
  entryBytesRead: number;
  entryEntriesParsed: number;
  indexedEntries: number;
  residentBodyBytes: number;
}
interface ColdHistoryIoStats {
  catalogBytesRead: number;
  catalogEntriesParsed: number;
  pageBytesRead: number;
  pageEntriesParsed: number;
  pageBlobBytesRead: number;
  pageBlobReads: number;
  discoveryBytesRead: number;
  discoveryEntriesParsed: number;
}
export interface OmpColdHistoryStats extends OmpJournalStats, ColdHistoryIoStats {}
interface OmpIndexedJournal {
  header?: OmpSessionEntry;
  sourceSize: number;
  generation: string;
  branch(leafId?: string): OmpIndexedEntry[];
  get(id: string): OmpIndexedEntry | undefined;
  readEntry(ref: OmpIndexedEntry): Promise<OmpSessionEntry>;
  getProjection<T>(key: string): T | undefined;
  setProjection(key: string, value: unknown): void;
  save(): Promise<void>;
  refresh(): Promise<void>;
  getStats(): OmpJournalStats;
}
interface ColdHistorySource {
  entryId: string;
  eventIndex: number;
  userIndex: number;
  assistantIndex: number;
  turnStart: number;
  branchIndex: number;
  toolDependency?: string;
  row: AgentTimelineRow;
}
interface ColdHistoryCatalog {
  generation: string;
  sourceSize: number;
  branchIds: string[];
  branchChecksums: string[];
  sources: ColdHistorySource[];
  identity: OmpHistoryIdentityState;
  toolCalls: Array<[string, string]>;
  subagentMessages?: OmpAgentMessage[];
}
interface OmpSubagentDiscoveryCatalog {
  generation: string;
  sourceSize: number;
  branchIds: string[];
  branchChecksums: string[];
  messages: OmpAgentMessage[];
}
const coldHistoryProjectionKey = (provider: AgentProvider): string => `desktop-timeline-v4:${provider}`;
const subagentDiscoveryProjectionKey = "desktop-subagent-discovery-v1";
const coldJournals = new Map<string, OmpIndexedJournal>();
const coldJournalModules = new Map<string, Promise<{ IndexedSessionJournal: { open(file: string): Promise<OmpIndexedJournal> } }>>();
const coldHistoryIo = new WeakMap<OmpIndexedJournal, ColdHistoryIoStats>();

function getColdHistoryIo(journal: OmpIndexedJournal): ColdHistoryIoStats {
  let stats = coldHistoryIo.get(journal);
  if (!stats) {
    stats = { catalogBytesRead: 0, catalogEntriesParsed: 0, pageBytesRead: 0, pageEntriesParsed: 0, pageBlobBytesRead: 0, pageBlobReads: 0, discoveryBytesRead: 0, discoveryEntriesParsed: 0 };
    coldHistoryIo.set(journal, stats);
  }
  return stats;
}

async function readColdHistoryBody(journal: OmpIndexedJournal, io: ColdHistoryIoStats, ref: OmpIndexedEntry, phase: "catalog" | "page" | "discovery"): Promise<OmpSessionEntry> {
  const current = journal.get(ref.id) ?? ref;
  const entry = await journal.readEntry(current);
  if (phase === "catalog") { io.catalogBytesRead += current.length; io.catalogEntriesParsed++; }
  else if (phase === "page") { io.pageBytesRead += current.length; io.pageEntriesParsed++; }
  else { io.discoveryBytesRead += current.length; io.discoveryEntriesParsed++; }
  return entry;
}

/** Uses the selected SDK's pure journal module, never a host process or a second scanner. */
export async function openOmpIndexedJournal(
  sessionFile: string,
  runtimeSettings?: OmpHistoryInput["runtimeSettings"],
): Promise<OmpIndexedJournal> {
  const installation = await resolveOmpSdkInstallation(runtimeSettings).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The selected OMP SDK is not a complete built Node SDK; cold history requires its indexed journal module, including when using a standalone CLI runtime", { cause: error });
    }
    throw error;
  });
  const key = `${installation.root}:${resolve(sessionFile)}`;
  const cached = coldJournals.get(key);
  if (cached) {
    coldJournals.delete(key);
    coldJournals.set(key, cached);
    await cached.refresh();
    return cached;
  }
  let module = coldJournalModules.get(installation.root);
  if (!module) {
    module = (async () => {
      const directory = await realpath(join(installation.root, "dist", "node"));
      const registry = JSON.parse(await readFile(join(directory, "modules.json"), "utf8")) as { version?: number; modules?: Record<string, unknown> };
      const entry = registry.modules?.["@oh-my-pi/pi-coding-agent/session/indexed-session-journal"];
      if (registry.version !== 1 || typeof entry !== "string" || isAbsolute(entry)) throw new Error("The selected OMP SDK has no indexed journal module");
      const filename = await realpath(resolve(directory, entry));
      const child = relative(directory, filename);
      if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("OMP journal module escapes the selected SDK directory");
      const loaded = await import(pathToFileURL(filename).href) as { IndexedSessionJournal?: { open(file: string): Promise<OmpIndexedJournal> } };
      if (typeof loaded.IndexedSessionJournal?.open !== "function") throw new Error("The selected OMP SDK journal module has an incompatible API");
      return { IndexedSessionJournal: loaded.IndexedSessionJournal };
    })();
    coldJournalModules.set(installation.root, module);
    void module.catch(() => coldJournalModules.delete(installation.root));
  }
  const journal = await (await module).IndexedSessionJournal.open(sessionFile);
  coldJournals.set(key, journal);
  while (coldJournals.size > 8) coldJournals.delete(coldJournals.keys().next().value!);
  return journal;
}

export function getOmpColdHistoryStats(sessionFile: string): OmpColdHistoryStats | undefined {
  for (const [key, journal] of coldJournals) if (key.endsWith(`:${resolve(sessionFile)}`)) return { ...journal.getStats(), ...getColdHistoryIo(journal) };
  return undefined;
}

function coldHistoryEvents(entry: OmpSessionEntry, mapper: OmpHistoryMapper, provider: AgentProvider, nativeHeaderMs: number | null): AgentStreamEvent[] {
  const timestamp = normalizeProviderReplayTimestamp(entry.timestamp);
  const localSubmission = readLocalSubmission(entry);
  if (localSubmission) return [{ type: "timeline", provider, item: localSubmission, ...(timestamp ? { timestamp } : {}) }];
  if (entry.type === "compaction") return [{ type: "timeline", provider, item: { type: "compaction", status: "completed", ...(typeof entry.tokensBefore === "number" ? { preTokens: entry.tokensBefore } : {}) }, ...(timestamp ? { timestamp } : {}) }];
  const message = mapEntryMessage(entry);
  if (!message) return [];
  return mapper.mapMessages([message], { countNativeUsage: observeNativeHistoryUsage(message, timestamp, nativeHeaderMs) })
    .filter((event) => event.type === "timeline" && !(event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)))
    .map((event) => timestamp ? { ...event, timestamp } : event);
}

function coldHistoryItemMetadata(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type === "tool_call") return { type: "tool_call", callId: item.callId, name: item.name, status: item.status, detail: { type: "plain_text", label: "", text: "" }, error: null, ...(item.metadata ? { metadata: { ...(typeof item.metadata.source === "string" ? { source: item.metadata.source } : {}) } } : {}) };
  if (item.type === "assistant_message") return { type: "assistant_message", text: "x", ...(item.messageId ? { messageId: item.messageId } : {}), ...(item.presentation ? { presentation: item.presentation } : {}), ...(item.customMessage ? { customMessage: { customType: item.customMessage.customType } } : {}) };
  if (item.type === "reasoning") return { type: "reasoning", text: "x" };
  if (item.type === "user_message") return { type: "user_message", text: "x", ...(item.messageId ? { messageId: item.messageId } : {}) };
  if (item.type === "compaction") return item;
  if (item.type === "todo") return { type: "todo", items: [] };
  if (item.type === "error") return { type: "error", message: "" };
  if (item.type === "extension_notification") return { type: "extension_notification", level: item.level, message: "" };
  return item;
}
export interface OmpHistoryPageInput extends OmpHistoryInput {
  sessionFile: string;
  epoch: string;
  timestamp: string;
  projection?: TimelineProjectionMode;
  onlyUserMessages?: boolean;
  options: AgentTimelineFetchOptions;
}

/** Build disposable event/projection metadata once, then only read requested source records. */
export async function readOmpHistoryPage(input: OmpHistoryPageInput): Promise<AgentTimelineFetchResult> {
  const journal = await openOmpIndexedJournal(input.sessionFile, input.runtimeSettings);
  const io = getColdHistoryIo(journal);
  const branch = journal.branch(input.runtimeSession?.activeBranchEntryId);
  const headerTimestamp = normalizeProviderReplayTimestamp(journal.header?.timestamp);
  const nativeHeaderMs = headerTimestamp ? new Date(headerTimestamp).getTime() : null;
  const userEntries = branch.filter((ref) => ref.metadata.message?.role === "user").map((ref) => ({ id: ref.id, text: "" }));
  const imageOutputDir = input.blobDir ?? join(dirname(resolveOmpDiagnosticPaths().agentDb), "blobs");
  const makeMapper = (indexing = false): OmpHistoryMapper => new OmpHistoryMapper(input.provider, userEntries, {
    ...OMP_HISTORY_MAPPER_HOOKS,
    mapToolDetail: (toolCall, result, context) => mapOmpToolDetail(toolCall, result, { ...context, ...(indexing ? {} : { imageOutputDir }) }),
  });
  const projectionKey = coldHistoryProjectionKey(input.provider);
  let catalog = journal.getProjection<ColdHistoryCatalog>(projectionKey);
  const prefixMatches = catalog?.branchIds.every((id, index) => id === branch[index]?.id && catalog!.branchChecksums[index] === branch[index]?.checksum) ?? false;
  if (catalog && !catalog.subagentMessages && catalog.generation === journal.generation && prefixMatches) {
    // Upgrade an old metadata catalog sparsely; never replay unrelated results to add discovery metadata.
    const messages = catalog.branchIds.length
      ? await readActiveOmpSubagentMessages(input.sessionFile, input.provider, catalog.branchIds.at(-1), input.runtimeSettings)
      : [];
    catalog = { ...catalog, subagentMessages: [...messages] };
    journal.setProjection(projectionKey, catalog);
    await journal.save();
  }
  if (catalog && catalog.generation === journal.generation && prefixMatches && catalog.branchIds.length === branch.length && catalog.sourceSize !== journal.sourceSize) {
    // A late-usage/off-branch append did not change the display branch at all.
    catalog = { ...catalog, sourceSize: journal.sourceSize };
    journal.setProjection(projectionKey, catalog);
    await journal.save();
  }
  if (!catalog || catalog.generation !== journal.generation || catalog.sourceSize !== journal.sourceSize || catalog.branchIds.length !== branch.length || !prefixMatches) {
    const incremental = catalog && catalog.generation === journal.generation && catalog.branchIds.length < branch.length && prefixMatches ? catalog : undefined;
    const mapper = makeMapper(true);
    const dependencies = new Map<string, string>(incremental?.toolCalls);
    const sources: ColdHistorySource[] = incremental ? incremental.sources.slice() : [];
    const subagentMessages = incremental?.subagentMessages?.slice() ?? [];
    let userIndex = incremental?.identity.userIndex ?? 0;
    let assistantIndex = incremental?.identity.assistantIndex ?? 0;
    let turnStart = 0;
    const start = incremental?.branchIds.length ?? 0;
    if (incremental) {
      mapper.restoreHistoryIdentityState(incremental.identity);
      for (let index = start - 1; index >= 0; index--) if (branch[index]!.metadata.message?.role === "user") { turnStart = index; break; }
      for (let index = turnStart; index < start; index++) {
        const entry = branch[index]!.metadata;
        if (entry.message?.role === "assistant") mapper.mapMessages([{ ...entry.message, role: "assistant", content: [], entryId: entry.id } as unknown as OmpAgentMessage]);
      }
      mapper.restoreHistoryPosition(userIndex, assistantIndex, false);
    }
    for (let branchIndex = start; branchIndex < branch.length; branchIndex++) {
      const ref = branch[branchIndex]!;
      const entry = await readColdHistoryBody(journal, io, ref, "catalog");
      const message = mapEntryMessage(entry);
      const discoveryMessage = captureOmpSubagentMessage(message);
      if (discoveryMessage) subagentMessages.push(discoveryMessage);
      const beforeUser = userIndex;
      const beforeAssistant = assistantIndex;
      if (message?.role === "user") { userIndex++; turnStart = branchIndex; }
      if (message?.role === "assistant") {
        assistantIndex++;
        for (const block of message.content) if (block.type === "toolCall") dependencies.set(block.id, ref.id);
      }
      // Index creation observes image presence but performs no image/blob I/O.
      if (message?.role === "user" && Array.isArray(message.content)) for (const block of message.content) if (block.type === "image") block.data = "";
      if (message?.role === "toolResult" && message.details && typeof message.details === "object") {
        const details = message.details as Record<string, unknown>;
        delete details.images;
        delete details.imagePaths;
      }
      if (incremental && message?.role === "toolResult") {
        const dependency = dependencies.get(message.toolCallId);
        if (dependency && incremental.branchIds.includes(dependency)) {
          const ref = journal.get(dependency);
          if (ref) { const prior = mapEntryMessage(await readColdHistoryBody(journal, io, ref, "catalog")); if (prior) mapper.mapMessages([prior], { countNativeUsage: false }); }
          mapper.restoreHistoryPosition(beforeUser, beforeAssistant, false);
        }
      }
      const events = coldHistoryEvents(entry, mapper, input.provider, nativeHeaderMs);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        const event = events[eventIndex]!;
        if (event.type !== "timeline") continue;
        sources.push({ entryId: ref.id, eventIndex, userIndex: beforeUser, assistantIndex: beforeAssistant, turnStart, branchIndex,
          ...(message?.role === "toolResult" && dependencies.has(message.toolCallId) ? { toolDependency: dependencies.get(message.toolCallId) } : {}),
          row: { seq: sources.length + 1, timestamp: event.timestamp ?? input.timestamp, item: coldHistoryItemMetadata(event.item) },
        });
      }
    }
    catalog = { generation: journal.generation, sourceSize: journal.sourceSize, branchIds: branch.map((ref) => ref.id), branchChecksums: branch.map((ref) => ref.checksum), sources, identity: mapper.getHistoryIdentityState(), toolCalls: [...dependencies], subagentMessages };
    journal.setProjection(projectionKey, catalog);
    await journal.save();
  }
  const epoch = `${input.epoch}:${catalog.generation}:${catalog.sourceSize}`;
  const direction = input.options.direction ?? "tail";
  const limit = Math.max(0, Math.floor(input.options.limit ?? 200));
  const cursor = input.options.cursor;
  const maxSeq = catalog.sources.length;
  const window = { minSeq: maxSeq ? 1 : 0, maxSeq, nextSeq: maxSeq + 1 };
  const staleCursor = !!cursor && cursor.epoch !== epoch;
  const gap = !!cursor && !staleCursor && (cursor.seq < 0 || (direction === "after" && cursor.seq > maxSeq));
  const reset = staleCursor || gap || (direction === "after" && !!cursor && cursor.contentVersion !== 0);
  const effectiveDirection = reset ? "tail" : direction;
  let selected: ColdHistorySource[];
  if (input.projection === "projected") {
    const page = selectProjectedTimelinePage({ rows: catalog.sources.map((source) => source.row), bounds: window, direction: effectiveDirection, ...(cursor && !reset ? { cursorSeq: cursor.seq } : {}), limit });
    const ranges = page.entries.flatMap((entry) => entry.sourceSeqRanges);
    selected = catalog.sources.filter((source) => ranges.some((range) => source.row.seq >= range.startSeq && source.row.seq <= range.endSeq));
  } else {
    const candidates = catalog.sources.filter((source) => effectiveDirection === "after" ? source.row.seq > (cursor?.seq ?? 0) : effectiveDirection === "before" ? source.row.seq < (cursor?.seq ?? window.nextSeq) : true);
    selected = limit === 0 ? candidates : effectiveDirection === "after" ? candidates.slice(0, limit) : candidates.slice(-limit);
  }
  if (input.onlyUserMessages) selected = selected.filter((source) => source.row.item.type === "user_message");
  const bodies = new Map<string, Promise<OmpSessionEntry>>();
  const readBody = (id: string): Promise<OmpSessionEntry> => {
    let promise = bodies.get(id);
    if (!promise) { const ref = journal.get(id); if (!ref) throw new Error(`Cold history source ${id} disappeared`); promise = readColdHistoryBody(journal, io, ref, "page"); bodies.set(id, promise); }
    return promise;
  };
  const mappedEntries = new Map<string, Promise<AgentStreamEvent[]>>();
  const rows: AgentTimelineRow[] = [];
  for (const source of selected) {
    let events = mappedEntries.get(source.entryId);
    if (!events) {
      events = (async () => {
        const mapper = makeMapper();
        mapper.restoreHistoryPosition(source.userIndex, source.assistantIndex);
        // Native usage is reconstructed from small request metadata, not old bodies.
        for (let index = source.turnStart; index < source.branchIndex; index++) {
          const metadata = branch[index]!.metadata;
          if (metadata.message?.role !== "assistant") continue;
          const message = { ...metadata.message, role: "assistant", content: [], entryId: metadata.id } as unknown as OmpAgentMessage;
          mapper.mapMessages([message]);
        }
        mapper.restoreHistoryPosition(source.userIndex, source.assistantIndex, false);
        if (source.toolDependency) {
          const dependency = mapEntryMessage(await readBody(source.toolDependency));
          if (dependency) mapper.mapMessages([dependency], { countNativeUsage: false });
          mapper.restoreHistoryPosition(source.userIndex, source.assistantIndex, false);
        }
        const entry = await readBody(source.entryId);
        const message = mapEntryMessage(entry);
        if (message) await resolveMessageImageBlobs(message, input.blobDir, (bytes) => { io.pageBlobBytesRead += bytes; io.pageBlobReads++; });
        return coldHistoryEvents(entry, mapper, input.provider, nativeHeaderMs);
      })();
      mappedEntries.set(source.entryId, events);
    }
    const event = (await events)[source.eventIndex];
    if (!event || event.type !== "timeline") throw new Error(`Cold history event ${source.entryId}:${source.eventIndex} changed`);
    rows.push({ seq: source.row.seq, timestamp: source.row.timestamp, item: event.item, contentVersion: 0 });
  }
  await journal.refresh();
  if (journal.generation !== catalog.generation || journal.sourceSize !== catalog.sourceSize) {
    throw new Error("The native journal changed while reading this page; fetch history again with the new epoch.");
  }
  if (input.options.includeToolContextChanges) {
    const timeline = new InMemoryAgentTimelineStore();
    timeline.initialize("cold-context", { epoch });
    for (const row of rows) row.toolContextChanges = timeline.append("cold-context", row.item, { timestamp: row.timestamp, ...(row.turnId ? { turnId: row.turnId } : {}) }).toolContextChanges;
  }
  return { epoch, contentVersion: 0, direction, reset, staleCursor, gap, window,
    hasOlder: rows.length > 0 && rows[0]!.seq > window.minSeq,
    hasNewer: rows.length > 0 ? rows.at(-1)!.seq < window.maxSeq : effectiveDirection === "before" && !!cursor && cursor.seq <= window.maxSeq,
    rows,
  };
}

/** Replay native children even when the parent's durable timeline was already primed. */
export async function* streamOmpSubagentHistory(
  input: OmpHistoryInput,
): AsyncGenerator<AgentStreamEvent> {
  if (!input.sessionFile) return;
  const visitedSessionFiles = input.visitedSessionFiles ?? new Set<string>();
  if (visitedSessionFiles.has(input.sessionFile)) return;
  visitedSessionFiles.add(input.sessionFile);
  let messages: readonly OmpAgentMessage[];
  try {
    messages = await readActiveOmpSubagentMessages(input.sessionFile, input.provider, input.runtimeSession?.activeBranchEntryId, input.runtimeSettings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // These are compact discovery records, never the parent's timeline bodies.
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
      input.runtimeSettings,
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
      input.runtimeSettings,
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
    const localSubmission = readLocalSubmission(entry);
    if (localSubmission) {
      yield { type: "timeline", provider: input.provider, item: localSubmission, ...(timestamp ? { timestamp } : {}) };
      continue;
    }
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
      input.runtimeSettings,
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

async function resolveMessageImageBlobs(message: OmpAgentMessage, blobDir?: string, onBlobRead?: (bytes: number) => void): Promise<void> {
  if (message.role !== "user" || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type !== "image") continue;
    const match = /^blob:sha256:([a-f0-9]{64})$/.exec(block.data);
    if (!match) continue;
    blobDir ??= join(dirname(resolveOmpDiagnosticPaths().agentDb), "blobs");
    const bytes = await readFile(join(blobDir, match[1]!));
    onBlobRead?.(bytes.length);
    block.data = bytes.toString("base64");
  }
}

async function* replaySubagentTranscript(
  transcript: OmpSubagentTranscript,
  provider: AgentProvider,
  visitedSessionFiles: Set<string>,
  blobDir?: string,
  snapshots?: readonly OmpSubagentSnapshot[],
  onSubagentTranscript?: OmpHistoryInput["onSubagentTranscript"],
  runtimeSettings?: OmpHistoryInput["runtimeSettings"],
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
  let nativeHeaderTimestamp: string | null = null;
  const childEntries = await readActiveOmpEntryChain(
    transcript.sessionFile,
    undefined,
    (header) => {
      const stamp = normalizeProviderReplayTimestamp(header.timestamp);
      nativeHeaderTimestamp = stamp;
      nativeHeaderMs = stamp ? new Date(stamp).getTime() : null;
    },
    runtimeSettings,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const resolvedModel = extractOmpSubagentModel(childEntries);
  const firstTimestamp = nativeHeaderTimestamp ?? normalizeProviderReplayTimestamp(childEntries[0]?.timestamp);
  yield subagentUpsert(transcript, provider, undefined, firstTimestamp, resolvedModel);
  for await (const event of streamOmpHistoryEntries(
    {
      sessionFile: transcript.sessionFile,
      runtimeSettings,
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

/** Retain only fields consumed by child discovery, not parent output, task prompts, or images. */
function captureOmpSubagentMessage(message: OmpAgentMessage | null): OmpAgentMessage | null {
  if (!message) return null;
  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) return null;
    const content = message.content.flatMap((block) => {
      if (block.type !== "toolCall" || block.name !== "task" || typeof block.id !== "string") return [];
      const agent = recordOf(block.arguments)?.agent;
      return [{ type: "toolCall" as const, id: block.id, name: "task", arguments: typeof agent === "string" ? { agent } : {} }];
    });
    return content.length ? { role: "assistant", content } as OmpAgentMessage : null;
  }
  const details = recordOf(Reflect.get(message, "details")) ?? recordOf(recordOf(message.content)?.details);
  if (message.role === "custom" && Reflect.get(message, "customType") === "async-result") {
    const jobs = details?.jobs;
    if (!Array.isArray(jobs)) return null;
    return { role: "custom", customType: "async-result", content: "", details: { jobs: jobs.flatMap((value) => {
      const job = recordOf(value);
      if (job?.type !== "task") return [];
      const id = typeof job.agentId === "string" ? job.agentId : job.jobId;
      if (typeof id !== "string" || !id) return [];
      return [{ type: "task", jobId: String(job.jobId), ...(typeof job.agentId === "string" ? { agentId: job.agentId } : {}), ...(typeof job.label === "string" ? { label: job.label } : {}), status: nativeSubagentStatus(job.status) }];
    }) } } as OmpAgentMessage;
  }
  if (message.role !== "toolResult" || message.toolName !== "task") return null;
  const results = readTaskResults(message).map((result) => ({ ...result, error: !!result.error }));
  const progress = Array.isArray(details?.progress) ? details.progress.map((value) => {
    const child = recordOf(value);
    if (!child || typeof child.id !== "string" || !child.id) return {};
    return { id: child.id, ...(typeof child.agent === "string" ? { agent: child.agent } : {}),
      status: child.status === "running" || child.status === "pending" ? child.status : nativeSubagentStatus(child.status),
      ...(typeof child.sessionFile === "string" ? { sessionFile: child.sessionFile } : {}),
    };
  }) : undefined;
  const async = recordOf(details?.async);
  const legacy = results.length === 0 && !progress?.length && !async ? readLegacyTranscript(message, "") : null;
  return {
    role: "toolResult", toolName: "task", toolCallId: message.toolCallId, isError: !!message.isError,
    content: legacy ? [{ type: "text", text: `session: ${legacy.sessionFile}` }] : [],
    details: { results, ...(progress ? { progress } : {}), ...(async ? { async: {
      type: async.type === "task" ? "task" : undefined,
      state: nativeSubagentStatus(async.state) ? async.state : undefined,
      ...(typeof async.jobId === "string" ? { jobId: async.jobId } : {}),
    } } : {}) },
  } as OmpAgentMessage;
}

/** Sparse recovery over the selected journal; warm timeline catalogs require no parent body I/O. */
export async function readActiveOmpSubagentMessages(
  sessionFile: string,
  provider: AgentProvider,
  activeEntryId?: string,
  runtimeSettings?: OmpHistoryInput["runtimeSettings"],
): Promise<readonly OmpAgentMessage[]> {
  const journal = await openOmpIndexedJournal(sessionFile, runtimeSettings);
  const branch = journal.branch(activeEntryId);
  const generation = journal.generation;
  const sourceSize = journal.sourceSize;
  const prefixMatches = (catalog: OmpSubagentDiscoveryCatalog | ColdHistoryCatalog): boolean => {
    if (catalog.generation !== generation) return false;
    return catalog.branchIds.every((id, index) => id === branch[index]?.id && catalog.branchChecksums[index] === branch[index]?.checksum);
  };
  const timeline = journal.getProjection<ColdHistoryCatalog>(coldHistoryProjectionKey(provider));
  if (timeline?.subagentMessages && prefixMatches(timeline) && timeline.branchIds.length === branch.length && timeline.sourceSize === journal.sourceSize) return timeline.subagentMessages;
  const cached = journal.getProjection<OmpSubagentDiscoveryCatalog>(subagentDiscoveryProjectionKey);
  const incremental = cached && prefixMatches(cached) ? cached : undefined;
  if (incremental && incremental.branchIds.length === branch.length && incremental.sourceSize === journal.sourceSize) return incremental.messages;
  const messages = incremental ? incremental.messages.slice() : [];
  const io = getColdHistoryIo(journal);
  for (let index = incremental?.branchIds.length ?? 0; index < branch.length; index++) {
    const ref = branch[index]!;
    const role = ref.metadata.message?.role;
    // The journal does not index assistant content. Inspect one candidate at a time and immediately discard unrelated payloads.
    if (role !== "assistant" && !(role === "toolResult" && ref.metadata.message?.toolName === "task") && role !== "custom" && !(ref.type === "custom_message" && ref.metadata.customType === "async-result")) continue;
    const message = captureOmpSubagentMessage(mapEntryMessage(await readColdHistoryBody(journal, io, ref, "discovery")));
    if (message) messages.push(message);
  }
  await journal.refresh();
  if (journal.generation !== generation || journal.sourceSize !== sourceSize) {
    throw new Error("The native journal changed while discovering subagents; fetch history again with the new epoch.");
  }
  journal.setProjection(subagentDiscoveryProjectionKey, {
    generation, sourceSize,
    branchIds: branch.map((ref) => ref.id), branchChecksums: branch.map((ref) => ref.checksum), messages,
  } satisfies OmpSubagentDiscoveryCatalog);
  await journal.save();
  return messages;
}

export async function readActiveOmpEntryChain(
  sessionFile: string,
  activeEntryId?: string,
  onSessionHeader?: (header: OmpSessionEntry) => void,
  runtimeSettings?: OmpHistoryInput["runtimeSettings"],
): Promise<OmpSessionEntry[]> {
  const journal = await openOmpIndexedJournal(sessionFile, runtimeSettings);
  if (journal.header) onSessionHeader?.(journal.header);
  const chain: OmpSessionEntry[] = [];
  for (const ref of journal.branch(activeEntryId)) chain.push(await journal.readEntry(ref));
  return chain;
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
