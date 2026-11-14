import { expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentMcpServer } from "./mcp-server.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  setupFinishNotification,
  sendPromptToAgent,
  startAgentRun,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import { respondToAgentPermission } from "./permission-response.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  AgentPromptInput,
  AgentPermissionResult,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  requestChildPermission(requestId?: string): void;
  resolveChildPermission(requestId?: string): void;
  resolveChildPermissionFromState(requestId?: string): void;
  resolveChildPermissionWhileIdle(requestId?: string): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  closeChildAndReadParentPrompt(): Promise<string>;
  parentPrompts(): string[];
  steerAttemptCount(): number;
  wasParentPrompted(): boolean;
  steerOptions(): unknown;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const subscriber = (event: AgentManagerEvent) => {
    for (const callback of subscribers) callback(event);
  };
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;
  let steerAttemptCount = 0;
  let steerOptions: unknown;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());
  const parentAgentId =
    options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
  Reflect.set(
    childAgent,
    "labels",
    parentAgentId ? { [PARENT_AGENT_ID_LABEL]: parentAgentId } : {},
  );

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager = new AgentManager({ logger: createTestLogger() });
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(
    agentManager,
    "steerOrReplaceActiveTurn",
    async (_agentId: string, _prompt: unknown, steerDispatchOptions: unknown) => {
      steerAttemptCount += 1;
      steerOptions = steerDispatchOptions;
      return { status: "inactive" };
    },
  );
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    parentPrompts.push(prompt);
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    requestChildPermission(requestId = "permission-1") {
      childAgent.lifecycle = "running";
      childAgent.pendingPermissions.set(requestId, {
        id: requestId,
        provider: "claude",
        kind: "tool",
        name: "Run command",
        description: "Write the QA sentinel",
        input: {
          file_path: "/tmp/permission-qa.txt",
          content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
        },
      });
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: childAgent.pendingPermissions.get(requestId)!,
        },
      });
    },
    resolveChildPermission(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    resolveChildPermissionFromState(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({ type: "agent_state", agent: childAgent });
    },
    resolveChildPermissionWhileIdle(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      childAgent.lifecycle = "idle";
      subscriber?.({ type: "agent_state", agent: childAgent });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    async closeChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });

      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "closed";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      return parentPrompt;
    },
    parentPrompts() {
      return parentPrompts;
    },
    steerAttemptCount() {
      return steerAttemptCount;
    },
    steerOptions() {
      return steerOptions;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
  expect(scenario.steerAttemptCount()).toBe(1);
  expect(scenario.steerOptions()).toEqual({ replaceOnUnavailable: false });
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: included + omitted,
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain(included);
  expect(parentPrompt).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(parentPrompt).not.toContain("TAIL-MARKER");
});

test("closing a watched child notifies the caller", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  const parentPrompt = await scenario.closeChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) was closed."),
  );
});

test("finish notifications survive permission responses", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
  expect(scenario.parentPrompts()[0]).toContain("needs permission.");
  const permissionPayload = scenario
    .parentPrompts()[0]
    .match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child-agent",
    requestId: "permission-1",
    request: {
      id: "permission-1",
      provider: "claude",
      kind: "tool",
      name: "Run command",
      description: "Write the QA sentinel",
      input: {
        file_path: "/tmp/permission-qa.txt",
        content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
      },
    },
  });

  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(2);
  });
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("an idle permission resolution waits for the resumed run to finish", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.resolveChildPermissionWhileIdle();
  scenario.requestChildPermission("permission-2");
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts().every((prompt) => prompt.includes("needs permission."))).toBe(
    true,
  );

  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications report every concurrently pending permission", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission("permission-1");
  scenario.requestChildPermission("permission-2");

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(
    scenario.parentPrompts().map((prompt) => {
      const payload = prompt.match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
      return JSON.parse(payload!).requestId;
    }),
  ).toEqual(["permission-1", "permission-2"]);

  scenario.resolveChildPermission("permission-1");
  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications survive repeated permission cycles", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.resolveChildPermissionFromState();

  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(
    scenario.parentPrompts().map((prompt) => prompt.match(/(needs permission|finished)\./)?.[1]),
  ).toEqual(["needs permission", "needs permission", "finished"]);
});

