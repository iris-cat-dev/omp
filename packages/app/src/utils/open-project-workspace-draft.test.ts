import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type * as ReactModule from "react";
import type * as WorkspaceNavigation from "@/stores/navigation-active-workspace-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openProjectWorkspaceDraft } from "./open-project-workspace-draft";
import { useGlobalNewWorkspaceAction } from "@/hooks/use-global-new-workspace-action";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { buildProjectLayoutKey } from "@/workspace-tabs/model";
import { clearWorkspaceArchivePending } from "@/contexts/session-workspace-upserts";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

const state = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  navigateToRoute: vi.fn(),
  registerHandler: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof ReactModule>(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: state.error }) }));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => [{ serverId: "host" }] }));
vi.mock("@/hooks/use-keyboard-action-handler", () => ({
  useKeyboardActionHandler: state.registerHandler,
}));
vi.mock("@/navigation/workspace-route-navigation", () => ({
  navigateToHostWorkspaceRoute: state.navigateToRoute,
}));
vi.mock("@/stores/navigation-active-workspace-store", async (importOriginal) => ({
  ...await importOriginal<typeof WorkspaceNavigation>(),
  useActiveWorkspaceSelection: () => ({ serverId: "host", workspaceId: "root-workspace" }),
}));

const project = { serverId: "host", projectId: "project", projectRootPath: "/repo" };
const rootWorkspace: WorkspaceDescriptor = {
  id: "root-workspace",
  name: "hi",
  title: null,
  projectId: "project",
  projectDisplayName: "repo",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
  projectKind: "git",
  workspaceKind: "local_checkout",
  status: "done",
  archivingAt: null,
  statusEnteredAt: null,
  diffStat: null,
  scripts: [],
};

function drafts(serverId = "host", projectId = "project") {
  const key = buildProjectLayoutKey({ serverId, projectId })!;
  return useWorkspaceLayoutStore.getState().getWorkspaceTabs(key)
    .flatMap((tab) => tab.target.kind === "draft" ? [tab.target] : []);
}
function workspaces(serverId = "host") {
  return useSessionStore.getState().sessions[serverId]!.workspaces;
}
function initializeHost(serverId: string) {
  useSessionStore.getState().initializeSession(serverId, {
    createWorkspace: state.createWorkspace,
    archiveWorkspace: state.archiveWorkspace,
  } as unknown as DaemonClient);
  useSessionStore.getState().updateSessionServerInfo(serverId, {
    serverId, hostname: "test", version: "test", features: { workspaceArchiveIfEmpty: true },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  useSessionStore.setState({ sessions: {} });
  useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {} });
  useCreateFlowStore.getState().clearAll();
  initializeHost("host");
  let nextId = 0;
  state.createWorkspace.mockImplementation(async ({ source }) => ({
    workspace: {
      ...rootWorkspace, id: `new-workspace-${++nextId}`, name: "main",
      projectId: source.projectId, projectRootPath: source.path, workspaceDirectory: source.path,
    },
    error: null,
  }));
  state.archiveWorkspace.mockImplementation(async (_id, options) => {
    if (options?.onlyIfEmpty !== true) throw new Error("Cleanup must be conditional");
    return { archivedAt: "2026-11-07T00:00:00Z", error: null };
  });
});
afterEach(() => {
  for (const serverId of ["host", "host-2"]) {
    for (const workspaceId of useSessionStore.getState().sessions[serverId]?.workspaces.keys() ?? []) {
      clearWorkspaceArchivePending({ serverId, workspaceId });
    }
    for (let index = 1; index <= 4; index++) {
      clearWorkspaceArchivePending({ serverId, workspaceId: `new-workspace-${index}` });
    }
  }
});

