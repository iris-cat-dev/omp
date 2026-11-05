import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { AgentManager, type ManagedAgent } from "../agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import { readPersistedAgentHistory } from "../persisted-agent-history.js";
import { OmpAgentClient } from "../providers/omp/agent.js";
import { OmpSdkRuntime } from "../providers/omp/sdk-runtime.js";
import { ompHistoryRuntimeSettings } from "../providers/omp/test-utils/history-sdk.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const directories: string[] = [];
const activitySchema = z.object({
  agentId: z.string(),
  updateCount: z.number(),
  currentModeId: z.string().nullable(),
  content: z.string(),
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createHistory(archived: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "omp-cold-activity-"));
  directories.push(dir);
  const sessionFile = join(dir, "session.jsonl");
  const timestamp = "2026-10-01T12:00:00.000Z";
  const source =
    [
      { type: "session", id: "native-session", timestamp, cwd: dir },
      {
        type: "message",
        id: "prompt",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Inspect the synthetic file" },
      },
      {
        type: "message",
        id: "injected",
        parentId: "prompt",
        timestamp,
        message: {
          role: "user",
          content: "<paseo-system>\nPrivate injected notification\n</paseo-system>",
        },
      },
      {
        type: "message",
        id: "tool",
        parentId: "injected",
        timestamp,
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "synthetic.txt" } },
          ],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "result",
        parentId: "tool",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "Synthetic file contents" }],
          isError: false,
        },
      },
      {
        type: "message",
        id: "answer",
        parentId: "result",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Synthetic inspection complete" }],
          stopReason: "stop",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(sessionFile, source);
  const logger = createTestLogger();
  const storage = new AgentStorage(join(dir, "agents"), logger);
  const record: StoredAgentRecord = {
    id: "cold-activity",
    provider: "omp",
    cwd: dir,
    createdAt: timestamp,
    updatedAt: timestamp,
    labels: {},
    lastStatus: "closed",
    lastModeId: "plan",
    archivedAt: archived ? timestamp : null,
    promptSources: { prompt: "sending-agent" },
    persistence: { provider: "omp", sessionId: "native-session", nativeHandle: sessionFile },
  };
  await storage.upsert(record);
  // A regression must fail rather than launch a host or consult real credentials.
  vi.spyOn(OmpSdkRuntime.prototype, "startSession").mockRejectedValue(
    new Error("History inspection attempted to start a runtime"),
  );
  const client = new OmpAgentClient({
    logger,
    runtimeSettings: { ...ompHistoryRuntimeSettings, ompBackend: "sdk" },
  });
  const manager = new AgentManager({ logger, clients: { omp: client } });
  const catalog = createPaseoToolCatalog({
    agentManager: manager,
    agentStorage: storage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    logger,
  });
  return { catalog, manager, storage, client, record, sessionFile, source };
}

describe("cold get_agent_activity", () => {
  test.each([false, true])(
    "reads complete history and projected limits without activating archived=%s",
    async (archived) => {
      const h = await createHistory(archived);
      const full = activitySchema.parse(
        (await h.catalog.executeTool("get_agent_activity", { agentId: h.record.id }))
          .structuredContent,
      );
      expect(full.currentModeId).toBe("plan");
      expect(full.content).toContain("Showing all 3 activities");
      expect(full.content).toContain("[User] Inspect the synthetic file");
      expect(full.content).toContain("[Read] synthetic.txt");
      expect(full.content).toContain("Synthetic inspection complete");
      expect(full.content).not.toContain("Private injected notification");
      const limited = activitySchema.parse(
        (await h.catalog.executeTool("get_agent_activity", { agentId: h.record.id, limit: 1 }))
          .structuredContent,
      );
      expect(limited.content).toContain("Showing 1 of 3 activities (limited to 1)");
      expect(limited.content).toContain("Synthetic inspection complete");
      expect(limited.content).not.toContain("Inspect the synthetic file");
      expect(limited.content).not.toContain("[Read]");
      expect(limited.updateCount).toBe(full.updateCount);
      const history = await readPersistedAgentHistory(
        h.record.id,
        { agentManager: h.manager, agentStorage: h.storage },
        { direction: "tail", limit: 0 },
      );
      expect(
        history?.timeline.rows.find((row) => row.item.type === "user_message")?.item,
      ).toMatchObject({ type: "user_message", sourceAgentId: "sending-agent" });
      expect(h.manager.listAgents()).toEqual([]);
      expect(await h.storage.get(h.record.id)).toEqual(h.record);
      expect(await readFile(h.sessionFile, "utf8")).toBe(h.source);
    },
  );

  test.each(["before inspection", "during disk read"])(
    "keeps complete cold history when activation publishes an unprimed runtime %s",
    async (when) => {
      const h = await createHistory(false);
      const initializing = createStub<ManagedAgent>({
        id: h.record.id,
        provider: "omp",
        historyPrimed: false,
        currentModeId: null,
      });
      if (when === "before inspection")
        vi.spyOn(h.manager, "getAgent").mockReturnValue(initializing);
      else {
        const read = h.client.readHistoryPage.bind(h.client);
        vi.spyOn(h.client, "readHistoryPage").mockImplementationOnce(async (input) => {
          const page = await read(input);
          vi.spyOn(h.manager, "getAgent").mockReturnValue(initializing);
          return page;
        });
      }
      const response = activitySchema.parse(
        (await h.catalog.executeTool("get_agent_activity", { agentId: h.record.id }))
          .structuredContent,
      );
      expect(response.currentModeId).toBe("plan");
      expect(response.content).toContain("[User] Inspect the synthetic file");
      expect(response.content).toContain("[Read] synthetic.txt");
      expect(response.content).toContain("Synthetic inspection complete");
      expect(await readFile(h.sessionFile, "utf8")).toBe(h.source);
    },
  );

  test("reports unavailable and unknown history without activating a runtime", async () => {
    const h = await createHistory(false);
    await rm(h.sessionFile);
    await expect(
      h.catalog.executeTool("get_agent_activity", { agentId: h.record.id }),
    ).rejects.toThrow("History is unavailable without activating this session");
    await expect(
      h.catalog.executeTool("get_agent_activity", { agentId: "unknown" }),
    ).rejects.toThrow("Agent not found: unknown");
    expect(h.manager.listAgents()).toEqual([]);
    expect(await h.storage.get(h.record.id)).toEqual(h.record);
  });
});
