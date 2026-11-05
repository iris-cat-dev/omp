import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
} from "./agent-timeline-store-types.js";
import { restorePromptSource } from "./agent-prompt.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { TimelineProjectionMode } from "./timeline-projection.js";
import { inspectOmpSessionHistoryAvailability } from "./providers/omp/session-descriptor.js";

interface PersistedAgentHistoryOptions extends AgentTimelineFetchOptions {
  projection?: TimelineProjectionMode;
  onlyUserMessages?: boolean;
}

interface PersistedAgentHistory {
  record: StoredAgentRecord;
  timeline: AgentTimelineFetchResult;
}

export async function readPersistedAgentHistory(
  agentId: string,
  deps: {
    agentManager: Pick<AgentManager, "getAgent" | "getRegisteredClient">;
    agentStorage: Pick<AgentStorage, "get" | "getPromptSources">;
  },
  options: PersistedAgentHistoryOptions,
): Promise<PersistedAgentHistory | null> {
  const existing = deps.agentManager.getAgent(agentId);
  if (existing?.historyPrimed) return null;
  const record = await deps.agentStorage.get(agentId);
  const nativeHandle = record?.persistence?.nativeHandle;
  if (
    !record ||
    record.internal ||
    !["omp", "pi", "codex"].includes(record.provider) ||
    typeof nativeHandle !== "string" ||
    !nativeHandle.trim()
  ) {
    return null;
  }
  if ((await inspectOmpSessionHistoryAvailability(nativeHandle)).status !== "available")
    return null;

  const client = deps.agentManager.getRegisteredClient(record.provider);
  if (!client?.readHistoryPage) {
    throw new Error(
      `Provider '${record.provider}' has no selected cold-history reader; configure a built OMP Node SDK with an indexed journal module. History inspection will not activate a runtime.`,
    );
  }
  const timeline = await client.readHistoryPage({
    sessionFile: nativeHandle,
    provider: record.provider,
    epoch: `persisted-omp:${agentId}`,
    timestamp: record.updatedAt,
    projection: options.projection,
    onlyUserMessages: options.onlyUserMessages,
    options,
  });
  const promptSources = await deps.agentStorage.getPromptSources(agentId);
  timeline.rows = timeline.rows.map((row) => ({
    ...row,
    item: limitAgentTimelineItemContent(restorePromptSource(row.item, promptSources)),
  }));
  // Activation publishes a session before its provider history is hydrated.
  // Keep the complete cold page until that live history is actually ready.
  const activated = deps.agentManager.getAgent(agentId);
  if (activated?.historyPrimed) return null;
  return { record, timeline };
}