it("coalesces a slow keyboard request with the project's other ordinary draft entry", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [rootWorkspace]);
  const creation = Promise.withResolvers<{ workspace: WorkspaceDescriptor; error: null }>();
  state.createWorkspace.mockReturnValue(creation.promise);
  useGlobalNewWorkspaceAction();
  const { handle } = state.registerHandler.mock.calls[0]![0];
  expect(handle()).toBe(true);
  expect(handle()).toBe(true);
  const projectEntry = openProjectWorkspaceDraft(project);
  await Promise.resolve();
  expect(workspaces().size).toBe(1);
  expect(drafts()).toEqual([]);
  expect(state.createWorkspace).toHaveBeenCalledTimes(1);
  creation.resolve({ workspace: { ...rootWorkspace, id: "new-workspace-1" }, error: null });
  await projectEntry;
  expect(workspaces().size).toBe(2);
  expect(drafts()).toHaveLength(1);
  expect(drafts()[0]?.workspaceId).toBe("new-workspace-1");
  expect(state.createWorkspace).toHaveBeenCalledTimes(1);
  expect(state.navigateToRoute).toHaveBeenCalledTimes(1);
});

it("keeps the current tab host while sequential new conversations remain independent", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [rootWorkspace]);
  useGlobalNewWorkspaceAction();
  const { handle } = state.registerHandler.mock.calls[0]![0];
  handle();
  await vi.waitFor(() => expect(drafts()).toHaveLength(1));
  handle();
  await vi.waitFor(() => expect(drafts()).toHaveLength(2));
  expect(workspaces().get(rootWorkspace.id)).toEqual(rootWorkspace);
  expect([...workspaces().keys()]).toEqual(["root-workspace", "new-workspace-1", "new-workspace-2"]);
  expect(drafts().map((target) => target.workspaceId)).toEqual(["new-workspace-1", "new-workspace-2"]);
  expect(new Set(drafts().map((target) => target.draftId)).size).toBe(2);
  expect(state.navigateToRoute.mock.calls.map(([route]) => parseHostWorkspaceRouteFromPathname(route))).toEqual([
    { serverId: "host", workspaceId: "root-workspace" },
    { serverId: "host", workspaceId: "root-workspace" },
  ]);
});

it("releases the shared pending request after failure so the next attempt succeeds", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [rootWorkspace]);
  const creation = Promise.withResolvers<never>();
  state.createWorkspace.mockReturnValueOnce(creation.promise);
  const first = openProjectWorkspaceDraft(project);
  const duplicate = openProjectWorkspaceDraft(project);
  const error = new Error("Host disconnected");
  const results = Promise.allSettled([first, duplicate]);
  creation.reject(error);
  expect(await results).toEqual([
    { status: "rejected", reason: error }, { status: "rejected", reason: error },
  ]);
  expect([...workspaces().keys()]).toEqual([rootWorkspace.id]);
  expect(drafts()).toEqual([]);
  await openProjectWorkspaceDraft(project);
  expect(workspaces().size).toBe(2);
  expect(drafts()).toHaveLength(1);
});

it("allows different hosts and projects to create while another project is pending", async () => {
  initializeHost("host-2");
  const slow = Promise.withResolvers<{ workspace: WorkspaceDescriptor; error: null }>();
  state.createWorkspace.mockReturnValueOnce(slow.promise);
  const pending = openProjectWorkspaceDraft(project);
  await Promise.resolve();
  await Promise.all([
    openProjectWorkspaceDraft({ ...project, projectId: "other-project", projectRootPath: "/other" }),
    openProjectWorkspaceDraft({ ...project, serverId: "host-2" }),
  ]);
  expect(drafts()).toEqual([]);
  expect(drafts("host", "other-project")).toHaveLength(1);
  expect(drafts("host-2")).toHaveLength(1);
  slow.resolve({ workspace: { ...rootWorkspace, id: "slow-workspace" }, error: null });
  await pending;
  expect(drafts()).toHaveLength(1);
});

it("never hosts a newly created draft in another project's layout", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [{ ...rootWorkspace, projectId: "other-project" }]);
  await openProjectWorkspaceDraft({
    ...project, draftId: "other-project-draft", tabHost: { serverId: "host", workspaceId: rootWorkspace.id },
  });
  expect(drafts("host", "other-project")).toEqual([]);
  expect(drafts()).toMatchObject([{ draftId: "other-project-draft", workspaceId: "new-workspace-1" }]);
});

