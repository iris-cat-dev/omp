import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildProjectLayoutKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { closeWorkspaceDraftTab, resolveClosedTabWorkspaceArchives } from "@/workspace-tabs/close-cleanup";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import {
  archiveEmptyWorkspace,
  archiveWorkspaceOptimistically,
  archiveWorkspacesOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";
import { recoverWorkspaceSelection } from "@/workspace-recovery/model";
import { WorkspaceDirectoryReplica } from "@/runtime/directory-sync/workspace-replica";
import { ensureProjectLayoutsMigrated } from "@/workspace-tabs/project-scope";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const SERVER_ID = "workspace-archive-test";
const SECOND_SERVER_ID = "workspace-archive-test-2";

type ArchiveWorkspacePayload = Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>;

function archivePayload(input: {
  workspaceId: string;
  error?: string | null;
}): ArchiveWorkspacePayload {
  return {
    requestId: "request",
    workspaceId: input.workspaceId,
    archivedAt: input.error ? null : "2026-09-23T00:00:00.000Z",
    error: input.error ?? null,
  };
}

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project/workspace-1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace-1",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

function target(input?: Partial<WorkspaceArchiveTarget>): WorkspaceArchiveTarget {
  const base = workspace();
  return {
    serverId: SERVER_ID,
    workspaceId: base.id,
    ...input,
  };
}

function createClient(
  archiveWorkspace: DaemonClient["archiveWorkspace"],
): Pick<DaemonClient, "archiveWorkspace" | "restoreWorkspace"> {
  return { archiveWorkspace, restoreWorkspace: async () => { throw new Error("Unexpected workspace restore"); } };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function storedWorkspaceOn(serverId: string, id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[serverId]?.workspaces.get(id);
}

function storedWorkspace(id: string): WorkspaceDescriptor | undefined {
  return storedWorkspaceOn(SERVER_ID, id);
}

beforeEach(() => {
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
});

afterEach(() => {
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-2" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-2" });
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceOptimistically", () => {
  it("hides the workspace and marks the archive pending while the daemon call runs", async () => {
    const archived = workspace();
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [archived]);
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(vi.fn(async () => releaseArchive.promise));

    const archive = archiveWorkspaceOptimistically({
      client,
      workspace: target(),
    });

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(true);

    releaseArchive.resolve(archivePayload({ workspaceId: archived.id }));
    await archive;

    expect(storedWorkspace(archived.id)).toBeUndefined();
  });

  it("restores the workspace and clears pending state when the daemon rejects the archive", async () => {
    const archived = workspace();
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [archived]);
    const client = createClient(
      vi.fn(async () => archivePayload({ workspaceId: archived.id, error: "nope" })),
    );

    await expect(
      archiveWorkspaceOptimistically({
        client,
        workspace: target(),
      }),
    ).rejects.toThrow("nope");

    expect(storedWorkspace(archived.id)).toEqual(archived);
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(false);
  });
});

