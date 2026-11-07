import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createLinkedSubmoduleFixture,
  fixtureGit,
  initializeFixtureRepo,
} from "../../test-utils/git-submodule-worktree.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createGitHubService } from "../../services/github-service.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createPaseoWorktree } from "../paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { WorkspaceReconciliationService } from "../workspace-reconciliation-service.js";
import { bootstrapWorkspaceRegistries } from "../workspace-registry-bootstrap.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { repairGitDirectoryRoots } from "./repair-git-directory-roots.migration.js";

const tempDirs: string[] = [];
const logger = createTestLogger();
const createdAt = "2026-04-01T00:00:00.000Z";
const updatedAt = "2026-04-02T00:00:00.000Z";
const archivedAt = "2026-04-03T00:00:00.000Z";

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-root-migration-"));
  tempDirs.push(dir);
  return dir;
}

function registries(paseoHome: string) {
  return {
    projectRegistry: new FileBackedProjectRegistry(join(paseoHome, "projects.json"), logger),
    workspaceRegistry: new FileBackedWorkspaceRegistry(join(paseoHome, "workspaces.json"), logger),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("repairs all startup roots independently, retaining archived identities and agent ownership across restarts", async () => {
  const fixture = createLinkedSubmoduleFixture(temporaryDirectory());
  const original = registries(fixture.paseoHome);
  const projects = ([
    ["broken", fixture.gitDir, null],
    ["archived", fixture.gitDir, archivedAt],
    ["correct", fixture.sourceRoot, null],
  ] as const).map(([projectId, rootPath, archived]) =>
    createPersistedProjectRecord({
      projectId,
      rootPath,
      kind: "git",
      displayName: "Original project name",
      customName: "My SDK",
      customIconRevision: "icon-1",
      projectKey: "preserve-project-key",
      createdAt,
      updatedAt,
      archivedAt: archived,
    }),
  );
  const workspaces = projects.map((project) =>
    createPersistedWorkspaceRecord({
      workspaceId: `ws-${project.projectId}`,
      projectId: project.projectId,
      cwd: fixture.worktreeRoot,
      worktreeRoot: fixture.worktreeRoot,
      mainRepoRoot: fixture.gitDir,
      kind: "worktree",
      displayName: "SDK branch",
      title: "Keep this title",
      branch: "sdk-feature",
      baseBranch: "main",
      isPaseoOwnedWorktree: true,
      createdAt,
      updatedAt,
      archivedAt: project.archivedAt,
      pinnedAt: createdAt,
      labels: ["keep-label"],
      autoArchivedChangeRequestUrl: "https://example.com/pull/1",
    }),
  );
  for (const project of projects) await original.projectRegistry.upsert(project);
  for (const workspace of workspaces) await original.workspaceRegistry.upsert(workspace);
  const agentStorage = new AgentStorage(join(fixture.paseoHome, "agents"), logger);
  await agentStorage.initialize();
  await agentStorage.upsert({
    id: "owned-agent",
    workspaceId: "ws-broken",
    provider: "codex",
    cwd: fixture.worktreeRoot,
    createdAt,
    updatedAt,
    lastActivityAt: null,
    lastUserMessageAt: null,
    title: "Agent title",
    labels: {},
    lastStatus: "idle",
    lastModeId: null,
    config: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    persistence: null,
    archivedAt: null,
  });
  const agentsBefore = await agentStorage.list();
  const workspaceGitService = new WorkspaceGitServiceImpl({ paseoHome: fixture.paseoHome, logger });
  try {
    const first = registries(fixture.paseoHome);
    await bootstrapWorkspaceRegistries({
      ...first,
      paseoHome: fixture.paseoHome,
      agentStorage,
      workspaceGitService,
      logger,
    });
    const expectedProjects = projects.map((project) => ({ ...project, rootPath: fixture.sourceRoot }));
    const expectedWorkspaces = workspaces.map((workspace) => ({
      ...workspace,
      mainRepoRoot: fixture.sourceRoot,
    }));
    expect(await first.projectRegistry.list()).toEqual(expectedProjects);
    expect(await first.workspaceRegistry.list()).toEqual(expectedWorkspaces);
    expect(await agentStorage.list()).toEqual(agentsBefore);

    const files = ["projects.json", "workspaces.json"].map((file) => join(fixture.paseoHome, file));
    const afterRepair = files.map((file) => readFileSync(file, "utf8"));
    const restarted = registries(fixture.paseoHome);
    await bootstrapWorkspaceRegistries({
      ...restarted,
      paseoHome: fixture.paseoHome,
      agentStorage,
      workspaceGitService,
      logger,
    });
    expect(await restarted.projectRegistry.list()).toEqual(expectedProjects);
    expect(await restarted.workspaceRegistry.list()).toEqual(expectedWorkspaces);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(afterRepair);
  } finally {
    await workspaceGitService.dispose();
  }
});

it("leaves normal, bare, missing and unverified registry roots untouched", async () => {
  const tempDir = temporaryDirectory();
  const repoRoot = join(tempDir, "normal");
  initializeFixtureRepo(repoRoot);
  const bareRoot = join(tempDir, "bare");
  fixtureGit(tempDir, "clone", "--bare", repoRoot, bareRoot);
  const missingSource = join(tempDir, "missing-source-admin");
  const incorrectBacklink = join(tempDir, "incorrect-admin");
  for (const dir of [missingSource, incorrectBacklink]) mkdirSync(dir);
  writeFileSync(join(missingSource, "config"), "[core]\n\tworktree = ../absent-source\n");
  writeFileSync(
    join(incorrectBacklink, "config"),
    `[core]\n\tworktree = ${JSON.stringify(realpathSync(repoRoot))}\n`,
  );
  const targets = [repoRoot, bareRoot, join(repoRoot, ".git"), missingSource, incorrectBacklink];
  const stores = registries(join(tempDir, "home"));
  for (const [index, rootPath] of targets.entries()) {
    await stores.projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: `project-${index}`,
        rootPath,
        kind: "git",
        displayName: "Keep",
        createdAt,
        updatedAt,
      }),
    );
    await stores.workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: `workspace-${index}`,
        projectId: `project-${index}`,
        cwd: repoRoot,
        kind: "worktree",
        mainRepoRoot: rootPath,
        displayName: "Keep",
        createdAt,
        updatedAt,
      }),
    );
  }
  const projectsBefore = await stores.projectRegistry.list();
  const workspacesBefore = await stores.workspaceRegistry.list();
  await repairGitDirectoryRoots({ ...stores, logger });
  const reloaded = registries(join(tempDir, "home"));
  expect(await reloaded.projectRegistry.list()).toEqual(projectsBefore);
  expect(await reloaded.workspaceRegistry.list()).toEqual(workspacesBefore);
});

