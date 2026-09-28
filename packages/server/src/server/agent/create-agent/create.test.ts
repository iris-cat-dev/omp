import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager, WorkspaceRootConflictError, type ManagedAgent } from "../agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: { kind: "agent" as const, startAfterAgentCreate: () => {} },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test.each([
  {
    scenario: "notifies the caller of an independent root",
    detached: true,
    notifyOnFinish: true,
    beforeFinish: "none",
    receivesNotification: true,
  },
  {
    scenario: "honors disabled notifications for an independent root",
    detached: true,
    notifyOnFinish: false,
    beforeFinish: "none",
    receivesNotification: false,
  },
  {
    scenario: "notifies the owning parent of a regular child",
    detached: undefined,
    notifyOnFinish: true,
    beforeFinish: "none",
    receivesNotification: true,
  },
  {
    scenario: "stops parent-owned notifications after a child is detached",
    detached: undefined,
    notifyOnFinish: true,
    beforeFinish: "detach",
    receivesNotification: false,
  },
  {
    scenario: "does not revive an archived caller when an independent root finishes",
    detached: true,
    notifyOnFinish: true,
    beforeFinish: "archive-caller",
    receivesNotification: false,
  },
])(
  "mcp create $scenario",
  async ({ detached, notifyOnFinish, beforeFinish, receivesNotification }) => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-notification-test-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const callerPrompts: AgentPromptInput[] = [];
    const clients = createTestAgentClients();
    clients.claude = createTestAgentClients({
      onStartTurn: (prompt) => callerPrompts.push(prompt),
    }).claude!;

    // Hold only the provider's completion event, letting the real manager start
    // the run and install its notification subscription before it can finish.
    const childClient = clients.codex!;
    const createSession = childClient.createSession.bind(childClient);
    const childCompletionReady = new Promise<() => void>((resolve) => {
      childClient.createSession = async (...args) => {
        const session = await createSession(...args);
        const subscribe = session.subscribe.bind(session);
        session.subscribe = (callback) =>
          subscribe((event) => {
            if (event.type === "turn_completed") {
              resolve(() => callback(event));
            } else {
              callback(event);
            }
          });
        return session;
      };
    });
    const agentManager = new AgentManager({ clients, registry: storage, logger });
    const dependencies = {
      agentManager,
      agentStorage: storage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    };

    try {
      const caller = await agentManager.createAgent(
        { provider: "claude", cwd: workdir },
        undefined,
        { workspaceId: "ws-caller" },
      );
      const { snapshot: created, initialPromptStarted } = await createAgentCommand(dependencies, {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "Created agent",
        initialPrompt: "respond with exactly: creation-notification-result",
        callerAgentId: caller.id,
        detached,
        ...(detached ? { workspaceId: "ws-detached" } : {}),
        background: true,
        notifyOnFinish,
      });
      expect(initialPromptStarted).toBe(true);
      const storedCreated = await storage.get(created.id);
      expect(storedCreated?.workspaceId).toBe(detached ? "ws-detached" : "ws-caller");
      expect(storedCreated?.labels?.[PARENT_AGENT_ID_LABEL]).toBe(detached ? undefined : caller.id);
      const completeChild = await childCompletionReady;
      expect(agentManager.getAgent(created.id)?.lifecycle).toBe("running");
      expect(callerPrompts).toEqual([]);

      if (beforeFinish === "detach") {
        await agentManager.detachAgent(created.id);
      } else if (beforeFinish === "archive-caller") {
        await agentManager.archiveAgent(caller.id);
      }

      completeChild();
      await agentManager.waitForAgentEvent(created.id, { waitForActive: true });
      // Ownership/archive guards read the loaded storage cache asynchronously.
      // Drain those microtasks before checking that a suppressed notification stayed absent.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const expectedPrompts = receivesNotification
        ? [expect.stringContaining("creation-notification-result")]
        : [];
      await vi.waitFor(() => expect(callerPrompts).toEqual(expectedPrompts));
      expect(agentManager.getAgent(created.id)?.lifecycle).toBe("idle");
      expect((await storage.get(created.id))?.labels?.[PARENT_AGENT_ID_LABEL]).toBe(
        detached || beforeFinish === "detach" ? undefined : caller.id,
      );
      expect(Boolean((await storage.get(caller.id))?.archivedAt)).toBe(
        beforeFinish === "archive-caller",
      );
    } finally {
      await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
    }
  },
);

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("manual and tool creation reject a second independent root in one workspace", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-root-conflict-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: root } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-shared",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    await expect(
      createAgentCommand(
        { agentManager, agentStorage: storage, logger, providerSnapshotManager },
        {
          kind: "mcp",
          provider: "codex/gpt-5.4",
          title: "Second root",
          initialPrompt: "Do independent work",
          callerAgentId: root.id,
          detached: true,
          background: true,
          notifyOnFinish: false,
        },
      ),
    ).rejects.toThrow(
      `Workspace "ws-shared" already has an unarchived root agent: ${root.id}. ` +
        "One workspace can have only one independent root conversation. " +
        "To create another independent conversation, call create_workspace first",
    );

    const records = await storage.listByWorkspace("ws-shared");
    expect(records.filter((record) => !record.archivedAt)).toHaveLength(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("persisted legacy roots can still load when their workspace contains duplicates", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-legacy-root-load-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const legacyRootIds = [
    "00000000-0000-4000-8000-0000000000a1",
    "00000000-0000-4000-8000-0000000000a2",
  ] as const;
  const legacyRecord = (id: string, createdAt: string): StoredAgentRecord => ({
    id,
    provider: "codex",
    cwd: workdir,
    workspaceId: "ws-legacy-duplicates",
    createdAt,
    updatedAt: createdAt,
    title: id,
    labels: {},
    lastStatus: "idle",
    config: {},
    persistence: null,
    archivedAt: null,
  });

  try {
    await storage.upsert(legacyRecord(legacyRootIds[0], "2026-09-27T10:00:00.000Z"));
    await storage.upsert(legacyRecord(legacyRootIds[1], "2026-09-27T10:01:00.000Z"));

    const loaded = await Promise.all(
      legacyRootIds.map((agentId) =>
        agentManager.createAgent({ provider: "codex", cwd: workdir }, agentId, {
          workspaceId: "ws-legacy-duplicates",
        }),
      ),
    );

    expect(loaded.map((agent) => agent.id).sort()).toEqual([...legacyRootIds]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("same-workspace subagents remain valid and an archived root can be replaced", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-root-replacement-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const root = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "ws-shared",
    });
    const { snapshot: child } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "Child",
        initialPrompt: "Do delegated work",
        callerAgentId: root.id,
        background: true,
        notifyOnFinish: false,
      },
    );
    expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(root.id);

    await agentManager.archiveAgent(root.id);
    const replacement = await agentManager.createAgent(
      { provider: "codex", cwd: workdir },
      undefined,
      { workspaceId: "ws-shared" },
    );
    expect(replacement.workspaceId).toBe("ws-shared");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("concurrent root creation commits only one root per workspace", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-root-race-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const results = await Promise.allSettled([
      agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: "ws-race",
      }),
      agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
        workspaceId: "ws-race",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toBeInstanceOf(WorkspaceRootConflictError);
    expect(
      (await storage.listByWorkspace("ws-race")).filter((record) => !record.archivedAt),
    ).toHaveLength(1);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: { kind: "agent", startAfterAgentCreate: () => {} },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