describe("archiveEmptyWorkspace", () => {
  beforeEach(() => {
    useCreateFlowStore.getState().clearAll();
    useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
    useDraftStore.setState(useDraftStore.getInitialState(), true);
    useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
    useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {} });
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: "test",
      version: "test",
      features: { workspaceArchiveIfEmpty: true },
    });
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [workspace()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useCreateFlowStore.getState().clearAll();
  });

  it("removes the empty workspace only after the server conditionally archives it", async () => {
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(async (_workspaceId, options) => {
      if (options?.onlyIfEmpty !== true) {
        throw new Error("An automatic archive must be conditional");
      }
      return releaseArchive.promise;
    });
    const archive = archiveEmptyWorkspace({
      client,
      workspace: target(),
      hasPendingTerminalCreate: false,
    });

    expect(storedWorkspace("workspace-1")).toBeDefined();
    releaseArchive.resolve(archivePayload({ workspaceId: "workspace-1" }));
    await archive;
    expect(storedWorkspace("workspace-1")).toBeUndefined();
    expect(isWorkspaceArchivePending(target())).toBe(true);
  });

  it.each(["untouched", "text", "attachment", "submission", "creation"])("restores a workspace claimed by a new draft while conditional archive is pending (%s)", async (content) => {
    const descriptor = workspace({ workspaceKind: "local_checkout" });
    vi.spyOn(useWorkspaceLayoutStore.persist, "hasHydrated").mockReturnValue(true);
    useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [descriptor]);
    const workspaceKey = buildProjectLayoutKey({ serverId: SERVER_ID, projectId: descriptor.projectId })!;
    const layout = useWorkspaceLayoutStore.getState();
    layout.openTab({ workspaceKey, target: { kind: "files", workspaceId: descriptor.id }, intent: "new" });
    const response = deferred<ArchiveWorkspacePayload>();
    const restoration = deferred<void>();
    let restoring = false;
    let remotelyArchived = false;
    const client = {
      archiveWorkspace: async () => response.promise,
      restoreWorkspace: async () => {
        restoring = true;
        await restoration.promise;
        remotelyArchived = false;
      },
    };
    const archive = archiveEmptyWorkspace({
      client, workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true,
    });
    layout.openTab({ workspaceKey, target: { kind: "draft", draftId: "late", workspaceId: descriptor.id }, intent: "new" });
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "", draftId: "late" });
    if (content === "text") {
      useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "Keep the new conversation", attachments: [] } });
    } else if (content === "attachment") {
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey("late"), attachments: [{ kind: "forge.change_request_comment", id: "keep", title: "Keep", text: "Keep context" }],
      });
    } else if (content === "submission") {
      useWorkspaceDraftSubmissionStore.getState().setPending({
        serverId: SERVER_ID, workspaceId: descriptor.id, draftId: "late", text: "Keep queued",
        attachments: [], cwd: "/repo", provider: "claude", clientMessageId: "queued", timestamp: 1,
      });
    } else if (content === "creation") {
      useCreateFlowStore.getState().setPending({
        serverId: SERVER_ID, workspaceId: descriptor.id, draftId: "late", agentId: null,
        clientMessageId: "creating", text: "Keep creating", timestamp: 1,
      });
    }
    const draftInput = useDraftStore.getState().getDraftInput(draftKey);
    const attachments = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
    const queued = useWorkspaceDraftSubmissionStore.getState().pendingByDraftId;
    const creates = useCreateFlowStore.getState().pendingByDraftId;
    const tabs = layout.getWorkspaceTabs(workspaceKey);
    remotelyArchived = true;
    new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({ kind: "remove", id: descriptor.id });
    response.resolve(archivePayload({ workspaceId: descriptor.id }));
    await vi.waitFor(() => expect(restoring).toBe(true));
    expect(layout.getWorkspaceTabs(workspaceKey)).toEqual(tabs);
    restoration.resolve();
    expect(await archive).toBe(false);
    expect(remotelyArchived).toBe(false);
    ensureProjectLayoutsMigrated(SERVER_ID);
    expect(layout.getWorkspaceTabs(workspaceKey)).toEqual(tabs);
    new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({
      kind: "upsert", workspace: {
        ...descriptor, title: descriptor.title ?? null, activityAt: null,
        statusEnteredAt: null, archivingAt: null,
      },
    });
    expect(storedWorkspace(descriptor.id)).toBeDefined();
    expect(layout.getWorkspaceTabs(workspaceKey)).toEqual(tabs);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual(draftInput);
    expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope).toEqual(attachments);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual(queued);
    expect(useCreateFlowStore.getState().pendingByDraftId).toEqual(creates);
  });

  it("preserves late input when restoration fails and the recovery action can retry", async () => {
    const descriptor = workspace({ workspaceKind: "local_checkout" });
    vi.spyOn(useWorkspaceLayoutStore.persist, "hasHydrated").mockReturnValue(true);
    useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [descriptor]);
    const workspaceKey = buildProjectLayoutKey({ serverId: SERVER_ID, projectId: descriptor.projectId })!;
    const layout = useWorkspaceLayoutStore.getState();
    layout.openTab({ workspaceKey, target: { kind: "draft", draftId: "late-input", workspaceId: descriptor.id }, intent: "new" });
    const response = deferred<ArchiveWorkspacePayload>();
    const failure = new Error("Recovery disconnected");
    let remotelyArchived = false;
    let attempts = 0;
    const client = {
      archiveWorkspace: async () => response.promise,
      restoreWorkspace: async () => {
        if (++attempts === 1) throw failure;
        remotelyArchived = false;
        new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({
          kind: "upsert", workspace: {
            ...descriptor, title: descriptor.title ?? null, activityAt: null,
            statusEnteredAt: null, archivingAt: null,
          },
        });
      },
      refreshAgent: async () => { throw new Error("Workspace recovery must not refresh an agent"); },
    };
    const archive = archiveEmptyWorkspace({
      client, workspace: target(), closedDraftId: "late-input", hasPendingTerminalCreate: false, preserveDrafts: true,
    });
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "", draftId: "late-input" });
    useDraftStore.getState().saveDraftInput({ draftKey, draft: { text: "Entered during cleanup", attachments: [] } });
    const tabs = layout.getWorkspaceTabs(workspaceKey);
    remotelyArchived = true;
    new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({ kind: "remove", id: descriptor.id });
    response.resolve(archivePayload({ workspaceId: descriptor.id }));
    await expect(archive).rejects.toBe(failure);
    expect(layout.getWorkspaceTabs(workspaceKey)).toEqual(tabs);
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("Entered during cleanup");
    await recoverWorkspaceSelection({ client, workspaceId: descriptor.id });
    expect(remotelyArchived).toBe(false);
    expect(storedWorkspace(descriptor.id)).toBeDefined();
    expect(layout.getWorkspaceTabs(workspaceKey)).toEqual(tabs);
  });

  it("retires a workspace's drafts and companion tools after archive confirmation, keeping sibling tabs", async () => {
    useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
    const workspaceKey = buildProjectLayoutKey({
      serverId: SERVER_ID,
      projectId: workspace().projectId,
    })!;
    useSessionStore
      .getState()
      .mergeWorkspaces(SERVER_ID, [
        workspace(),
        workspace({ id: "workspace-2", workspaceDirectory: "/repo/project/workspace-2" }),
      ]);
    const layouts = useWorkspaceLayoutStore.getState();
    const removedTargets = [
      { kind: "draft", draftId: "stale-draft", workspaceId: "workspace-1" },
      { kind: "files", workspaceId: "workspace-1" },
      { kind: "working_diff", workspaceId: "workspace-1" },
      { kind: "pull_request", workspaceId: "workspace-1" },
    ] satisfies WorkspaceTabTarget[];
    const keptTargets = [
      { kind: "draft", draftId: "kept-draft", workspaceId: "workspace-2" },
      { kind: "files", workspaceId: "workspace-2" },
      { kind: "working_diff", workspaceId: "workspace-2" },
      { kind: "pull_request", workspaceId: "workspace-2" },
      { kind: "file", path: "src/unsaved.ts", workspaceId: "workspace-2" },
      { kind: "working_diff", focusPath: "src/app.ts", workspaceId: "workspace-2" },
    ] satisfies WorkspaceTabTarget[];
    for (const tabTarget of [...removedTargets, ...keptTargets]) {
      layouts.openTab({ workspaceKey, target: tabTarget, intent: "new" });
    }
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(async () => releaseArchive.promise);

    const archive = archiveEmptyWorkspace({
      client,
      workspace: target(),
      hasPendingTerminalCreate: false,
    });

    const pendingTargets = useWorkspaceLayoutStore
      .getState()
      .getWorkspaceTabs(workspaceKey)
      .filter((tab) => tab.target.kind !== "new_tab")
      .map((tab) => tab.target);
    expect(pendingTargets).toEqual(expect.arrayContaining([...removedTargets, ...keptTargets]));
    expect(storedWorkspace("workspace-1")).toBeDefined();
    releaseArchive.resolve(archivePayload({ workspaceId: "workspace-1" }));
    await archive;

    expect(
      useWorkspaceLayoutStore
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind !== "new_tab")
        .map((tab) => tab.target),
    ).toEqual(pendingTargets.filter((tabTarget) => tabTarget.workspaceId === "workspace-2"));
    expect(storedWorkspace("workspace-1")).toBeUndefined();
    expect(storedWorkspace("workspace-2")).toBeDefined();
  });

  it("preserves another draft's unsent text and attachments during unused-workspace cleanup", async () => {
    const workspaceKey = buildProjectLayoutKey({
      serverId: SERVER_ID,
      projectId: workspace().projectId,
    })!;
    const draftId = "leave-draft";
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "", draftId });
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "draft", draftId, workspaceId: "workspace-1" },
      intent: "reveal",
    });
    const client = createClient(async () => archivePayload({ workspaceId: "workspace-1" }));
    const leave = () =>
      archiveEmptyWorkspace({
        client,
        workspace: target(),
        hasPendingTerminalCreate: false,
        preserveDrafts: true,
      });
    try {
      useDraftStore.getState().saveDraftInput({
        draftKey,
        draft: { text: "Do not lose this", attachments: [] },
      });
      await leave();
      expect(storedWorkspace("workspace-1")).toBeDefined();
      useDraftStore.getState().saveDraftInput({
        draftKey,
        draft: { text: "", attachments: [{ kind: "directory", path: "/repo/context" }] },
      });
      await leave();
      expect(storedWorkspace("workspace-1")).toBeDefined();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
      const closingTab = useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)
        .find((tab) => tab.target.kind === "draft" && tab.target.draftId === draftId)!;
      closeWorkspaceDraftTab({ serverId: SERVER_ID, workspaceKey, tabId: closingTab.tabId });
      await leave();
      expect(storedWorkspace("workspace-1")).toBeUndefined();
    } finally {
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
    }
  });

  it.each(["untouched", "text", "attachment", "scopeAttachment", "submission"])(
    "closing one draft preserves its owner's other %s draft and only discards the selected input",
    async (content) => {
      const workspaceKey = buildProjectLayoutKey({ serverId: SERVER_ID, projectId: workspace().projectId })!;
      const store = useWorkspaceLayoutStore.getState();
      for (const draftId of ["closing", "sibling"]) {
        store.openTab({ workspaceKey, target: { kind: "draft", draftId, workspaceId: "workspace-1" }, intent: "new" });
      }
      const closingTab = store.getWorkspaceTabs(workspaceKey).find(
        (tab) => tab.target.kind === "draft" && tab.target.draftId === "closing",
      )!;
      const closingKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: closingTab.tabId, draftId: "closing" });
      const siblingKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "", draftId: "sibling" });
      useDraftStore.getState().saveDraftInput({ draftKey: closingKey, draft: { text: "Discard only me", attachments: [] } });
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey("closing"), attachments: [{ kind: "forge.change_request_comment", id: "discard", title: "Discard", text: "Discard context" }],
      });
      useWorkspaceDraftSubmissionStore.getState().setPending({
        serverId: SERVER_ID, workspaceId: "workspace-1", draftId: "closing", text: "Discard queued message",
        attachments: [], cwd: "/repo", provider: "claude", clientMessageId: "closing-queued", timestamp: 1,
      });
      if (content === "text" || content === "attachment") {
        useDraftStore.getState().saveDraftInput({ draftKey: siblingKey, draft: {
          text: content === "text" ? "Keep this input" : "",
          attachments: content === "attachment" ? [{ kind: "directory", path: "/keep" }] : [],
        } });
      }
      if (content === "scopeAttachment") {
        useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
          scopeKey: buildDraftWorkspaceAttachmentScopeKey("sibling"),
          attachments: [{ kind: "forge.change_request_comment", id: "keep", title: "Keep", text: "Keep context" }],
        });
      }
      if (content === "submission") {
        useWorkspaceDraftSubmissionStore.getState().setPending({
          serverId: SERVER_ID, workspaceId: "workspace-1", draftId: "sibling", text: "Keep queued message",
          attachments: [], cwd: "/repo", provider: "claude", clientMessageId: "queued", timestamp: 1,
        });
      }
      const siblingInput = useDraftStore.getState().getDraftInput(siblingKey);
      const closeResult = closeWorkspaceDraftTab({ serverId: SERVER_ID, workspaceKey, tabId: closingTab.tabId });
      for (const workspaceId of resolveClosedTabWorkspaceArchives({
        routeWorkspaceId: "other-tab-host", closingTarget: closingTab.target,
        routeWorkspaceEmpty: closeResult === "workspace-empty",
      })) {
        const archived = await archiveEmptyWorkspace({
          client: createClient(async () => { throw new Error("A sibling draft must prevent the request"); }),
          workspace: { serverId: SERVER_ID, workspaceId }, closedDraftId: "closing",
          hasPendingTerminalCreate: false, preserveDrafts: true,
        });
        expect(archived).toBe(false);
      }
      expect(storedWorkspace("workspace-1")).toBeDefined();
      expect(store.getWorkspaceTabs(workspaceKey).flatMap((tab) => tab.target.kind === "draft" ? [tab.target.draftId] : [])).toEqual(["sibling"]);
      expect(useDraftStore.getState().getDraftInput(siblingKey)).toEqual(siblingInput);
      expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[buildDraftWorkspaceAttachmentScopeKey("closing")]).toBeUndefined();
      expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId.closing).toBeUndefined();
      if (content === "scopeAttachment") {
        expect(useWorkspaceAttachmentsStore.getState().attachmentsByScope[buildDraftWorkspaceAttachmentScopeKey("sibling")]).toEqual([
          { kind: "forge.change_request_comment", id: "keep", title: "Keep", text: "Keep context" },
        ]);
      }
      if (content === "submission") {
        expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId.sibling?.text).toBe("Keep queued message");
      }
    },
  );

  it("keeps workspace-scoped attachments and queued submissions even without a layout", async () => {
    const scopeKey = buildWorkspaceAttachmentScopeKey({ serverId: SERVER_ID, workspaceId: "workspace-1", cwd: "/repo" });
    const client = createClient(async () => { throw new Error("Unsent content must prevent archive"); });
    useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({ scopeKey, attachments: [{ kind: "forge.change_request_comment", id: "context", title: "Context", text: "Keep context" }] });
    expect(await archiveEmptyWorkspace({ client, workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true })).toBe(false);
    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({ scopeKey });
    useWorkspaceDraftSubmissionStore.getState().setPending({
      serverId: SERVER_ID, workspaceId: "workspace-1", draftId: "detached", text: "Queued",
      attachments: [], cwd: "/repo", provider: "claude", clientMessageId: "queued", timestamp: 1,
    });
    expect(await archiveEmptyWorkspace({ client, workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true })).toBe(false);
    expect(storedWorkspace("workspace-1")).toBeDefined();
  });

  it("closing the final draft keeps its outstanding agent creation protected", async () => {
    const workspaceKey = buildProjectLayoutKey({ serverId: SERVER_ID, projectId: workspace().projectId })!;
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({ workspaceKey, target: { kind: "draft", draftId: "creating", workspaceId: "workspace-1" }, intent: "new" });
    const tab = store.getWorkspaceTabs(workspaceKey).find((entry) => entry.target.kind === "draft")!;
    useCreateFlowStore.getState().setPending({
      serverId: SERVER_ID, workspaceId: "workspace-1", draftId: "creating", agentId: null,
      clientMessageId: "pending", text: "Still creating", timestamp: 1,
    });
    closeWorkspaceDraftTab({ serverId: SERVER_ID, workspaceKey, tabId: tab.tabId });
    expect(await archiveEmptyWorkspace({
      client: createClient(async () => { throw new Error("The create may still complete"); }),
      workspace: target(), closedDraftId: "creating", hasPendingTerminalCreate: false, preserveDrafts: true,
    })).toBe(false);
    expect(useCreateFlowStore.getState().pendingByDraftId.creating).toBeDefined();
    expect(storedWorkspace("workspace-1")).toBeDefined();
  });

  it("does not let another host's same workspace ID block cleanup or lose its drafts", async () => {
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
    useSessionStore.getState().mergeWorkspaces(SECOND_SERVER_ID, [workspace()]);
    const workspaceKey = buildProjectLayoutKey({ serverId: SECOND_SERVER_ID, projectId: workspace().projectId })!;
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey, target: { kind: "draft", draftId: "other-host", workspaceId: "workspace-1" }, intent: "new",
    });
    useWorkspaceDraftSubmissionStore.getState().setPending({
      serverId: SECOND_SERVER_ID, workspaceId: "workspace-1", draftId: "other-host", text: "Keep queued",
      attachments: [], cwd: "/repo", provider: "claude", clientMessageId: "other-queued", timestamp: 1,
    });
    expect(await archiveEmptyWorkspace({
      client: createClient(async () => archivePayload({ workspaceId: "workspace-1" })),
      workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true,
    })).toBe(true);
    expect(storedWorkspace("workspace-1")).toBeUndefined();
    expect(storedWorkspaceOn(SECOND_SERVER_ID, "workspace-1")).toBeDefined();
    expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey).some(
      (tab) => tab.target.kind === "draft" && tab.target.draftId === "other-host",
    )).toBe(true);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId["other-host"]).toBeDefined();
  });

  it("leaves a disconnected workspace available for a later conditional cleanup", async () => {
    await expect(archiveEmptyWorkspace({
      client: null, workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true,
    })).rejects.toThrow();
    expect(storedWorkspace("workspace-1")).toBeDefined();
    expect(isWorkspaceArchivePending(target())).toBe(false);
    expect(await archiveEmptyWorkspace({
      client: createClient(async () => archivePayload({ workspaceId: "workspace-1" })),
      workspace: target(), hasPendingTerminalCreate: false, preserveDrafts: true,
    })).toBe(true);
    expect(storedWorkspace("workspace-1")).toBeUndefined();
  });

  it("retains a workspace when the server finds history or other protected resources", async () => {
    useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
    const workspaceKey = buildProjectLayoutKey({
      serverId: SERVER_ID,
      projectId: workspace().projectId,
    })!;
    const layouts = useWorkspaceLayoutStore.getState();
    layouts.openTab({
      workspaceKey,
      target: { kind: "files", workspaceId: "workspace-1" },
      intent: "new",
    });
    layouts.openTab({
      workspaceKey,
      target: { kind: "working_diff", workspaceId: "workspace-1" },
      intent: "new",
    });
    const tabs = layouts.getWorkspaceTabs(workspaceKey);
    await archiveEmptyWorkspace({
      client: createClient(async () => ({
        ...archivePayload({ workspaceId: "workspace-1" }),
        archivedAt: null,
        skipped: true,
      })),
      workspace: target(),
      hasPendingTerminalCreate: false,
    });
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
    expect(isWorkspaceArchivePending(target())).toBe(false);
    expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).toEqual(tabs);
  });

  it("does not treat a response without archive confirmation as success", async () => {
    await expect(
      archiveEmptyWorkspace({
        client: createClient(async () => ({
          ...archivePayload({ workspaceId: "workspace-1" }),
          archivedAt: null,
        })),
        workspace: target(),
        hasPendingTerminalCreate: false,
      }),
    ).rejects.toThrow();
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
    expect(isWorkspaceArchivePending(target())).toBe(false);
  });

  it.each(["response", "transport"])(
    "keeps a failed %s archive visible and allows retrying",
    async (failure) => {
      const client = createClient(async () => {
        if (failure === "transport") {
          throw new Error("offline");
        }
        return archivePayload({ workspaceId: "workspace-1", error: "offline" });
      });
      await expect(
        archiveEmptyWorkspace({ client, workspace: target(), hasPendingTerminalCreate: false }),
      ).rejects.toThrow("offline");
      expect(storedWorkspace("workspace-1")).toEqual(workspace());
      expect(isWorkspaceArchivePending(target())).toBe(false);

      await archiveEmptyWorkspace({
        client: createClient(async () => archivePayload({ workspaceId: "workspace-1" })),
        workspace: target(),
        hasPendingTerminalCreate: false,
      });
      expect(storedWorkspace("workspace-1")).toBeUndefined();
    },
  );

  it("never sends a conditional request to a legacy host that could archive unconditionally", async () => {
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: "legacy",
      version: "legacy",
    });
    const archiveWorkspace = vi.fn(async () => archivePayload({ workspaceId: "workspace-1" }));
    await expect(
      archiveEmptyWorkspace({
        client: createClient(archiveWorkspace),
        workspace: target(),
        hasPendingTerminalCreate: false,
      }),
    ).rejects.toThrow();
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
  });

  it("protects an in-flight create even after its draft tab is closed and abandoned", async () => {
    useCreateFlowStore.getState().setPending({
      draftId: "closing-draft",
      serverId: SERVER_ID,
      agentId: null,
      clientMessageId: "message-1",
      text: "Start working",
      timestamp: 1,
    });
    useCreateFlowStore.getState().markLifecycle({
      draftId: "closing-draft",
      lifecycle: "abandoned",
    });
    const archiveWorkspace = vi.fn(async () => archivePayload({ workspaceId: "workspace-1" }));
    await archiveEmptyWorkspace({
      client: createClient(archiveWorkspace),
      workspace: target(),
      closedDraftId: "closing-draft",
      hasPendingTerminalCreate: false,
    });
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
  });

  it("protects pending creation from another draft in the same workspace", async () => {
    useCreateFlowStore.getState().setPending({
      draftId: "other-draft",
      workspaceId: "workspace-1",
      serverId: SERVER_ID,
      agentId: null,
      clientMessageId: "message-1",
      text: "Start working",
      timestamp: 1,
    });
    const archiveWorkspace = vi.fn(async () => archivePayload({ workspaceId: "workspace-1" }));
    await archiveEmptyWorkspace({
      client: createClient(archiveWorkspace),
      workspace: target(),
      closedDraftId: "closing-draft",
      hasPendingTerminalCreate: false,
    });
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
  });

  it("does not archive while a terminal is being created", async () => {
    const archiveWorkspace = vi.fn(async () => archivePayload({ workspaceId: "workspace-1" }));
    await archiveEmptyWorkspace({
      client: createClient(archiveWorkspace),
      workspace: target(),
      hasPendingTerminalCreate: true,
    });
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(storedWorkspace("workspace-1")).toEqual(workspace());
  });
});