it("creates from a submodule worktree using its real source and keeps that source after reconciliation", async () => {
  const fixture = createLinkedSubmoduleFixture(temporaryDirectory());
  const stores = registries(fixture.paseoHome);
  const workspaceGitService = new WorkspaceGitServiceImpl({ paseoHome: fixture.paseoHome, logger });
  const reconciliation = new WorkspaceReconciliationService({
    ...stores,
    workspaceGitService,
    logger,
  });
  try {
    expect(await workspaceGitService.resolveRepoRoot(fixture.worktreeRoot)).toBe(fixture.sourceRoot);
    const workspaceProvisioning = createWorkspaceProvisioningService({
      ...stores,
      workspaceGitService,
      logger,
    });
    const created = await createPaseoWorktree(
      {
        cwd: fixture.worktreeRoot,
        worktreeSlug: "created-from-sdk",
        branchName: "created-from-sdk",
        title: "SDK work",
        runSetup: false,
        paseoHome: fixture.paseoHome,
      },
      {
        workspaceGitService,
        workspaceProvisioning,
        github: createGitHubService(),
      },
    );
    expect(created.repoRoot).toBe(fixture.sourceRoot);
    expect(created.workspace.mainRepoRoot).toBe(fixture.sourceRoot);
    expect(await stores.projectRegistry.get(created.workspace.projectId)).toMatchObject({
      rootPath: fixture.sourceRoot,
      kind: "git",
    });
    expect(fixtureGit(created.workspace.cwd, "rev-parse", "--git-common-dir")).toBe(fixture.gitDir);
    await reconciliation.runOnce();
    expect(await stores.workspaceRegistry.get(created.workspace.workspaceId)).toMatchObject({
      projectId: created.workspace.projectId,
      title: "SDK work",
      mainRepoRoot: fixture.sourceRoot,
      cwd: created.workspace.cwd,
      archivedAt: null,
    });
    expect(await stores.projectRegistry.get(created.workspace.projectId)).toMatchObject({
      rootPath: fixture.sourceRoot,
      archivedAt: null,
    });
  } finally {
    reconciliation.dispose();
    await workspaceGitService.dispose();
  }
});