test("repeated reports merge finish subscriptions through permission cycles and release at terminal", async () => {
  const scenario = createFinishNotificationScenario();
  scenario.startWatchingChild();
  scenario.startWatchingChild();
  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.startWatchingChild();
  scenario.resolveChildPermission();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  scenario.finishChild();
  expect(scenario.parentPrompts().filter((prompt) => prompt.includes("finished."))).toHaveLength(1);

  // A later task may install a fresh subscription after the terminal boundary.
  scenario.startWatchingChild();
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(4));
  expect(scenario.parentPrompts().filter((prompt) => prompt.includes("finished."))).toHaveLength(2);
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Failed to notify caller agent",
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      reason: "finished",
      err: expect.objectContaining({ message: "parent provider rejected replacement" }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager = new AgentManager({ logger: createTestLogger() });
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});

// Deliberately independent literals rather than the production constants these tests
// guard: deriving the boundaries from AGENT_RUN_START_TIMEOUT_MS would keep the tests
// green if that constant were shortened back under a provider's startup budget.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(_prompt: AgentPromptInput): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  permissionFollowUp: AgentPromptInput | undefined;

  async respondToPermission(): Promise<AgentPermissionResult | void> {
    if (this.permissionFollowUp) return { followUpPrompt: this.permissionFollowUp };
  }

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

class AdmissionAgentSession extends SlowStartAgentSession {
  readonly startGate = Promise.withResolvers<void>();
  readonly startEntered = Promise.withResolvers<void>();
  readonly received: AgentPromptInput[] = [];
  interruptCount = 0;
  paused = false;
  turnId: string | null = null;
  private turnNumber = 0;
  startFailure: Error | undefined;
  steerUnavailable: "unsupported" | "no_active_turn" | "turn_mismatch" | undefined;

  constructor() {
    super(null);
  }

  override async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startEntered.resolve();
    await this.startGate.promise;
    if (this.startFailure) {
      const error = this.startFailure;
      this.startFailure = undefined;
      throw error;
    }
    this.received.push(prompt);
    this.turnId = `${this.id}-${++this.turnNumber}`;
    return { turnId: this.turnId };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.steerUnavailable) return { status: "unavailable", reason: this.steerUnavailable };
    if (options.expectedTurnId !== this.turnId)
      return { status: "unavailable", reason: "turn_mismatch" };
    this.received.push(prompt);
    return { status: "accepted" };
  }

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    if (prompt !== "/goal pause") return null;
    return {
      run: async () => {
        this.paused = true;
      },
    };
  }

  finish(): void {
    if (!this.turnId) return;
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId: this.turnId });
    this.turnId = null;
  }

  override async interrupt(): Promise<void> {
    this.interruptCount += 1;
    this.finish();
  }
}

