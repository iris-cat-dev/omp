import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
} from "../agent-sdk-types.js";
import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./test-rewind-session.js";

class FakeRewindClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = REWIND_TEST_CAPABILITIES;

  constructor(readonly session: FakeRewindSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

class RewindHistoryGate {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private readonly entered = Promise.withResolvers<void>();

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
  }

  async wait(): Promise<void> {
    this.entered.resolve();
    await this.gate;
  }
  waitUntilBlocked(): Promise<void> {
    return this.entered.promise;
  }
}

async function createRewindHarness(options: { historyGate?: RewindHistoryGate } = {}) {
  const session = new FakeRewindSession(options.historyGate?.wait.bind(options.historyGate));
  const manager = new AgentManager({
    clients: { claude: new FakeRewindClient(session) },
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000000901",
  });
  const agent = await manager.createAgent(
    {
      provider: "claude",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
  return { manager, session, agentId: agent.id };
}

describe("AgentManager rewind", () => {
  test("rewinds the conversation and rehydrates the timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "conversation");

    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(1);
    expect(manager.fetchTimeline(agentId, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "before", messageId: "message-1" },
    ]);
  });

  test("rewinds files without rehydrating the conversation timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(0);
  });

  test("aborts an in-flight turn before rewinding", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.aborted).toBe(true);
    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
  });

  test("does not rewind when the in-flight turn rejects cancellation", async () => {
    class RejectingInterruptSession extends FakeRewindSession {
      override async interrupt(): Promise<void> {
        throw new Error("provider still owns the active turn");
      }
    }

    const session = new RejectingInterruptSession();
    const manager = new AgentManager({
      clients: { claude: new FakeRewindClient(session) },
      logger: createTestLogger(),
      idFactory: () => "00000000-0000-4000-8000-000000000902",
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
      workspaceId: undefined,
    });
    const run = manager.streamAgent(agent.id, "keep working");
    await run.next();

    await expect(manager.rewind(agent.id, "message-1", "files")).rejects.toThrow(
      `Cannot rewind agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
    expect(session.recordedRewinds).toEqual([]);
    expect(manager.getAgent(agent.id)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "turn-1",
    });
  });

  test("blocks new prompts until the rehydrate epoch broadcasts", async () => {
    const historyGate = new RewindHistoryGate();
    historyGate.hold();
    const { manager, agentId } = await createRewindHarness({ historyGate });

    const rewind = manager.rewind(agentId, "message-1", "both");
    await historyGate.waitUntilBlocked();

    expect(() => manager.streamAgent(agentId, "too early")).toThrow(
      "Agent 00000000-0000-4000-8000-000000000901 already has an active run",
    );

    historyGate.release();
    await rewind;
  });

  test("drains a queued native confirmation before validating rewind and preserves pending safety", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "hello", { clientMessageId: "client-queued" });
    try {
      await run.next();
      await expect(manager.rewind(agentId, "client-queued", "files")).rejects.toMatchObject({
        code: "message_pending",
      });
      expect(session.aborted).toBe(false);
      expect(session.recordedRewinds).toEqual([]);

      session.emit({
        type: "timeline",
        provider: session.provider,
        turnId: "turn-1",
        item: {
          type: "user_message",
          text: "hello",
          clientMessageId: "client-queued",
          messageId: "native-queued",
        },
      });
      await manager.rewind(agentId, "client-queued", "files");
      expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "native-queued" }]);
      expect(session.aborted).toBe(true);
    } finally {
      await run.return(undefined);
      await manager.closeAgent(agentId);
      await manager.flush();
    }
  });

  test("resync recovers an unavailable prompt without rewinding or duplicating its canonical row", async () => {
    class RecoverableSession extends FakeRewindSession {
      lookupError: Error | null = new Error("native history temporarily unavailable");
      readonly nativeIds = new Map<string, string>();

      async resolveUserMessageId(input: {
        clientMessageId: string;
        text: string;
      }): Promise<string | null> {
        if (this.lookupError) throw this.lookupError;
        return this.nativeIds.get(input.clientMessageId) ?? null;
      }
    }
    const session = new RecoverableSession();
    const manager = new AgentManager({
      clients: { claude: new FakeRewindClient(session) },
      logger: createTestLogger(),
    });
    const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
      workspaceId: undefined,
    });
    const run = manager.streamAgent(agent.id, "hello", { clientMessageId: "client-recover" });
    const updates: Array<{ seq: number | undefined; status: string | undefined }> = [];
    manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.event.type === "timeline" &&
          event.event.item.type === "user_message"
        ) {
          updates.push({ seq: event.seq, status: event.event.item.rewindStatus });
        }
      },
      { agentId: agent.id, replayState: false },
    );
    try {
      await run.next();
      session.emit({ type: "turn_completed", provider: session.provider, turnId: "turn-1" });
      await manager.flush();
      const before = manager.fetchTimeline(agent.id, { limit: 0 }).rows[0];
      expect(before.item).toMatchObject({
        messageId: "client-recover",
        rewindStatus: "unavailable",
      });
      await expect(manager.rewind(agent.id, "client-recover", "files")).rejects.toMatchObject({
        code: "message_unavailable",
      });
      await expect(
        manager.syncAgentRewindMessage(agent.id, "client-recover"),
      ).rejects.toMatchObject({
        code: "message_sync_failed",
        cause: session.lookupError,
      });

      session.lookupError = null;
      session.nativeIds.set("client-recover", "native-recovered");
      expect(await manager.syncAgentRewindMessage(agent.id, "client-recover")).toBe("ready");
      expect(session.recordedRewinds).toEqual([]);
      expect(session.aborted).toBe(false);
      const after = manager.fetchTimeline(agent.id, { limit: 0 }).rows;
      expect(after).toMatchObject([
        {
          seq: before.seq,
          timestamp: before.timestamp,
          providerMessageId: "native-recovered",
          item: {
            messageId: "client-recover",
            clientMessageId: "client-recover",
            text: "hello",
            rewindStatus: "ready",
          },
        },
      ]);
      expect(updates).toEqual([
        { seq: before.seq, status: "pending" },
        { seq: before.seq, status: "unavailable" },
        { seq: before.seq, status: "ready" },
      ]);
      await manager.rewind(agent.id, "client-recover", "files");
      expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "native-recovered" }]);
    } finally {
      await run.return(undefined);
      await manager.closeAgent(agent.id);
      await manager.flush();
    }
  });
});
