import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../../../client/src/daemon-client.js";
import { createOmpApi } from "../../../client/src/index.js";
import type { OmpAgentUpdate } from "../../../client/src/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("public configuration cold-reads complete agent-owned config and resolver validates real provider catalog", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "omp-public-agent-config-"));
  const clients = createTestAgentClients({ supportsMcpServers: true });
  const provider = clients.codex!;
  const fetchCatalog = provider.fetchCatalog!.bind(provider);
  provider.fetchCatalog = async (...args) => {
    const catalog = await fetchCatalog(...args);
    return { ...catalog, modes: catalog.modes.map((mode) => ({ ...mode, isUnattended: mode.id === "full-access" })) };
  };
  let nativeCreations = 0;
  const createSession = provider.createSession.bind(provider);
  const resumeSession = provider.resumeSession.bind(provider);
  provider.createSession = async (...args) => { nativeCreations += 1; return createSession(...args); };
  provider.resumeSession = async (...args) => { nativeCreations += 1; return resumeSession(...args); };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, clientId: "public-agent-configuration-test" });
  try {
    await client.connect();
    const api = createOmpApi(client);
    const historicalAgent = await api.agents.create({
      cwd,
      title: "Historical inherited configuration",
      config: {
        provider: "codex",
        modeId: "full-access",
        systemPrompt: "Agent-owned system prompt",
        mcpServers: { fixture: { type: "stdio", command: "node", args: ["--version"], env: { AGENT_VALUE: "agent-owned-value" } } },
      },
      unattended: true,
      background: true,
      notifyOnFinish: false,
      env: { LAUNCH_ONLY: "must-not-be-exposed" },
    });
    await daemon.daemon.agentManager.closeAgent(historicalAgent.id);
    await daemon.daemon.agentManager.flush();
    // Current codex create options are strictly empty. Existing persisted agents
    // may still own legacy options; cold reads must preserve them without restore.
    await daemon.daemon.agentStorage.updateRecord(historicalAgent.id, (record) => ({
      ...record,
      config: { ...record.config, providerOptions: { approval_policy: "never" } },
    }));
    const beforeRead = nativeCreations;
    const config = await historicalAgent.configuration();
    expect(nativeCreations).toBe(beforeRead);
    expect(config).toMatchObject({
      provider: "codex/gpt-5.4-mini", model: "gpt-5.4-mini", cwd, modeId: "full-access",
      title: "Historical inherited configuration",
      options: { approval_policy: "never" }, systemPrompt: "Agent-owned system prompt",
      mcpServers: { fixture: { type: "stdio", command: "node", args: ["--version"], env: { AGENT_VALUE: "agent-owned-value" } } },
    });
    expect(config).not.toHaveProperty("env");
    expect(config).not.toHaveProperty("runtimeInfo");
    expect(JSON.stringify(config)).not.toContain("must-not-be-exposed");
    await expect(api.providers.resolveCreateConfig({ provider: "codex", cwd, modeId: "not-a-mode" })).rejects.toThrow(/Invalid mode/);
    await expect(api.providers.resolveCreateConfig({ provider: "codex", cwd, model: "not-a-model" })).rejects.toThrow(/Model.*not available/);
    await expect(api.providers.resolveCreateConfig({ provider: "codex", cwd, thinkingOptionId: "not-a-thinking-option" })).rejects.toThrow(/Thinking option.*not available/);
    await expect(api.providers.resolveCreateConfig({ provider: "codex", cwd, modeId: "full-access" })).resolves.toMatchObject({ provider: "codex", modeId: "full-access" });
    const executionAgent = await api.agents.create({
      cwd, title: "Current validated execution", config: { provider: "codex", modeId: "full-access" },
    });
    const result = await executionAgent.run('Create a file named "execution-result.txt" with the content "completed"', { timeoutMs: 0 });
    expect(await readFile(path.join(cwd, "execution-result.txt"), "utf8")).toBe("completed");
    expect(result).toMatchObject({ status: "idle", canceled: false });
    expect((await api.host.info()).serverId).toBe(api.hostId);
    const foreground = await api.agents.create({
      cwd, config: { provider: "codex", modeId: "full-access" }, background: false,
      prompt: 'Create a file named "foreground-result.txt" with the content "finished-before-return"',
    });
    expect(await readFile(path.join(cwd, "foreground-result.txt"), "utf8")).toBe("finished-before-return");
    expect(foreground.status).toBe("idle");
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("public run reports cancellation, idle admission and client-only abort; watches archive and deletion independently", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "omp-public-agent-run-"));
  let entered = Promise.withResolvers<void>();
  let nativeStarts = 0;
  let hostPaused = false;
  const clients = createTestAgentClients({ onStartTurn: () => { nativeStarts += 1; entered.resolve(); } });
  // This provider acknowledges Stop with a canceled terminal event, rather than
  // the default fixture's natural completion after its sleep is interrupted.
  const provider = clients.codex!;
  const createSession = provider.createSession.bind(provider);
  provider.createSession = async (...args) => {
    const session = await createSession(...args);
    let interrupted = false;
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (...turnArgs) => { interrupted = false; return startTurn(...turnArgs); };
    const interrupt = session.interrupt.bind(session);
    session.interrupt = async () => { interrupted = true; await interrupt(); };
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (callback) => subscribe((event) => callback(
      interrupted && event.type === "turn_completed"
        ? { type: "turn_canceled", provider: event.provider, turnId: event.turnId, reason: "user Stop" }
        : event,
    ));
    session.tryHandleOutOfBand = (prompt) => prompt === "/goal pause"
      ? { run: async () => { hostPaused = true; } }
      : null;
    return session;
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, clientId: "public-agent-execution-test" });
  let release: (() => void) | undefined;
  try {
    await client.connect();
    const api = createOmpApi(client);
    const agent = await api.agents.create({ cwd, config: { provider: "codex", modeId: "full-access" } });
    await expect(agent.send("service spoof", { sourceKind: "service" })).rejects.toThrow(/host-bound plugin service/);
    const commandRun = await agent.run("/goal pause", { timeoutMs: 0 });
    expect(commandRun.status).toBe("idle");
    expect(commandRun.finalText).toBe("Hello world");
    expect(hostPaused).toBe(false);
    const startsBeforeControl = nativeStarts;
    await agent.send("/goal pause");
    expect(hostPaused).toBe(true);
    expect(nativeStarts).toBe(startsBeforeControl);
    entered = Promise.withResolvers<void>();
    const running = agent.run("sleep", { timeoutMs: 0 });
    await entered.promise;
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    await expect(agent.send("idle-only prompt", { requireIdle: true })).rejects.toThrow(/already has an active run/);
    await agent.stop();
    expect(await running).toMatchObject({ status: "idle", canceled: true });
    entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const detachedWait = agent.run("sleep", { timeoutMs: 0, signal: abort.signal });
    const rejected = expect(detachedWait).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    await daemon.daemon.agentManager.waitForAgentRunStart(agent.id);
    abort.abort();
    await rejected;
    expect(daemon.daemon.agentManager.hasInFlightRun(agent.id)).toBe(true);
    await agent.stop();
    const changes: OmpAgentUpdate[] = [];
    const archived = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    release = await api.agents.watch((update) => {
      changes.push(update);
      if (update.kind === "upsert" && update.agent.id === agent.id && update.agent.archivedAt) archived.resolve();
      if (update.kind === "remove" && update.agentId === agent.id) removed.resolve();
    });
    // A regular directory subscription must not replace the independent watch lease.
    await api.agents.list({ subscribe: { subscriptionId: "ordinary-directory" } });
    await agent.archive();
    await archived.promise;
    await client.deleteAgent(agent.id);
    await removed.promise;
    expect(changes.some((update) => update.kind === "upsert" && Boolean(update.agent.archivedAt))).toBe(true);
    release();
    release = undefined;
    const observedBeforeRelease = changes.length;
    await api.agents.create({ cwd, config: { provider: "codex", modeId: "full-access" } });
    expect(changes).toHaveLength(observedBeforeRelease);
  } finally {
    release?.();
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