it("rechecks the tab host after creation instead of navigating to a stale checkout", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [rootWorkspace]);
  const creation = Promise.withResolvers<{ workspace: WorkspaceDescriptor; error: null }>();
  state.createWorkspace.mockReturnValue(creation.promise);
  const pending = openProjectWorkspaceDraft({
    ...project, draftId: "pending-draft", tabHost: { serverId: "host", workspaceId: rootWorkspace.id },
  });
  useSessionStore.getState().mergeWorkspaces("host", [{ ...rootWorkspace, archivingAt: "2026-10-10T00:00:00Z" }]);
  creation.resolve({ workspace: { ...rootWorkspace, id: "new-workspace-1" }, error: null });
  await pending;
  expect(drafts()).toMatchObject([{ draftId: "pending-draft", workspaceId: "new-workspace-1" }]);
  expect(parseHostWorkspaceRouteFromPathname(state.navigateToRoute.mock.calls[0]?.[0])).toEqual({
    serverId: "host", workspaceId: "new-workspace-1",
  });
});

it("does not swallow distinct fork content while an ordinary draft is pending", async () => {
  const creation = Promise.withResolvers<{ workspace: WorkspaceDescriptor; error: null }>();
  state.createWorkspace.mockReturnValueOnce(creation.promise);
  const pending = openProjectWorkspaceDraft(project);
  await Promise.resolve();
  await Promise.all(["src", "tests"].map((directory) => openProjectWorkspaceDraft({
    ...project, draftId: `fork-${directory}`, sourceDirectory: "/repo/worktrees/feature",
    setup: {
      provider: "claude", cwd: `/repo/worktrees/feature/${directory}`,
      modeId: null, model: null, thinkingOptionId: null, featureValues: {},
    },
  })));
  expect(drafts().map((target) => target.setup?.cwd)).toEqual(["/repo/src", "/repo/tests"]);
  expect(new Set(drafts().map((target) => target.workspaceId)).size).toBe(2);
  creation.resolve({ workspace: { ...rootWorkspace, id: "ordinary-workspace" }, error: null });
  await pending;
  expect(drafts()).toHaveLength(3);
});

it("keeps different custom setups independent without explicit draft IDs", async () => {
  await Promise.all(["src", "tests"].map((directory) => openProjectWorkspaceDraft({
    ...project,
    setup: {
      provider: "claude", cwd: `/repo/${directory}`,
      modeId: null, model: null, thinkingOptionId: null, featureValues: {},
    },
  })));
  expect(workspaces().size).toBe(2);
  expect(drafts().map((target) => target.workspaceId)).toEqual([...workspaces().keys()]);
});

it("leaves the current conversation intact when creation returns an error payload, then allows retry", async () => {
  useSessionStore.getState().mergeWorkspaces("host", [rootWorkspace]);
  state.createWorkspace.mockResolvedValueOnce({ workspace: null, error: "Host disconnected" });
  await expect(openProjectWorkspaceDraft(project)).rejects.toThrow("Host disconnected");
  expect([...workspaces().keys()]).toEqual([rootWorkspace.id]);
  expect(drafts()).toEqual([]);
  await openProjectWorkspaceDraft(project);
  expect(workspaces().size).toBe(2);
  expect(drafts()).toHaveLength(1);
});

it("conditionally removes an unused workspace if route navigation throws after opening its tab", async () => {
  const error = new Error("Navigation failed");
  state.navigateToRoute.mockImplementationOnce(() => { throw error; });
  await expect(openProjectWorkspaceDraft(project)).rejects.toBe(error);
  expect(workspaces().size).toBe(0);
  expect(drafts()).toEqual([]);
  await openProjectWorkspaceDraft(project);
  expect(drafts()).toHaveLength(1);
});

it("preserves the navigation error and a recoverable record when conditional cleanup fails", async () => {
  const error = new Error("Navigation failed");
  state.navigateToRoute.mockImplementationOnce(() => { throw error; });
  state.archiveWorkspace.mockRejectedValueOnce(new Error("Host disconnected"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(openProjectWorkspaceDraft(project)).rejects.toBe(error);
  expect(workspaces().has("new-workspace-1")).toBe(true);
  expect(drafts()).toHaveLength(1);
});