describe("archiveWorkspacesOptimistically", () => {
  it("returns failures and restores only the workspaces whose archive failed", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [first, second]);
    const client = createClient(
      vi.fn(async (workspaceId) =>
        archivePayload({
          workspaceId,
          error: workspaceId === second.id ? "failed" : null,
        }),
      ),
    );

    const failures = await archiveWorkspacesOptimistically({
      getClient: () => client,
      workspaces: [target({ workspaceId: first.id }), target({ workspaceId: second.id })],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.workspaceId).toBe(second.id);
    expect(storedWorkspace(first.id)).toBeUndefined();
    expect(storedWorkspace(second.id)).toEqual(second);
  });

  it("archives each workspace through its own server client", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [first]);
    useSessionStore.getState().mergeWorkspaces(SECOND_SERVER_ID, [second]);

    const archivedByServer = new Map<string, string[]>();
    const clientFor = (serverId: string) =>
      createClient(async (workspaceId) => {
        archivedByServer.set(serverId, [...(archivedByServer.get(serverId) ?? []), workspaceId]);
        return archivePayload({ workspaceId });
      });

    const failures = await archiveWorkspacesOptimistically({
      getClient: (serverId) => clientFor(serverId),
      workspaces: [
        target({
          serverId: SERVER_ID,
          workspaceId: first.id,
        }),
        target({
          serverId: SECOND_SERVER_ID,
          workspaceId: second.id,
        }),
      ],
    });

    expect(failures).toEqual([]);
    expect(archivedByServer).toEqual(
      new Map([
        [SERVER_ID, [first.id]],
        [SECOND_SERVER_ID, [second.id]],
      ]),
    );
    expect(storedWorkspaceOn(SERVER_ID, first.id)).toBeUndefined();
    expect(storedWorkspaceOn(SECOND_SERVER_ID, second.id)).toBeUndefined();
  });
});
