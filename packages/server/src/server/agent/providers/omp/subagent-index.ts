import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentMessageSchema, type OmpAgentMessage, type OmpSubagentEventPayload, type OmpSubagentLifecyclePayload, type OmpSubagentProgressPayload } from "./rpc-types.js";
import { readOmpAssistantModel } from "./subagent-model.js";
import { OmpSubagentLiveMapper } from "./subagent-live-mapper.js";
import type { OmpSubagentSnapshot } from "./subagent-rpc.js";

export interface OmpSubagentNativeHistory {
  id: string;
  messages: readonly OmpAgentMessage[];
}

type ChildStatus = "running" | "completed" | "failed" | "canceled";
interface OmpSubagentState {
  title: string;
  description: string | null;
  resolvedModel: string | null;
  toolCallId: string | null;
  status: ChildStatus;
  announced: boolean;
  started: boolean;
  mapper: OmpSubagentLiveMapper;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    if (payload.status === "started") {
      if (state.started || state.status !== "running") state.mapper.beginRun();
      state.started = true;
      state.status = "running";
    } else if (state.status === "running") {
      state.status = payload.status === "aborted" ? "canceled" : payload.status;
    }
    const output = [this.upsert(payload.id, state, state.status)];
    if (state.status === "canceled") output.push(...this.childTimeline(payload.id, state.mapper.cancelRunning()));
    return output;
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) state.resolvedModel = payload.progress.resolvedModel.trim();
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    const status = mapProgressStatus(payload.progress.status);
    // Progress is not a new-run boundary; stale snapshots cannot revive or replace a terminal state.
    if (state.status === "running") state.status = status;
    const output = [this.upsert(id, state, state.status)];
    if (state.status === "canceled") output.push(...this.childTimeline(id, state.mapper.cancelRunning()));
    return output;
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    const model = modelFromSessionEvent(payload.event);
    const firstEvent = !state.announced;
    const changedModel = model !== null && model !== state.resolvedModel;
    if (changedModel) state.resolvedModel = model;
    const events: AgentStreamEvent[] = [];
    if (firstEvent || changedModel) events.push(this.upsert(payload.id, state, firstEvent ? state.status : undefined));
    events.push(...this.childTimeline(payload.id, state.mapper.map(payload.event, state.status !== "running")));
    return events;
  }

  hydrateSnapshot(parent: object, snapshot: OmpSubagentSnapshot): AgentStreamEvent[] {
    const state = this.stateFor(parent, snapshot.id, snapshot.agent);
    state.title = snapshot.agent || state.title;
    state.description = snapshot.description ?? snapshot.assignment ?? state.description;
    state.toolCallId = snapshot.parentToolCallId ?? state.toolCallId;
    const model = snapshot.progress?.resolvedModel?.trim();
    if (model) state.resolvedModel = model;
    state.status = mapProgressStatus(snapshot.status);
    return [this.upsert(snapshot.id, state, state.status)];
  }

  seedHistory(parent: object, events: AgentStreamEvent[], nativeHistory: readonly OmpSubagentNativeHistory[] = []): void {
    for (const event of events) {
      if (event.type !== "provider_subagent" || event.provider !== "omp") continue;
      const state = this.stateFor(parent, event.event.id, "OMP subagent");
      if (event.event.type === "timeline") state.mapper.seed(event.event.item);
      if (event.event.type === "upsert") {
        state.title = event.event.title ?? state.title;
        state.description = event.event.description ?? state.description;
        state.resolvedModel = event.event.model ?? state.resolvedModel;
        state.toolCallId = event.event.toolCallId ?? state.toolCallId;
        state.status = event.event.status ?? state.status;
        state.announced = true;
      }
    }
    for (const history of nativeHistory) {
      this.stateFor(parent, history.id, "OMP subagent").mapper.seedMessages(history.messages);
    }
  }

  markCanceled(parent: object, id: string): AgentStreamEvent[] {
    const state = this.statesByParent.get(parent)?.get(id);
    if (!state || state.status !== "running") return [];
    state.status = "canceled";
    return [this.upsert(id, state, state.status), ...this.childTimeline(id, state.mapper.cancelRunning())];
  }

  clear(parent: object): void {
    this.statesByParent.delete(parent);
  }

  private stateFor(parent: object, id: string, title: string): OmpSubagentState {
    const states = this.statesByParent.get(parent) ?? new Map<string, OmpSubagentState>();
    const existing = states.get(id);
    if (existing) return existing;
    const state: OmpSubagentState = {
      title, description: null, resolvedModel: null, toolCallId: null,
      status: "running", announced: false, started: false, mapper: new OmpSubagentLiveMapper(),
    };
    states.set(id, state);
    this.statesByParent.set(parent, states);
    return state;
  }

  private upsert(id: string, state: OmpSubagentState, status?: ChildStatus): AgentStreamEvent {
    state.announced = true;
    return {
      type: "provider_subagent", provider: "omp",
      event: {
        type: "upsert", id, title: state.title, description: state.description,
        model: state.resolvedModel, toolCallId: state.toolCallId,
        ...(status ? { status } : {}),
      },
    };
  }

  private childTimeline(id: string, mapped: AgentStreamEvent[]): AgentStreamEvent[] {
    const output: AgentStreamEvent[] = [];
    for (const event of mapped) {
      if (event.type !== "timeline") continue;
      output.push({ type: "provider_subagent", provider: "omp", event: { type: "timeline", id, item: event.item, ...(event.timestamp ? { timestamp: event.timestamp } : {}) } });
    }
    return output;
  }
}

function modelFromSessionEvent(event: OmpSubagentEventPayload["event"]): string | null {
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end" || event.type === "turn_end") {
    const parsed = OmpAgentMessageSchema.safeParse(event.message);
    return parsed.success ? readOmpAssistantModel(parsed.data) : null;
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const parsed = OmpAgentMessageSchema.safeParse(event.messages[index]);
      const model = parsed.success ? readOmpAssistantModel(parsed.data) : null;
      if (model !== null) return model;
    }
  }
  return null;
}

function mapProgressStatus(status: OmpSubagentProgressPayload["progress"]["status"]): ChildStatus {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}
