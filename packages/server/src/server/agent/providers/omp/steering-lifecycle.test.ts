import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import pino from "pino";
import { expect, test } from "vitest";

import { AgentManager } from "../../agent-manager.js";
import { startAgentRun } from "../../agent-prompt.js";
import type { AgentClient, AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentSession } from "./agent.js";
import type { OmpAgentMessage, OmpSessionState } from "./rpc-types.js";
import { FakeOmpSession } from "./test-utils/fake-omp.js";

function terminal(stopReason: "stop" | "aborted" = "stop"): OmpAgentMessage {
  return { role: "assistant", content: [{ type: "text", text: "Finished" }], stopReason };
}

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "omp-steering-lifecycle-"));
  const logger = pino({ level: "silent" });
  const runtime = new FakeOmpSession({ session: join(cwd, "session.jsonl") });
  const events: AgentStreamEvent[] = [];
  let session: OmpAgentSession;
  const client: AgentClient = {
    provider: "omp",
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true },
    async isAvailable() {
      return true;
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async createSession(config) {
      session = new OmpAgentSession({
        runtimeSession: runtime,
        historyRuntimeSettings: { ompSdkPath: process.env.OMP_DESKTOP_TEST_SDK_ROOT },
        config,
        initialState: runtime.state,
        logger,
        oauthAccounts: [],
      });
      await session.initialize();
      session.subscribe((event) => events.push(event));
      return session;
    },
    async resumeSession() {
      throw new Error("This fixture only creates new sessions");
    },
  };
  const manager = new AgentManager({ clients: { omp: client }, logger, paseoToolsEnabled: false });
  const agent = await manager.createAgent(
    { provider: "omp", model: "fixture/model", cwd },
    undefined,
    { workspaceId: undefined },
  );
  async function settle() {
    await tick();
    await manager.drainSessionEvents(agent.id);
    await tick();
  }
  async function start() {
    await startAgentRun(manager, agent.id, "Start", logger);
    await manager.waitForAgentRunStart(agent.id);
    runtime.state.isStreaming = true;
    runtime.emit({ type: "agent_start" });
    runtime.beginTurn();
    await settle();
    return manager.getAgent(agent.id)!.activeTurnId;
  }
  async function steer() {
    return startAgentRun(manager, agent.id, "Coordinate without interrupting", logger, {
      activeTurnBehavior: "steer",
      replaceRunning: true,
      replaceOnSteerUnavailable: false,
    });
  }
  async function finish() {
    runtime.state.isStreaming = false;
    runtime.emit({ type: "agent_end", isTerminal: true, messages: [terminal()] });
    await settle();
  }
  async function close() {
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
  return { manager, agent, runtime, events, settle, start, steer, finish, close };
}

test("a delayed old idle reply cannot prevent steering or complete the new manager turn", async () => {
  const f = await createFixture();
  try {
    const oldTurnId = await f.start();
    const getState = f.runtime.getState.bind(f.runtime);
    const { promise: idleReply, resolve: releaseIdle } = Promise.withResolvers<OmpSessionState>();
    let captured = false;
    f.runtime.getState = () => {
      if (captured) return getState();
      captured = true;
      return idleReply;
    };
    f.runtime.abort = async () => {
      f.runtime.abortRequested = true;
      f.runtime.emit({ type: "agent_end", isTerminal: true, messages: [terminal("aborted")] });
    };
    await f.manager.cancelAgentRun(f.agent.id);
    expect(captured).toBe(true);
    await f.settle();
    const newTurnId = await f.start();
    expect(newTurnId).not.toBe(oldTurnId);

    releaseIdle({ ...f.runtime.state, isStreaming: false, isCompacting: false });
    await f.settle();
    expect(f.manager.getAgent(f.agent.id)).toMatchObject({
      lifecycle: "running",
      activeTurnId: newTurnId,
      activeForegroundTurnId: newTurnId,
    });
    await expect(f.steer()).resolves.toEqual({ disposition: "steered" });
    expect(f.runtime.steerRequests).toEqual([
      { message: "Coordinate without interrupting", imageCount: 0 },
    ]);
    expect(f.runtime.prompts).toHaveLength(2);
    expect(f.events.filter((event) => event.type === "turn_canceled")).toEqual([
      expect.objectContaining({ turnId: oldTurnId }),
    ]);

    await f.finish();
    expect(f.manager.getAgent(f.agent.id)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
    expect(f.events.filter((event) => event.type === "turn_completed")).toEqual([
      expect.objectContaining({ turnId: newTurnId }),
    ]);
  } finally {
    await f.close();
  }
});

test("an autonomous continuation shares its steerable identity with the manager until completion", async () => {
  const f = await createFixture();
  try {
    const foregroundTurnId = await f.start();
    await f.finish();
    expect(f.manager.getAgent(f.agent.id)?.lifecycle).toBe("idle");

    f.runtime.state.isStreaming = true;
    f.runtime.emit({ type: "agent_start" });
    f.runtime.beginTurn();
    await f.settle();
    const autonomousTurnId = f.manager.getAgent(f.agent.id)!.activeTurnId;
    expect(autonomousTurnId).not.toBe(foregroundTurnId);
    expect(f.manager.getAgent(f.agent.id)?.activeForegroundTurnId).toBeNull();
    expect(f.events.findLast((event) => event.type === "turn_started")).toMatchObject({
      turnId: autonomousTurnId,
    });

    // Internal OMP model/tool turns must retain the same Desktop turn identity.
    f.runtime.beginTurn();
    await f.settle();
    expect(f.manager.getAgent(f.agent.id)?.activeTurnId).toBe(autonomousTurnId);
    await expect(f.steer()).resolves.toEqual({ disposition: "steered" });
    expect(f.runtime.steerRequests).toEqual([
      { message: "Coordinate without interrupting", imageCount: 0 },
    ]);
    expect(f.runtime.abortRequested).toBe(false);
    expect(f.runtime.prompts).toHaveLength(1);

    await f.finish();
    expect(f.manager.getAgent(f.agent.id)).toMatchObject({ lifecycle: "idle", activeTurnId: null });
    expect(f.events.filter((event) => event.type === "turn_completed")).toEqual([
      expect.objectContaining({ turnId: foregroundTurnId }),
      expect.objectContaining({ turnId: autonomousTurnId }),
    ]);
  } finally {
    await f.close();
  }
});
