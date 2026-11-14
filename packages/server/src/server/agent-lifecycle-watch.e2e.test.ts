import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "../../../client/src/daemon-client.js";
import { createOmpApi } from "../../../client/src/index.js";
import type { OmpAgentUpdate } from "../../../client/src/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("public lifecycle watch retains projectless live and stored agents until actual deletion", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "omp-projectless-agent-watch-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, clientId: "projectless-lifecycle-watch-test" });
  let release: (() => void) | undefined;
  try {
    await client.connect();
    const api = createOmpApi(client);
    const live = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd, modeId: "full-access", title: "Projectless live agent" },
      "00000000-0000-4000-8000-000000000991",
      { workspaceId: "missing-project-workspace" },
    );
    const liveRecord = await daemon.daemon.agentStorage.get(live.id);
    if (!liveRecord) throw new Error("Created live agent was not persisted");
    const storedId = "00000000-0000-4000-8000-000000000992";
    // A real cold record without any workspace association; no runtime is created.
    await daemon.daemon.agentStorage.upsert({
      ...liveRecord, id: storedId, workspaceId: undefined,
      title: "Projectless stored agent", persistence: null, runtimeInfo: undefined,
      requiresAttention: true, attentionReason: "finished", attentionTimestamp: liveRecord.updatedAt,
    });
    const liveUpdate = Promise.withResolvers<OmpAgentUpdate>();
    const storedUpdate = Promise.withResolvers<OmpAgentUpdate>();
    const archivedUpdate = Promise.withResolvers<OmpAgentUpdate>();
    const removedUpdate = Promise.withResolvers<OmpAgentUpdate>();
    const updates: OmpAgentUpdate[] = [];
    release = await api.agents.watch((update) => {
      updates.push(update);
      const id = update.kind === "upsert" ? update.agent.id : update.agentId;
      if (id === live.id) liveUpdate.resolve(update);
      if (id !== storedId) return;
      if (update.kind === "remove") {
        storedUpdate.resolve(update);
        archivedUpdate.resolve(update);
        removedUpdate.resolve(update);
      } else if (update.agent.archivedAt) {
        archivedUpdate.resolve(update);
      } else {
        storedUpdate.resolve(update);
      }
    });
    // Ordinary directory listings still exclude agents without project placement.
    await api.agents.list({ subscribe: { subscriptionId: "ordinary-projectless-directory" } });
    daemon.daemon.agentManager.notifyAgentState(live.id);
    expect(await liveUpdate.promise).toMatchObject({ kind: "upsert", agent: { id: live.id }, project: null });
    await daemon.daemon.agentManager.clearAgentAttention(storedId);
    expect(await storedUpdate.promise).toMatchObject({ kind: "upsert", agent: { id: storedId, requiresAttention: false }, project: null });
    const archivedAt = new Date().toISOString();
    await daemon.daemon.agentManager.archiveSnapshot(storedId, archivedAt);
    expect(await archivedUpdate.promise).toMatchObject({ kind: "upsert", agent: { id: storedId, archivedAt }, project: null });
    expect(updates.filter((update) => update.kind === "remove")).toEqual([]);
    await client.deleteAgent(storedId);
    expect(await removedUpdate.promise).toMatchObject({ kind: "remove", agentId: storedId });
  } finally {
    release?.();
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
