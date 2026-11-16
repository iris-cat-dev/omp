import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { createStub } from "./test-utils/class-mocks.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";

const homes: string[] = [];
const logger = pino({ level: "silent" });

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(input: Partial<PersistedWorkspaceRecord> = {}) {
  const home = await mkdtemp(join(tmpdir(), "workspace-native-title-"));
  homes.push(home);
  const file = join(home, "workspaces.json");
  const registry = new FileBackedWorkspaceRegistry(file, logger);
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace",
    projectId: "project",
    cwd: home,
    kind: "directory",
    displayName: "directory",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    ...input,
  });
  await registry.upsert(workspace);
  return { file, registry, workspace };
}

function naming(
  registry: Pick<WorkspaceRegistry, "update">,
  labels: Record<string, string> = {},
) {
  return new WorkspaceAutoName({
    agentManager: createStub<AgentManager>({
      getAgent: () => ({
        id: "root",
        workspaceId: "workspace",
        internal: false,
        lifecycle: "idle",
        labels,
      }),
    }),
    workspaceRegistry: registry,
    workspaceGitService: createStub<WorkspaceGitService>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger,
    generateBranchName: async () => {
      throw new Error("Workspace titles must not invoke a Desktop model");
    },
  });
}

test("native names replace provisional titles and survive registry reload", async () => {
  const { file, registry } = await fixture({ title: "Fix login bug", titleSource: "auto" });
  await naming(registry).applyNativeSessionTitle({ agentId: "root", title: "修复登录" });
  expect(await new FileBackedWorkspaceRegistry(file, logger).get("workspace")).toMatchObject({
    title: "修复登录",
    titleSource: "auto",
  });
});

test.each(["Fix login bug", null])(
  "manual titles remain locked after restart, including %s",
  async (title) => {
    const { file, registry } = await fixture({ title: "Fix login bug", titleSource: "auto" });
    await registry.update("workspace", (record) => ({ ...record, title, titleSource: "user" }));
    const reopened = new FileBackedWorkspaceRegistry(file, logger);
    await naming(reopened).applyNativeSessionTitle({ agentId: "root", title: "模型名称" });
    expect(await reopened.get("workspace")).toMatchObject({ title, titleSource: "user" });
  },
);

test("legacy nonempty titles with no source are preserved", async () => {
  const { file, workspace } = await fixture({ title: "Legacy title" });
  const { titleSource: _source, ...legacy } = workspace;
  await writeFile(file, JSON.stringify([legacy]));
  const reopened = new FileBackedWorkspaceRegistry(file, logger);
  await naming(reopened).applyNativeSessionTitle({ agentId: "root", title: "Native title" });
  expect(await reopened.get("workspace")).toMatchObject({ title: "Legacy title", titleSource: null });
});

test("a managed child cannot rename its parent's workspace", async () => {
  const { registry } = await fixture();
  await naming(registry, { [PARENT_AGENT_ID_LABEL]: "parent" }).applyNativeSessionTitle({
    agentId: "root",
    title: "Child task",
  });
  expect(await registry.get("workspace")).toMatchObject({ title: null, titleSource: "auto" });
});

test.each(["rename", "archive"] as const)(
  "native title application rechecks a concurrent %s before writing",
  async (operation) => {
    const { registry } = await fixture({ title: "Prompt title", titleSource: "auto" });
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const delayed: Pick<WorkspaceRegistry, "update"> = {
      update: async (id, updater) => {
        started.resolve();
        await proceed.promise;
        return registry.update(id, updater);
      },
    };
    const pending = naming(delayed).applyNativeSessionTitle({ agentId: "root", title: "Late title" });
    await started.promise;
    if (operation === "rename") {
      await registry.update("workspace", (record) => ({ ...record, title: "Prompt title", titleSource: "user" }));
    } else {
      await registry.archive("workspace", "2026-11-16T00:01:00.000Z");
    }
    proceed.resolve();
    await pending;
    expect(await registry.get("workspace")).toMatchObject({
      title: "Prompt title",
      ...(operation === "rename" ? { titleSource: "user" } : { archivedAt: "2026-11-16T00:01:00.000Z" }),
    });
  },
);
