import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { buildSessionConfig } from "../../../persistence-hooks.js";
import { AgentManager, type AgentManagerEvent, type ManagedAgent } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentClient } from "./agent.js";
import { OmpRuntimeEventSchema } from "./rpc-types.js";
import { FakeOmp, type FakeOmpSession } from "./test-utils/fake-omp.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const fixtures: Array<{ root: string; manager: AgentManager; client: OmpAgentClient }> = [];
afterEach(async () => {
  for (const { root, manager, client } of fixtures.splice(0)) {
    await manager.flush();
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(storageFactory?: (root: string) => AgentStorage) {
  const root = await mkdtemp(join(tmpdir(), "omp-native-title-"));
  const logger = createTestLogger();
  const runtime = new FakeOmp();
  const client = new OmpAgentClient({
    logger,
    runtime,
    runtimeSettings: { ...ompHistoryRuntimeSettings, env: { PI_CODING_AGENT_DIR: root } },
    quotaFetch: async () => new Response(null, { status: 401 }),
  });
  const storage = storageFactory?.(root) ?? new AgentStorage(join(root, "agents"), logger);
  const manager = new AgentManager({ clients: { omp: client }, registry: storage, logger });
  fixtures.push({ root, manager, client });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { replayState: false });
  const titles = () => events.flatMap((event) =>
    event.type === "agent_stream" && event.event.type === "session_title_changed" ? [event.event] : [],
  );
  return { root, runtime, client, storage, manager, titles };
}

function changeNativeTitle(runtime: FakeOmpSession, title: string, source?: "auto" | "user") {
  runtime.state = { ...runtime.state, sessionName: title, titleSource: source };
  runtime.emit(OmpRuntimeEventSchema.parse({
    type: "session_info_update", sessionId: runtime.state.sessionId, title, titleSource: source,
  }));
}

async function savedSession(root: string) {
  const nativeHandle = join(root, "session.jsonl");
  await writeFile(nativeHandle, `${JSON.stringify({ type: "session", id: "omp-session-1", cwd: root })}\n`);
  return { provider: "omp" as const, sessionId: "omp-session-1", nativeHandle, metadata: { cwd: root } };
}

test("initial, idle native and explicit titles reach agent_stream and durable agent metadata", async () => {
  const { root, runtime, storage, manager, titles } = await setup();
  runtime.setInitialSessionTitle("Initial native title", "auto");
  const agent = await manager.createAgent({ provider: "omp", cwd: root }, undefined, { workspaceId: undefined });
  const native = runtime.latestSession();
  expect(runtime.recordedLaunches.find((launch) => launch.noSession === false)?.autoTitle).toBe(true);
  expect((await storage.get(agent.id))?.title).toBe("Initial native title");
  expect((await storage.get(agent.id))?.config?.title).toBeUndefined();
  expect(titles()).toMatchObject([{ title: "Initial native title", source: "auto" }]);

  changeNativeTitle(native, "Generated native title", "auto");
  native.emit(OmpRuntimeEventSchema.parse({ type: "session_info_update", sessionId: native.state.sessionId }));
  native.emit(OmpRuntimeEventSchema.parse({ type: "session_info_update", sessionId: native.state.sessionId, title: "  " }));
  await manager.flush();
  expect((await storage.get(agent.id))?.title).toBe("Generated native title");
  expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  await manager.setTitle(agent.id, "My title");
  expect(native.state).toMatchObject({ sessionName: "My title", titleSource: "user" });
  expect((await storage.get(agent.id))?.config?.title).toBe("My title");

  changeNativeTitle(native, "Late auto title", "auto");
  native.emit(OmpRuntimeEventSchema.parse({
    type: "session_info_update", sessionId: "native-child", title: "Child title", titleSource: "user",
  }));
  await manager.flush();
  expect((await storage.get(agent.id))?.title).toBe("My title");
  changeNativeTitle(native, "Native slash rename", "user");
  await manager.flush();
  expect((await storage.get(agent.id))?.title).toBe("Native slash rename");
  expect(titles().map((event) => event.title)).toEqual([
    "Initial native title", "Generated native title", "My title", "Native slash rename",
  ]);
  expect(native.prompts).toEqual([]);
});

test.each(["auto", "user", undefined] as const)("restored %s titles publish without a running turn", async (source) => {
  const { root, runtime, manager, storage, titles } = await setup();
  runtime.setInitialSessionTitle("Restored native title", source);
  const agent = await manager.resumeAgentFromPersistence(await savedSession(root));
  expect((await storage.get(agent.id))?.title).toBe("Restored native title");
  expect(titles()).toMatchObject([{ title: "Restored native title", source }]);
  expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
  expect(runtime.latestSession().prompts).toEqual([]);
});

test("legacy source-less changes preserve existing titles and explicit title locks survive reload", async () => {
  const { root, runtime, manager, client, storage, titles } = await setup();
  const handle = await savedSession(root);
  runtime.setInitialSessionFile(handle.nativeHandle);
  const agent = await manager.createAgent({ provider: "omp", cwd: root }, undefined, {
    workspaceId: undefined, initialTitle: "Existing legacy title",
  });
  changeNativeTitle(runtime.latestSession(), "Unknown-source title");
  await manager.flush();
  expect((await storage.get(agent.id))?.title).toBe("Existing legacy title");
  expect(titles().at(-1)?.title).toBe("Unknown-source title");

  await manager.setTitle(agent.id, "Explicit title");
  runtime.setInitialSessionTitle("Stale native auto title", "auto");
  const restored = await manager.reloadAgentSession(agent.id);
  expect(runtime.latestSession().state).toMatchObject({ sessionName: "Explicit title", titleSource: "user" });
  expect((await storage.get(restored.id))?.title).toBe("Explicit title");
  expect(titles().at(-1)).toMatchObject({ title: "Explicit title", source: "user" });

  const reopened = new AgentStorage(join(root, "agents"), createTestLogger());
  const stored = await reopened.get(restored.id);
  if (!stored) throw new Error("Expected persisted native agent");
  const coldConfig = buildSessionConfig(stored);
  if (!coldConfig) throw new Error("Expected restorable native agent config");
  expect(coldConfig.title).toBe("Explicit title");
  const coldSession = await client.resumeSession(handle, coldConfig);
  expect(runtime.latestSession().state).toMatchObject({ sessionName: "Explicit title", titleSource: "user" });
  const replay: AgentStreamEvent[] = [];
  const unsubscribe = coldSession.subscribe((event) => replay.push(event));
  unsubscribe();
  expect(replay).toContainEqual(expect.objectContaining({
    type: "session_title_changed", title: "Explicit title", source: "user",
  }));
  await coldSession.close();
});

test("a rename during the first snapshot write survives subscribe replay", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { root, runtime, manager, storage, titles } = await setup((root) => new class extends AgentStorage {
    first = true;
    override async applySnapshot(
      agent: ManagedAgent,
      options?: { title?: string | null; initialTitle?: string | null; internal?: boolean },
    ) {
      if (this.first) {
        this.first = false;
        entered.resolve();
        await release.promise;
      }
      await super.applySnapshot(agent, options);
    }
  }(join(root, "agents"), createTestLogger()));
  const id = "00000000-0000-4000-8000-000000000912";
  runtime.setInitialSessionTitle("Early auto title", "auto");
  const creating = manager.createAgent({ provider: "omp", cwd: root }, id, { workspaceId: undefined });
  try {
    await entered.promise;
    await manager.setTitle(id, "Rename during initialization");
  } finally {
    release.resolve();
  }
  await creating;
  expect((await storage.get(id))?.title).toBe("Rename during initialization");
  expect(titles()).toMatchObject([{ title: "Rename during initialization", source: "user" }]);
});

test("in-flight state readback cannot replace a newer native title notification", async () => {
  const { root, runtime, manager, storage, titles } = await setup();
  runtime.setInitialSessionTitle("Old title", "auto");
  const agent = await manager.createAgent({ provider: "omp", cwd: root }, undefined, { workspaceId: undefined });
  const session = manager.getAgent(agent.id)?.session;
  if (!session) throw new Error("Expected live native session");
  const native = runtime.latestSession();
  const stale = { ...native.state };
  const state = Promise.withResolvers<typeof stale>();
  const getState = native.getState.bind(native);
  native.getState = () => state.promise;
  const refreshing = session.getRuntimeInfo();
  changeNativeTitle(native, "New title", "auto");
  state.resolve(stale);
  await refreshing;
  native.getState = getState;
  await manager.flush();
  const replay: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => replay.push(event));
  unsubscribe();
  expect((await storage.get(agent.id))?.title).toBe("New title");
  expect(titles().map((event) => event.title)).toEqual(["Old title", "New title"]);
  expect(replay).toContainEqual(expect.objectContaining({ type: "session_title_changed", title: "New title" }));
});

test("internal metadata and explicitly non-persistent sessions remain unnamed by auto-title", async () => {
  const { root, runtime, manager, client, storage, titles } = await setup();
  const internal = await manager.createAgent({ provider: "omp", cwd: root, internal: true }, undefined, { workspaceId: undefined });
  const metadata = runtime.latestSession();
  expect(runtime.recordedLaunches.at(-1)).toMatchObject({ noSession: true, autoTitle: false });
  changeNativeTitle(metadata, "Internal native title", "auto");
  await manager.flush();
  expect(await storage.get(internal.id)).toBeNull();
  expect(titles()).toEqual([]);
  const temporary = await client.createSession({ provider: "omp", cwd: root }, undefined, { persistSession: false });
  expect(runtime.recordedLaunches.at(-1)).toMatchObject({ noSession: true, autoTitle: false });
  expect(runtime.latestSession().prompts).toEqual([]);
  await temporary.close();
});