async function createAdmissionScenario() {
  const workdir = mkdtempSync(join(tmpdir(), "agent-prompt-admission-"));
  const sessions: AdmissionAgentSession[] = [];
  const client = new SlowStartAgentClient(null);
  client.createSession = async () => {
    const session = new AdmissionAgentSession();
    sessions.push(session);
    return session;
  };
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({ clients: { codex: client }, logger });
  const first = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const second = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const send = (agentId: string, body: string) =>
    startAgentRun(manager, agentId, body, logger, {
      replaceRunning: true,
      activeTurnBehavior: "steer",
      replaceOnSteerUnavailable: false,
      runOptions: { clientMessageId: randomUUID() },
    });
  return {
    manager,
    storage,
    logger,
    first,
    second,
    sessions,
    send,
    async cleanup() {
      for (const session of sessions) session.startGate.resolve();
      for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("explicit provider runs bypass host out-of-band commands and own a real foreground turn", async () => {
  const scenario = await createAdmissionScenario();
  try {
    scenario.sessions[0]!.startGate.resolve();
    const result = await startAgentRun(scenario.manager, scenario.first.id, "/goal pause", scenario.logger, {
      outOfBandCommands: false,
      requireIdle: true,
    });
    expect(result.disposition).toBe("turn_started");
    expect(scenario.sessions[0]!.paused).toBe(false);
    expect(scenario.manager.hasInFlightRun(scenario.first.id)).toBe(true);
  } finally {
    await scenario.cleanup();
  }
});

test("requireIdle rejects queued delivery after another prompt wins admission without steering or replacing", async () => {
  const scenario = await createAdmissionScenario();
  try {
    const first = scenario.send(scenario.first.id, "held provider start");
    await scenario.sessions[0]!.startEntered.promise;
    const next = startAgentRun(scenario.manager, scenario.first.id, "idle-only delivery", scenario.logger, {
      requireIdle: true,
      replaceRunning: true,
      activeTurnBehavior: "steer",
    });
    const rejected = expect(next).rejects.toThrow(`Agent ${scenario.first.id} already has an active run`);
    scenario.sessions[0]!.startGate.resolve();
    await first;
    await rejected;
    expect(scenario.sessions[0]!.received).toEqual(["held provider start"]);
    expect(scenario.sessions[0]!.interruptCount).toBe(0);
    expect(scenario.manager.hasInFlightRun(scenario.first.id)).toBe(true);
    const finished = scenario.manager.waitForAgentEvent(scenario.first.id, { waitForActive: true });
    scenario.sessions[0]!.finish();
    await finished;
    await startAgentRun(scenario.manager, scenario.first.id, "idle-only continuation", scenario.logger, { requireIdle: true });
    expect(scenario.sessions[0]!.received).toHaveLength(2);
  } finally {
    await scenario.cleanup();
  }
});

test("slow provider admission queues same-target system reports for steering without interrupting", async () => {
  const scenario = await createAdmissionScenario();
  try {
    const { first, sessions, send, manager } = scenario;
    const initial = send(first.id, "initial task");
    await sessions[0]!.startEntered.promise;
    const reports = ["child A finished", "child B finished", "child C finished"].map(
      formatSystemNotificationPrompt,
    );
    const pending = reports.map((report) => send(first.id, report));
    expect(sessions[0]!.received).toEqual([]);
    sessions[0]!.startGate.resolve();
    await expect(initial).resolves.toEqual({ disposition: "turn_started" });
    await expect(Promise.all(pending)).resolves.toEqual(
      reports.map(() => ({ disposition: "steered" })),
    );
    expect(sessions[0]!.received).toEqual(["initial task", ...reports]);
    expect(sessions[0]!.interruptCount).toBe(0);
    expect(manager.getAgent(first.id)?.activeForegroundTurnId).toBe(sessions[0]!.turnId);

    const finished = manager.waitForAgentEvent(first.id, { waitForActive: true });
    sessions[0]!.finish();
    await finished;
    expect(manager.getAgent(first.id)?.lifecycle).toBe("idle");
  } finally {
    await scenario.cleanup();
  }
});

test.each(["target", "ancestor"] as const)(
  "Stop on %s withdraws queued admission even after its first start response arrives late",
  async (stopScope) => {
    const scenario = await createAdmissionScenario();
    const accepted = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const { manager, first, second, sessions, send } = scenario;
    const streamAgent = manager.streamAgent.bind(manager);
    manager.streamAgent = (...args) => {
      const iterator = streamAgent(...args);
      return (async function* () {
        const started = await iterator.next();
        accepted.resolve();
        await releaseResponse.promise;
        if (!started.done) yield started.value;
        yield* iterator;
      })();
    };
    try {
      if (stopScope === "ancestor") {
        await manager.setLabels(first.id, { [PARENT_AGENT_ID_LABEL]: second.id });
      }
      sessions[0]!.startGate.resolve();
      const initial = send(first.id, "initial task");
      await accepted.promise;
      const queued = send(first.id, "queued before Stop");
      const withdrawn = expect(queued).rejects.toMatchObject({
        name: "AgentRunAdmissionCancelledError",
      });
      await expect(
        manager.cancelAgentRun(stopScope === "ancestor" ? second.id : first.id),
      ).resolves.toEqual({ status: "settled" });
      releaseResponse.resolve();
      await initial;
      await withdrawn;
      expect(sessions[0]!.received).toEqual(["initial task"]);
      expect(manager.hasInFlightRun(first.id)).toBe(false);
      expect(manager.getAgent(first.id)?.lifecycle).toBe("idle");

      await expect(send(first.id, "deliberate continuation")).resolves.toEqual({
        disposition: "turn_started",
      });
      const finished = manager.waitForAgentEvent(first.id, { waitForActive: true });
      sessions[0]!.finish();
      await finished;
    } finally {
      releaseResponse.resolve();
      await scenario.cleanup();
    }
  },
);

test.each([
  { active: false, followUp: true },
  { active: true, followUp: true },
  { active: true, followUp: false },
])(
  "permission approval preserves admission and execution ($active, $followUp)",
  async ({ active, followUp }) => {
    const scenario = await createAdmissionScenario();
    const { manager, first, sessions, send, logger } = scenario;
    const session = sessions[0]!;
    try {
      session.startGate.resolve();
      if (active) await send(first.id, "original task");
      const originalTurn = manager.getAgent(first.id)?.activeTurnId;
      session.permissionFollowUp = followUp ? "approved continuation" : undefined;
      session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        ...(session.turnId ? { turnId: session.turnId } : {}),
        request: { id: "approval", provider: "codex", kind: "tool", name: "Approve execution" },
      });
      await vi.waitFor(() => expect(manager.getAgent(first.id)?.pendingPermissions.size).toBe(1));
      await respondToAgentPermission({
        agentManager: manager,
        agentId: first.id,
        requestId: "approval",
        response: { behavior: "allow" },
        logger,
      });
      expect(manager.getAgent(first.id)?.pendingPermissions.size).toBe(0);
      expect(manager.getAgent(first.id)?.lifecycle).toBe("running");
      expect(manager.hasInFlightRun(first.id)).toBe(true);
      if (followUp) {
        expect(manager.getAgent(first.id)?.activeTurnId).not.toBe(originalTurn);
      } else {
        expect(manager.getAgent(first.id)?.activeTurnId).toBe(originalTurn);
        expect(session.interruptCount).toBe(0);
      }
      const finished = manager.waitForAgentEvent(first.id, { waitForActive: true });
      session.finish();
      await finished;
      expect(manager.getAgent(first.id)?.lifecycle).toBe("idle");
    } finally {
      await scenario.cleanup();
    }
  },
);

test("independent targets and out-of-band controls bypass a pending provider admission", async () => {
  const scenario = await createAdmissionScenario();
  try {
    const firstStart = scenario.send(scenario.first.id, "held start");
    await scenario.sessions[0]!.startEntered.promise;
    const secondStart = scenario.send(scenario.second.id, "independent task");
    await scenario.sessions[1]!.startEntered.promise;
    scenario.sessions[1]!.startGate.resolve();
    await expect(secondStart).resolves.toEqual({ disposition: "turn_started" });
    await expect(scenario.send(scenario.first.id, "/goal pause")).resolves.toEqual({
      disposition: "out_of_band",
    });
    expect(scenario.sessions[0]!.paused).toBe(true);
    expect(scenario.sessions[0]!.received).toEqual([]);
    scenario.sessions[0]!.startGate.resolve();
    await firstStart;
    expect(scenario.sessions.every((session) => session.interruptCount === 0)).toBe(true);
  } finally {
    await scenario.cleanup();
  }
});

test("a rejected provider start reaches the caller and releases queued prompt admission", async () => {
  const scenario = await createAdmissionScenario();
  try {
    scenario.sessions[0]!.startFailure = new Error("provider start refused");
    const failed = scenario.send(scenario.first.id, "failed task");
    const rejection = expect(failed).rejects.toThrow("provider start refused");
    await scenario.sessions[0]!.startEntered.promise;
    const next = scenario.send(scenario.first.id, "next task");
    scenario.sessions[0]!.startGate.resolve();
    await rejection;
    await expect(next).resolves.toEqual({ disposition: "turn_started" });
    expect(scenario.sessions[0]!.received).toEqual(["next task"]);
    expect(scenario.sessions[0]!.interruptCount).toBe(0);
  } finally {
    await scenario.cleanup();
  }
});

test.each([
  ["unsupported", "does not support steering"],
  ["no_active_turn", "no longer has an active turn"],
  ["turn_mismatch", "did not match"],
] as const)(
  "prompt admission preserves %s steering errors without replacement",
  async (reason, message) => {
    const scenario = await createAdmissionScenario();
    try {
      scenario.sessions[0]!.startGate.resolve();
      await scenario.send(scenario.first.id, "initial task");
      scenario.sessions[0]!.steerUnavailable = reason;
      await expect(scenario.send(scenario.first.id, "must not interrupt")).rejects.toThrow(message);
      expect(scenario.sessions[0]!.received).toEqual(["initial task"]);
      expect(scenario.sessions[0]!.interruptCount).toBe(0);
    } finally {
      await scenario.cleanup();
    }
  },
);

test.each([
  { relationship: "parent", notifyOnFinish: undefined, expectsNotification: false },
  { relationship: "ancestor", notifyOnFinish: undefined, expectsNotification: false },
  { relationship: "parent", notifyOnFinish: true, expectsNotification: true },
  { relationship: "ancestor", notifyOnFinish: true, expectsNotification: true },
  { relationship: "child", notifyOnFinish: undefined, expectsNotification: true },
  { relationship: "collaborator", notifyOnFinish: undefined, expectsNotification: true },
] as const)(
  "completed reporters to $relationship receive finish notifications only when requested ($notifyOnFinish)",
  async ({ relationship, notifyOnFinish, expectsNotification }) => {
    const scenario = await createAdmissionScenario();
    const { manager, storage, first: target, second: caller, sessions, send, logger } = scenario;
    try {
      if (relationship === "parent") {
        await manager.setLabels(caller.id, { [PARENT_AGENT_ID_LABEL]: target.id });
      } else if (relationship === "ancestor") {
        const intermediate = await manager.createAgent(
          { provider: "codex", cwd: target.cwd },
          undefined,
          {
            workspaceId: undefined,
          },
        );
        await manager.setLabels(caller.id, { [PARENT_AGENT_ID_LABEL]: intermediate.id });
        await manager.setLabels(intermediate.id, { [PARENT_AGENT_ID_LABEL]: target.id });
      } else if (relationship === "child") {
        await manager.setLabels(target.id, { [PARENT_AGENT_ID_LABEL]: caller.id });
      }
      for (const session of sessions) session.startGate.resolve();
      await send(target.id, "target task");
      await send(caller.id, "reporter task");
      const callerFinished = manager.waitForAgentEvent(caller.id, { waitForActive: true });
      sessions[1]!.finish();
      await callerFinished;

      const server = await createAgentMcpServer({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        callerAgentId: caller.id,
        logger,
      });
      const tool = Reflect.get(server, "_registeredTools").send_agent_prompt;
      for (const prompt of ["report 1", "report 2", "report 3"]) {
        const parsed = await tool.inputSchema.parseAsync({
          agentId: target.id,
          prompt,
          ...(notifyOnFinish === undefined ? {} : { notifyOnFinish }),
        });
        const response = await (tool.handler ?? tool.callback)(parsed);
        expect(Boolean(response.structuredContent.guidance)).toBe(expectsNotification);
      }
      expect(sessions[0]!.received).toEqual(["target task", "report 1", "report 2", "report 3"]);

      const callerRestarted = Promise.withResolvers<void>();
      const unsubscribe = manager.subscribe(
        (event) => {
          if (event.type === "agent_stream" && event.event.type === "turn_started")
            callerRestarted.resolve();
        },
        { agentId: caller.id, replayState: false },
      );
      const targetFinished = manager.waitForAgentEvent(target.id, { waitForActive: true });
      sessions[0]!.finish();
      await targetFinished;
      if (expectsNotification) {
        await callerRestarted.promise;
        await send(caller.id, "notification delivery barrier");
        expect(sessions[1]!.received).toHaveLength(3);
        expect(sessions[1]!.received[1]).toContain(`Agent ${target.id}`);
        expect(sessions[1]!.received[1]).toContain("finished.");
        expect(sessions[1]!.received[2]).toBe("notification delivery barrier");
      } else {
        expect(sessions[1]!.received).toEqual(["reporter task"]);
        expect(manager.getAgent(caller.id)?.lifecycle).toBe("idle");
      }
      unsubscribe();
      expect(sessions.every((session) => session.interruptCount === 0)).toBe(true);
      await server.close();
    } finally {
      await scenario.cleanup();
    }
  },
);

test.each([
  { sourceKind: undefined, sourceAgentId: undefined, expected: "service" },
  { sourceKind: "user", sourceAgentId: undefined, expected: "user" },
  { sourceKind: "service", sourceAgentId: undefined, expected: "service" },
  { sourceKind: "user", sourceAgentId: "caller-agent", expected: "agent" },
] as const)("host assigns canonical prompt origin $expected", async ({ sourceKind, sourceAgentId, expected }) => {
  const scenario = await createAdmissionScenario();
  const messages: AgentStreamEvent[] = [];
  const unsubscribe = scenario.manager.subscribe((event) => {
    if (event.type === "agent_stream" && event.agentId === scenario.first.id) messages.push(event.event);
  });
  try {
    const submitted = sendPromptToAgent({
      agentManager: scenario.manager,
      agentStorage: scenario.storage,
      agentId: scenario.first.id,
      prompt: "origin regression",
      sourceKind,
      sourceAgentId,
      logger: scenario.logger,
    });
    await scenario.sessions[0]!.startEntered.promise;
    scenario.sessions[0]!.startGate.resolve();
    await submitted;
    expect(messages).toContainEqual(expect.objectContaining({
      type: "timeline",
      item: expect.objectContaining({
        type: "user_message",
        text: "origin regression",
        clientMessageId: expect.any(String),
        sourceKind: expected,
        ...(sourceAgentId ? { sourceAgentId } : {}),
      }),
    }));
  } finally {
    unsubscribe();
    await scenario.cleanup();
  }
});
