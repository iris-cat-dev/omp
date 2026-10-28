import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentConfigSession } from "../session/agent-config/agent-config-session.js";
import type { SessionOutboundMessage } from "../messages.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { scenario: "model request", bundle: false, concurrent: false, invalid: false, archived: false },
  { scenario: "config bundle", bundle: true, concurrent: false, invalid: false, archived: false },
  {
    scenario: "in-flight history restore",
    bundle: false,
    concurrent: true,
    invalid: false,
    archived: false,
  },
  {
    scenario: "invalid replacement",
    bundle: false,
    concurrent: false,
    invalid: true,
    archived: false,
  },
  {
    scenario: "archived conversation",
    bundle: false,
    concurrent: false,
    invalid: false,
    archived: true,
  },
])(
  "recovers a removed model through $scenario",
  async ({ bundle, concurrent, invalid, archived }) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-model-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const baseClient = createTestAgentClients().codex!;
    const agentId = "00000000-0000-4000-8000-000000000303";
    const oldModel = "removed/old-model";
    const newModel = invalid ? "missing/new-model" : "available/new-model";
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client: AgentClient = {
      provider: baseClient.provider,
      capabilities: baseClient.capabilities,
      isAvailable: () => baseClient.isAvailable(),
      fetchCatalog: (options) => baseClient.fetchCatalog(options),
      createSession: (config, context) => baseClient.createSession(config, context),
      resumeSession: async (handle, config, context) => {
        if (config?.model === oldModel && concurrent) {
          started.resolve();
          await release.promise;
        }
        if (config?.model !== "available/new-model") {
          throw new Error(`Model "${config?.model}" not found`);
        }
        return baseClient.resumeSession(handle, config, context);
      },
    };
    const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
    const emitted: SessionOutboundMessage[] = [];
    const subsystem = new AgentConfigSession({
      logger,
      host: { emit: (message) => emitted.push(message) },
      operations: {
        ensureLoaded: async (id, modelId) => {
          await ensureUnarchivedAgentLoaded(id, {
            agentManager: manager,
            agentStorage: storage,
            logger,
            modelId,
          });
        },
        setModel: (id, model) => manager.setAgentModel(id, model),
        setMode: (id, mode) => manager.setAgentMode(id, mode),
        setThinking: (id, thinking) => manager.setAgentThinkingOption(id, thinking),
        setFeature: (id, feature, value) => manager.setAgentFeature(id, feature, value),
        setGoalObjective: (id, objective) => manager.setAgentGoalObjective(id, objective),
        controlGoal: (id, action) => manager.controlAgentGoal(id, action),
      },
    });
    let historyLoad: Promise<unknown> | undefined;
    try {
      await storage.upsert({
        id: agentId,
        provider: "codex",
        cwd: root,
        workspaceId: "original-workspace",
        createdAt: "2026-10-19T06:41:10.189Z",
        updatedAt: "2026-10-26T08:10:58.124Z",
        labels: { important: "keep" },
        title: "Original conversation",
        lastStatus: "closed",
        config: { model: oldModel, thinkingOptionId: "high" },
        persistence: {
          provider: "codex",
          sessionId: "original-session",
          metadata: { model: oldModel },
        },
        ...(archived ? { archivedAt: "2026-10-27T00:00:00.000Z" } : {}),
      });
      if (concurrent) {
        historyLoad = ensureAgentLoaded(agentId, {
          agentManager: manager,
          agentStorage: storage,
          logger,
        }).catch((error: unknown) => error);
        await started.promise;
      }
      const request = bundle
        ? subsystem.handleAgentConfigApplyRequest({
            type: "agent.config.apply.request",
            agentId,
            requestId: "recover-model",
            config: { modelId: newModel, modeId: "full-access" },
          })
        : subsystem.handleSetAgentModelRequest({
            type: "set_agent_model_request",
            agentId,
            requestId: "recover-model",
            modelId: newModel,
          });
      release.resolve();
      await request;
      await historyLoad;
      expect(emitted.at(-1)).toMatchObject({
        type: bundle ? "agent.config.apply.response" : "set_agent_model_response",
        payload: { agentId, accepted: !invalid && !archived },
      });
      await manager.flush();
      const stored = await storage.get(agentId);
      expect(stored).toMatchObject({
        title: "Original conversation",
        workspaceId: "original-workspace",
        labels: { important: "keep" },
        config: { model: invalid || archived ? oldModel : newModel, thinkingOptionId: "high" },
        persistence: { sessionId: "original-session" },
      });
      if (invalid || archived) {
        expect(manager.getAgent(agentId)).toBeNull();
      } else {
        expect(manager.getAgent(agentId)?.runtimeInfo?.model).toBe(newModel);
        if (bundle) expect(manager.getAgent(agentId)?.currentModeId).toBe("full-access");
      }
    } finally {
      release.resolve();
      await historyLoad;
      await manager.closeAgent(agentId).catch(() => undefined);
      await manager.flush();
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);
