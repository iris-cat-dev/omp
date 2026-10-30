// Agent Speed v1.5.0 Pi-family TaskLineReader/TaskComposer, OMP-only TypeScript port (MIT).
// The numeric monitor's tail-first parser is deliberately not part of this ordered stream.
import type {
  MonitorTaskAction,
  MonitorTaskEvent,
  MonitorTaskModelNote,
  MonitorTaskPrompt,
} from "./task-events.js";
import { timestamp } from "./parser.js";
import { isTaskContinuation } from "./task-score.js";
import {
  taskAnalyze,
  taskCommandText,
  taskEditHunks,
  taskFailures,
  taskReadResult,
  taskResultText,
} from "./task-parser.js";
import type { TaskCommandInfo } from "./task-parser-shell.js";
import {
  taskBlocks,
  taskEffort,
  taskInteger,
  taskJson,
  taskModel,
  taskObject,
  taskSha16,
} from "./task-parser-common.js";

export const TASK_READER_LIMITS = {
  maxLineBytes: 1_048_576,
  maxEvents: 16_384,
  maxEventBytes: 4_194_304,
  maxPendingCalls: 8192,
  maxPendingBytes: 1_048_576,
  maxCallBytes: 262_144,
  maxRequestKeys: 32_768,
  maxHunks: 256,
  maxResultLines: 8192,
};
interface TaggedEvent {
  value: MonitorTaskEvent;
  request: string | null;
}
interface Pending {
  action: MonitorTaskAction;
  info: TaskCommandInfo | null;
  text: string | null;
  cwd: string | null;
  bytes: number;
  runningJob?: string;
}
interface Span {
  start: number;
  end: number;
}
// Value locations preserve the reference's exact JSON input digest (including whitespace/key order),
// rather than hashing JSON.stringify's rewritten representation. Duplicate properties use the last one.
function skipValue(raw: string, start: number): number {
  let i = start;
  while (/[ \t\r\n]/.test(raw[i] ?? "") && i < raw.length) i++;
  if (raw[i] === '"') {
    i++;
    while (i < raw.length) {
      if (raw[i] === "\\") i += 2;
      else if (raw[i++] === '"') break;
    }
    return i;
  }
  if (raw[i] === "{" || raw[i] === "[") {
    let depth = 0;
    for (; i < raw.length; i++) {
      if (raw[i] === '"') {
        i = skipValue(raw, i) - 1;
        continue;
      }
      if (raw[i] === "{" || raw[i] === "[") depth++;
      else if ((raw[i] === "}" || raw[i] === "]") && --depth === 0) return i + 1;
    }
    return i;
  }
  while (i < raw.length && !/[,}\] \t\r\n]/.test(raw[i])) i++;
  return i;
}
function fields(raw: string, start = 0): Map<string, Span> {
  const result = new Map<string, Span>();
  let i = start;
  while (i < raw.length && /[ \t\r\n]/.test(raw[i])) i++;
  if (raw[i++] !== "{") return result;
  while (i < raw.length) {
    while (i < raw.length && /[ \t\r\n,]/.test(raw[i])) i++;
    if (raw[i] !== '"') break;
    const keyEnd = skipValue(raw, i),
      key = taskJson(raw.slice(i, keyEnd));
    i = keyEnd;
    while (i < raw.length && /[ \t\r\n:]/.test(raw[i])) i++;
    const end = skipValue(raw, i);
    if (typeof key === "string") result.set(key, { start: i, end });
    if (end <= i) break;
    i = end;
  }
  return result;
}
function rawInputs(raw: string): (Span | null)[] {
  const message = fields(raw).get("message");
  if (!message) return [];
  const content = fields(raw, message.start).get("content");
  if (!content || raw[content.start] !== "[") return [];
  const spans: (Span | null)[] = [];
  let i = content.start + 1;
  while (i < content.end) {
    while (i < content.end && /[ \t\r\n,]/.test(raw[i])) i++;
    if (raw[i] === "]") break;
    const end = skipValue(raw, i);
    spans.push(fields(raw, i).get("arguments") ?? null);
    if (end <= i) break;
    i = end;
  }
  return spans;
}
interface UsageMessage extends Record<string, unknown> {
  role: "assistant";
  model: string;
  provider: string;
  api: string;
}
function isUsageMessage(message: Record<string, unknown> | null): message is UsageMessage {
  return (
    message?.role === "assistant" &&
    typeof message.model === "string" &&
    typeof message.provider === "string" &&
    typeof message.api === "string" &&
    taskObject(message.usage) !== null
  );
}
function inputDigest(raw: string, input: unknown, span: Span | null | undefined): string {
  if (input == null) return taskSha16("");
  if (typeof input === "string") return taskSha16(input);
  if (span) return taskSha16(raw.slice(span.start, span.end));
  return taskSha16(JSON.stringify(input));
}
function asyncJobKey(message: Record<string, unknown>): string | null {
  const job = taskObject(taskObject(message.details)?.async);
  if (
    job?.type !== "bash" ||
    typeof job.jobId !== "string" ||
    job.jobId.length === 0 ||
    job.jobId.length > 128
  )
    return null;
  return taskSha16(job.jobId);
}
function resultBlockText(content: unknown, block: unknown): string {
  if (typeof content === "string") return content;
  const value = taskObject(block);
  if (
    value &&
    ["text", "input_text", "output_text"].includes(String(value.type)) &&
    typeof value.text === "string"
  )
    return value.text;
  return "";
}
function resultLinesExceeded(message: Record<string, unknown>): boolean {
  let lines = 0;
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  for (const block of blocks) {
    const text = resultBlockText(message.content, block);
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n" && !(text[i] === "\r" && text[i + 1] !== "\n")) continue;
      if (++lines > TASK_READER_LIMITS.maxResultLines) return true;
    }
  }
  return false;
}
function retainedEventBytes(value: MonitorTaskEvent): number {
  if (value.type === "prompt") return 64;
  return (
    160 +
    value.tool.length * 2 +
    (value.hunks?.length ?? 0) * 96 +
    (value.failures?.fingerprints.length ?? 0) * 24 +
    (value.outcome ? 96 : 0)
  );
}
export class OmpTaskLineReader {
  readonly events: TaggedEvent[] = [];
  readonly notes: MonitorTaskModelNote[] = [];
  readonly requests = new Map<string, number>();
  revision = 0;
  limited = false;
  saturated = false;
  lastLineMs = 0;
  headerSeen = false;
  private headerMs: number | null = null;
  private cwd: string | null = null;
  private model: string | null = null;
  private effort: string | null = null;
  private pendingPrompt: TaggedEvent | null = null;
  private readonly calls = new Map<string, Pending | null>();
  private pendingBytes = 0;
  private eventBytes = 0;
  private outsideTask = false;
  private readonly incompleteTasks = new Set<MonitorTaskEvent>();
  constructor(private floorMs = -Infinity) {}
  get retainedBytes(): number {
    return (
      this.eventBytes +
      this.pendingBytes +
      this.calls.size * 80 +
      this.requests.size * 56 +
      this.notes.length * 96
    );
  }
  get hasIncompleteCurrentTask(): boolean {
    return this.outsideTask;
  }
  read(raw: string): void {
    if (this.saturated) return;
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const value = taskObject(taskJson(raw));
    if (!value) {
      if (raw.trim()) this.markGap();
      return;
    }
    const t = timestamp(value.timestamp);
    if (value.type === "session") {
      this.readHeader(value, t);
      return;
    }
    if (
      !this.headerSeen ||
      typeof value.id !== "string" ||
      t === null ||
      (this.headerMs !== null && t < this.headerMs - 2000)
    )
      return;
    this.lastLineMs = Math.max(this.lastLineMs, t);
    const message = taskObject(value.message);
    if (value.type !== "message" || !message) {
      this.note(value, message, t);
      return;
    }
    if (message.role === "user") this.readPrompt(message, t);
    else if (isUsageMessage(message)) {
      if (!this.readAssistant(raw, value.id, message, t)) return;
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      if (!this.readToolResult(message.toolCallId, message, t)) return;
    }
    this.note(value, message, t);
  }
  private readHeader(value: Record<string, unknown>, t: number | null): void {
    if (this.headerSeen) return;
    this.headerSeen = true;
    this.headerMs = t;
    this.cwd = typeof value.cwd === "string" && value.cwd.length <= 4096 ? value.cwd : null;
    if (t !== null) this.lastLineMs = Math.max(this.lastLineMs, t);
  }
  private readPrompt(message: Record<string, unknown>, t: number): void {
    const content = message.content,
      blocks = Array.isArray(content) ? content : null;
    const hasPrompt =
      typeof content === "string"
        ? !!content
        : !!blocks?.some((b) => {
            const o = taskObject(b);
            return (
              o?.type === "image" || (o?.type === "text" && typeof o.text === "string" && !!o.text)
            );
          });
    if (!hasPrompt) return;
    const continuation = isTaskContinuation(taskBlocks(content));
    if (!continuation) {
      // Before the retained calendar window, only the task crossing its boundary can matter.
      // Keep that task in full, rather than discarding its earlier edits/proofs or inventing a partial score.
      if (t < this.floorMs) this.clearBeforePrompt();
      this.outsideTask = false;
    }
    const prompt: MonitorTaskPrompt = { t, type: "prompt", continuation };
    const tagged = this.add(prompt, null);
    if (tagged) this.pendingPrompt = tagged;
  }
  private clearBeforePrompt(): void {
    for (const call of this.calls.values()) {
      if (call === null) continue;
      this.limited = true;
      break;
    }
    const lastNote = this.notes.at(-1);
    this.events.length = this.notes.length = 0;
    this.requests.clear();
    this.calls.clear();
    this.incompleteTasks.clear();
    if (lastNote) this.notes.push(lastNote);
    this.pendingBytes = this.eventBytes = 0;
    this.pendingPrompt = null;
  }
  private resolvePrompt(key: string, duplicate: boolean): void {
    if (!this.pendingPrompt) return;
    if (duplicate) {
      const at = this.events.indexOf(this.pendingPrompt);
      if (at >= 0) {
        this.events.splice(at, 1);
        this.eventBytes -= 64;
        this.revision++;
      }
    } else this.pendingPrompt.request = key;
    this.pendingPrompt = null;
  }
  private readAssistant(
    raw: string,
    id: string,
    message: Record<string, unknown>,
    t: number,
  ): boolean {
    const key = taskSha16("omp:" + id + ":" + (taskInteger(message.timestamp) ?? t));
    const duplicate = this.requests.has(key);
    this.resolvePrompt(key, duplicate);
    if (duplicate) return true;
    if (this.requests.size >= TASK_READER_LIMITS.maxRequestKeys) {
      this.limited = this.saturated = true;
      return false;
    }
    this.requests.set(key, t);
    const content = Array.isArray(message.content) ? message.content : [],
      spans = rawInputs(raw);
    for (let index = 0; index < content.length; index++)
      if (!this.readCall(raw, content[index], spans[index], key, t)) return false;
    return true;
  }
  private readCall(
    raw: string,
    blockValue: unknown,
    span: Span | null | undefined,
    request: string,
    t: number,
  ): boolean {
    const block = taskObject(blockValue);
    if (
      block?.type !== "toolCall" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    )
      return true;
    const id = taskSha16(block.id);
    if (this.calls.has(id)) return true;
    const input = block.arguments,
      digest = inputDigest(raw, input, span),
      commandText = taskCommandText(block.name, input);
    if (
      block.name.length > 160 ||
      (commandText !== null && Buffer.byteLength(commandText) > TASK_READER_LIMITS.maxCallBytes)
    ) {
      this.markGap();
      return false;
    }
    const analyzed = taskAnalyze(block.name, input, this.cwd),
      action: MonitorTaskAction = {
        t,
        type: "action",
        kind: analyzed.kind,
        tool: block.name,
        digest,
      };
    if (analyzed.info)
      action.command = {
        class: analyzed.info.class,
        suite: analyzed.info.suite,
        targeted: analyzed.info.targeted,
        key: analyzed.info.key,
      };
    if (analyzed.kind === "edit") {
      const hunks = taskEditHunks(block.name, input, this.cwd, analyzed.shell);
      if (hunks.length > TASK_READER_LIMITS.maxHunks) this.markGap();
      action.hunks = hunks.slice(0, TASK_READER_LIMITS.maxHunks);
    }
    if (!this.add(action, request)) return false;
    this.retainCall(id, action, analyzed.info, analyzed.text);
    return true;
  }
  private retainCall(
    id: string,
    action: MonitorTaskAction,
    info: TaskCommandInfo | null,
    commandText: string | null,
  ): void {
    // No input object is retained: hunks already reduced; only a shell's text is needed for masked status.
    let text = info?.masked ? commandText : null;
    const bytes = text === null ? 0 : Buffer.byteLength(text);
    if (bytes > TASK_READER_LIMITS.maxCallBytes) {
      text = null;
      this.limited = true;
    }
    this.calls.set(id, {
      action,
      info,
      text,
      cwd: info ? this.cwd : null,
      bytes: text === null ? 0 : bytes,
    });
    this.pendingBytes += text === null ? 0 : bytes;
    this.trimPending();
  }
  private readToolResult(toolCallId: string, message: Record<string, unknown>, t: number): boolean {
    const id = taskSha16(toolCallId),
      call = this.calls.get(id);
    if (!call) return true;
    const jobKey = asyncJobKey(message);
    // A detached job may settle only an exact original call/job pair, never a later prose follow-up.
    if (call.runningJob && jobKey !== call.runningJob) return false;
    if (resultLinesExceeded(message)) {
      this.calls.set(id, null);
      this.pendingBytes -= call.bytes;
      this.markGap();
      return false;
    }
    const read = taskReadResult(message, t, call.text, call.info, call.cwd);
    call.action.outcome = read.outcome;
    if (read.state === "running" && jobKey) call.runningJob = jobKey;
    else {
      this.calls.set(id, null);
      this.pendingBytes -= call.bytes;
      if (call.info && read.state !== "running")
        call.action.failures = taskFailures(
          call.info,
          taskResultText(message),
          call.cwd,
          read.outcome.failed,
        );
      this.eventBytes += (call.action.failures?.fingerprints.length ?? 0) * 24 + 96;
    }
    this.revision++;
    if (this.eventBytes > TASK_READER_LIMITS.maxEventBytes) this.limited = this.saturated = true;
    return true;
  }
  markGap(): void {
    this.limited = true;
    this.outsideTask = true;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const value = this.events[i].value;
      this.incompleteTasks.add(value);
      if (value.type === "prompt" && !value.continuation) break;
    }
    this.revision++;
  }
  private add(value: MonitorTaskEvent, request: string | null): TaggedEvent | null {
    const bytes =
      value.type === "prompt" ? 64 : 160 + value.tool.length * 2 + (value.hunks?.length ?? 0) * 96;
    if (
      this.events.length >= TASK_READER_LIMITS.maxEvents ||
      this.eventBytes + bytes > TASK_READER_LIMITS.maxEventBytes
    ) {
      this.limited = this.saturated = true;
      return null;
    }
    const entry = { value, request };
    this.events.push(entry);
    this.eventBytes += bytes;
    this.revision++;
    if (this.outsideTask) {
      this.incompleteTasks.add(value);
      this.limited = true;
    }
    return entry;
  }
  private trimPending(): void {
    // Insertion order bounds both unresolved inputs and answered-id marks; evicted inputs stay unknown.
    while (
      this.calls.size > TASK_READER_LIMITS.maxPendingCalls ||
      this.pendingBytes > TASK_READER_LIMITS.maxPendingBytes
    ) {
      const first = this.calls.entries().next().value as [string, Pending | null] | undefined;
      if (!first) break;
      this.calls.delete(first[0]);
      this.pendingBytes -= first[1]?.bytes ?? 0;
      this.limited = true;
    }
  }
  private note(
    value: Record<string, unknown>,
    message: Record<string, unknown> | null,
    t: number,
  ): void {
    if (value.type === "message" && isUsageMessage(message)) {
      this.model = taskModel(message.model);
      const effort = taskEffort(message.thinkingLevel ?? message.reasoningEffort);
      if (effort !== null) this.effort = effort;
    }
    if (value.type === "thinking_level_change") {
      const effort = taskEffort(value.thinkingLevel);
      if (effort !== null) this.effort = effort;
    }
    const last = this.notes.at(-1);
    if (last && last.model === this.model && last.effort === this.effort && t >= last.t) return;
    if (this.notes.length >= TASK_READER_LIMITS.maxEvents) {
      this.limited = this.saturated = true;
      return;
    }
    this.notes.push({ t, model: this.model, effort: this.effort });
    this.revision++;
  }
  snapshotEvents(owns: (request: string) => boolean): MonitorTaskEvent[] {
    // A copied prompt is owned by its following assistant response, as in TaskComposer.Withdraw.
    return this.events
      .filter((e) => !this.incompleteTasks.has(e.value) && (e.request === null || owns(e.request)))
      .map((e) => e.value);
  }
  advanceFloor(floorMs: number): void {
    if (floorMs <= this.floorMs) return;
    this.floorMs = floorMs;
    const cut = this.floorCut(floorMs);
    if (cut) this.discardBefore(cut);
    const retainedRequests = new Set<string>();
    for (const entry of this.events)
      if (entry.request !== null) retainedRequests.add(entry.request);
    for (const [key, t] of this.requests)
      if (t < floorMs && !retainedRequests.has(key)) this.requests.delete(key);
    let keepNote = 0;
    while (keepNote + 1 < this.notes.length && this.notes[keepNote + 1].t < floorMs) keepNote++;
    if (keepNote) this.notes.splice(0, keepNote);
    this.revision++;
  }
  private floorCut(floorMs: number): number {
    let cut = 0,
      start = 0;
    for (let i = 1; i <= this.events.length; i++) {
      const next = this.events[i]?.value;
      if (i < this.events.length && !(next?.type === "prompt" && !next.continuation)) continue;
      let end = -Infinity;
      for (let k = start; k < i; k++) {
        const value = this.events[k].value;
        end = Math.max(
          end,
          value.t,
          value.type === "action" ? (value.outcome?.t ?? -Infinity) : -Infinity,
        );
      }
      if (start !== cut || end >= floorMs) break;
      cut = i;
      start = i;
    }
    return cut;
  }
  private discardBefore(cut: number): void {
    const removed = new Set(this.events.splice(0, cut).map((e) => e.value));
    for (const value of removed) this.incompleteTasks.delete(value);
    if (this.pendingPrompt && removed.has(this.pendingPrompt.value)) this.pendingPrompt = null;
    for (const [id, call] of this.calls)
      if (!call || removed.has(call.action)) {
        this.pendingBytes -= call?.bytes ?? 0;
        this.calls.delete(id);
      }
    if (!this.events.length) this.outsideTask = true;
    this.eventBytes = this.events.reduce((bytes, e) => bytes + retainedEventBytes(e.value), 0);
  }
  clear(): void {
    this.events.length = this.notes.length = 0;
    this.requests.clear();
    this.calls.clear();
    this.incompleteTasks.clear();
    this.pendingPrompt = null;
    this.cwd = this.model = this.effort = null;
    this.pendingBytes = this.eventBytes = 0;
  }
}
