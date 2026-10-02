import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpHistoryMapper } from "./message-history.js";
import type { OmpAgentMessage, OmpAgentSessionEvent } from "./rpc-types.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { readOmpAssistantModel } from "./subagent-model.js";
import type {
  OmpSubagentEventPayload,
  OmpSubagentLifecyclePayload,
  OmpSubagentProgressPayload,
} from "./rpc-types.js";

interface OmpSubagentState {
  title: string;
  description: string | null;
  resolvedModel: string | null;
  toolCallId: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  mapper: OmpHistoryMapper;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    if (state.status === "running" || payload.status !== "started") {
      state.status = mapLifecycleStatus(payload.status);
    }
    return [this.upsert(payload.id, state.status, state)];
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) {
      state.resolvedModel = payload.progress.resolvedModel.trim();
    }
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    const status = mapProgressStatus(payload.progress.status);
    if (status !== "running" || state.status === "running") state.status = status;
    return [this.upsert(id, state.status, state)];
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    const model = modelFromSessionEvent(payload.event);
    const events: AgentStreamEvent[] = [];
    if (model !== null && model !== state.resolvedModel) {
      state.resolvedModel = model;
      events.push(this.upsert(payload.id, state.status, state));
    }
    const messages = messagesFromSessionEvent(payload.event);
    for (const mapped of state.mapper.mapMessages(messages)) {
      if (mapped.type !== "timeline") continue;
      events.push({
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "timeline",
          id: payload.id,
          item: mapped.item,
          ...(mapped.timestamp ? { timestamp: mapped.timestamp } : {}),
        },
      });
    }
    return events;
  }

  markCanceled(parent: object, id: string): AgentStreamEvent | null {
    const state = this.statesByParent.get(parent)?.get(id);
    if (!state || state.status !== "running") return null;
    state.status = "canceled";
    return this.upsert(id, state.status, state);
  }

  clear(parent: object): void {
    this.statesByParent.delete(parent);
  }

  private stateFor(parent: object, id: string, title: string): OmpSubagentState {
    const states = this.statesByParent.get(parent) ?? new Map<string, OmpSubagentState>();
    const existing = states.get(id);
    if (existing) return existing;
    const state: OmpSubagentState = {
      title,
      description: null,
      resolvedModel: null,
      toolCallId: null,
      status: "running",
      mapper: new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS),
    };
    states.set(id, state);
    this.statesByParent.set(parent, states);
    return state;
  }

  private upsert(
    id: string,
    status: "running" | "completed" | "failed" | "canceled",
    state: OmpSubagentState,
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: "omp",
      event: {
        type: "upsert",
        id,
        title: state.title,
        description: state.description,
        model: state.resolvedModel,
        status,
        toolCallId: state.toolCallId,
      },
    };
  }
}

function modelFromSessionEvent(event: OmpAgentSessionEvent): string | null {
  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    return readOmpAssistantModel(event.message);
  }
  if (event.type === "agent_end" && event.messages) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const model = readOmpAssistantModel(event.messages[index]!);
      if (model !== null) return model;
    }
  }
  return null;
}

function messagesFromSessionEvent(event: OmpAgentSessionEvent): OmpAgentMessage[] {
  if (event.type === "message_end") return [event.message];
  return [];
}

function mapLifecycleStatus(
  status: OmpSubagentLifecyclePayload["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "started") return "running";
  return status === "aborted" ? "canceled" : status;
}

function mapProgressStatus(
  status: OmpSubagentProgressPayload["progress"]["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}
