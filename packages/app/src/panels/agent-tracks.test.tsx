// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { BackgroundProcess } from "@omp-desktop/protocol/background-processes";
import type * as LayoutModule from "@/constants/layout";
import { AgentTracks } from "@/panels/agent-tracks";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import {
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { SubagentRow } from "@/subagents";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const layoutMode = vi.hoisted(() => ({ isCompact: false }));

function createBackgroundProcessState(processes: BackgroundProcess[]) {
  return {
    processes,
    error: null,
    stopError: null,
    isConnected: true,
    isLoading: false,
    stoppingProcessIds: new Set<string>(),
    stopProcess: vi.fn(async () => {}),
  };
}

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

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof LayoutModule>()),
  supportsDesktopPaneSplits: () => true,
  useIsCompactFormFactor: () => layoutMode.isCompact,
}));

vi.mock("@/composer/branch-pill", () => ({ WorkspaceBranchPill: () => null }));
vi.mock("@/composer/workspace-branch", () => ({ useWorkspaceHasBranch: () => false }));
vi.mock("@/composer/diff-stat-pill", () => ({
  WorkspaceDiffStatPill: ({ onPress }: { onPress: () => void }) =>
    React.createElement("button", { type: "button", onClick: onPress }, "打开更改"),
}));
vi.mock("@/composer/workspace-diff-stat", () => ({ useWorkspaceHasDiffStat: () => false }));
vi.mock("@/composer/tracks", () => ({
  ComposerTrackBar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/background-processes/track", () => ({
  hasVisibleBackgroundProcessState: (state: {
    processes: BackgroundProcess[];
    error: string | null;
  }) =>
    state.error !== null ||
    state.processes.some((process) =>
      ["starting", "running", "ready", "restarting", "stopping"].includes(process.status),
    ),
  BackgroundProcessesTrack: ({
    state,
    onOpen,
  }: {
    state: { processes: BackgroundProcess[] };
    onOpen: (process: BackgroundProcess) => void;
  }) =>
    state.processes.map((process) =>
      React.createElement(
        "button",
        { key: process.id, type: "button", onClick: () => onOpen(process) },
        process.name,
      ),
    ),
}));
vi.mock("@/subagents", () => ({
  useArchiveSubagent: () => vi.fn(),
  useDetachSubagent: () => vi.fn(),
}));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));
vi.mock("@/subagents/track", () => ({
  SubagentsTrack: ({
    rows,
    onOpenSubagent,
    onOpenProviderSubagent,
  }: {
    rows: SubagentRow[];
    onOpenSubagent: (subagentId: string) => void;
    onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  }) =>
    rows.map((row) =>
      React.createElement(
        "button",
        {
          key: row.id,
          type: "button",
          onClick: () => {
            if (row.kind === "provider") {
              onOpenProviderSubagent(row.parentAgentId, row.id);
            } else {
              onOpenSubagent(row.id);
            }
          },
        },
        row.kind === "provider" ? "打开 provider 子代理" : "打开 Paseo 子会话",
      ),
    ),
}));

const SERVER_ID = "agent-tracks-server";
const HOST_WORKSPACE_ID = "workspace-a";
const OTHER_WORKSPACE_ID = "workspace-b";
const PARENT_AGENT_ID = "parent-agent";
const SUBAGENT_ID = "provider-child";
const IDLE_ARCHIVE_STATUS = { kind: "idle" } as const;
const providerRow: SubagentRow = {
  kind: "provider",
  id: SUBAGENT_ID,
  parentAgentId: PARENT_AGENT_ID,
  provider: "codex",
  title: "Explore",
  description: "检查工作区路由",
  model: null,
  subtitle: null,
  status: "running",
  requiresAttention: false,
  createdAt: new Date("2026-09-06T10:00:00.000Z"),
};

function makeAgent(id: string, workspaceId: string, parentAgentId: string | null = null): Agent {
  return {
    serverId: SERVER_ID,
    id,
    provider: "codex",
    status: "idle",
    activeTurn: null,
    createdAt: providerRow.createdAt,
    updatedAt: providerRow.createdAt,
    lastUserMessageAt: null,
    lastActivityAt: providerRow.createdAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    lastUsage: undefined,
    lastError: null,
    title: id,
    cwd: "/repo",
    workspaceId,
    model: null,
    features: undefined,
    thinkingOptionId: undefined,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId,
    labels: {},
    projectPlacement: null,
  };
}

function seedPaseoChild(workspaceId: string): SubagentRow {
  const parent = makeAgent(PARENT_AGENT_ID, OTHER_WORKSPACE_ID);
  const child = makeAgent("paseo-child", workspaceId, parent.id);
  const session = useSessionStore.getState();
  session.initializeSession(SERVER_ID, null as unknown as DaemonClient);
  session.setAgents(SERVER_ID, new Map([parent, child].map((agent) => [agent.id, agent])));
  return {
    kind: "paseo",
    id: child.id,
    provider: child.provider,
    title: child.title,
    model: child.model,
    description: null,
    subtitle: null,
    status: child.status,
    requiresAttention: child.requiresAttention,
    createdAt: child.createdAt,
  };
}

interface TracksFixture {
  hostWorkspaceKey: string;
  otherWorkspaceKey: string;
  parentTarget: WorkspaceTabTarget;
  parentTabId: string;
  hostTabsBefore: WorkspaceTab[];
  layoutsBefore: Record<string, WorkspaceLayout>;
}

function createHostPaneContext(
  hostWorkspaceKey: string,
  parentTarget: WorkspaceTabTarget,
  parentTabId: string,
): PaneContextValue {
  const paneContext: PaneContextValue = {
    serverId: SERVER_ID,
    workspaceId: HOST_WORKSPACE_ID,
    isSidePanel: false,
    tabId: parentTabId,
    target: parentTarget,
    // 与 workspace-screen 的 revealWorkspaceChildTab 闭包保持同一真实 store 契约。
    openTab: (target) => {
      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey: hostWorkspaceKey,
        target,
        intent: "reveal",
        parentTabId,
        placement: { mode: "pane", paneId: "main" },
      });
    },
    closeCurrentTab: vi.fn(),
    retargetCurrentTab: vi.fn(),
    setCurrentTabState: vi.fn(),
    openFileInWorkspace: vi.fn(),
    openImportSheet: vi.fn(),
  };
  return paneContext;
}

function renderAgentTracks(
  agentWorkspaceId: string,
  row: SubagentRow,
  processes: BackgroundProcess[] = [],
): TracksFixture {
  const hostWorkspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: HOST_WORKSPACE_ID,
  })!;
  const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: OTHER_WORKSPACE_ID,
  })!;
  const store = useWorkspaceLayoutStore.getState();
  const parentTarget: WorkspaceTabTarget = { kind: "agent", agentId: PARENT_AGENT_ID };
  const parentTabId = store.openTab({
    workspaceKey: hostWorkspaceKey,
    target: parentTarget,
    intent: "new",
  })!;
  store.openTab({
    workspaceKey: otherWorkspaceKey,
    target: { kind: "agent", agentId: "unrelated-agent" },
    intent: "new",
  });
  const hostTabsBefore = store.getWorkspaceTabs(hostWorkspaceKey);
  const layoutsBefore = useWorkspaceLayoutStore.getState().layoutByWorkspace;
  const paneContext = createHostPaneContext(hostWorkspaceKey, parentTarget, parentTabId);
  const backgroundProcesses = createBackgroundProcessState(processes);

  render(
    <PaneProvider value={paneContext}>
      <AgentTracks
        serverId={SERVER_ID}
        workspaceId={agentWorkspaceId}
        agentId={PARENT_AGENT_ID}
        backgroundProcesses={backgroundProcesses}
        cwd="/repo"
        subagentRows={[row]}
        archiveFinishedStatus={IDLE_ARCHIVE_STATUS}
        onArchiveFinished={vi.fn()}
      />
    </PaneProvider>,
  );

  return {
    hostWorkspaceKey,
    otherWorkspaceKey,
    parentTarget,
    parentTabId,
    hostTabsBefore,
    layoutsBefore,
  };
}

function expectChildInHost(fixture: TracksFixture, target: WorkspaceTabTarget): void {
  const state = useWorkspaceLayoutStore.getState();
  const hostTabs = state.getWorkspaceTabs(fixture.hostWorkspaceKey);
  expect(hostTabs).toHaveLength(fixture.hostTabsBefore.length + 1);
  const childTabs = hostTabs.filter(
    (tab) => !fixture.hostTabsBefore.some((existing) => existing.tabId === tab.tabId),
  );
  expect(childTabs).toHaveLength(1);
  const childTab = childTabs[0]!;
  expect(childTab.target).toEqual(target);
  const hostLayout = state.layoutByWorkspace[fixture.hostWorkspaceKey];
  const childPane = findPaneContainingTab(hostLayout.root, childTab.tabId);
  expect(childPane?.id).toBe("main");
  expect(childPane?.focusedTabId).toBe(childTab.tabId);
  expect(hostLayout.focusedPaneId).toBe("main");
  expect(hostLayout.parentTabIdByTabId?.[childTab.tabId]).toBe(fixture.parentTabId);
  expect(hostTabs.find((tab) => tab.tabId === fixture.parentTabId)?.target).toEqual(
    fixture.parentTarget,
  );
  expect(state.layoutByWorkspace[fixture.otherWorkspaceKey]).toBe(
    fixture.layoutsBefore[fixture.otherWorkspaceKey],
  );
  expect(navigateToAgent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  layoutMode.isCompact = false;
  useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(SERVER_ID);
  useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("AgentTracks pill order", () => {
  it("places the terminal indicator immediately after the subagent indicator", () => {
    const process: BackgroundProcess = {
      id: "terminal-build",
      name: "Terminal build",
      command: "bun run build",
      cwd: "/repo",
      ownerAgentId: null,
      scope: "workspace",
      source: "terminal",
      status: "running",
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      terminalId: "terminal-1",
    };
    renderAgentTracks(HOST_WORKSPACE_ID, providerRow, [process]);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "打开 provider 子代理",
      process.name,
      "打开更改",
    ]);
  });
});

describe("AgentTracks provider 子代理路由", () => {
  it.each([
    {
      scenario: "桌面模式下元数据属于 B 时仍在宿主 A 打开",
      isCompact: false,
      agentWorkspaceId: OTHER_WORKSPACE_ID,
    },
    {
      scenario: "桌面模式下元数据和宿主同属 A 时正常打开",
      isCompact: false,
      agentWorkspaceId: HOST_WORKSPACE_ID,
    },
    {
      scenario: "compact 模式下元数据属于 B 时仍在宿主 A 打开",
      isCompact: true,
      agentWorkspaceId: OTHER_WORKSPACE_ID,
    },
  ])("$scenario", ({ isCompact, agentWorkspaceId }) => {
    layoutMode.isCompact = isCompact;
    const fixture = renderAgentTracks(agentWorkspaceId, providerRow);

    fireEvent.click(screen.getByRole("button", { name: "打开 provider 子代理" }));

    expectChildInHost(fixture, {
      kind: "provider_subagent",
      parentAgentId: PARENT_AGENT_ID,
      subagentId: SUBAGENT_ID,
    });
  });
});

describe("AgentTracks Git diff 路由", () => {
  it("在对话归属其他工作区时仍打开宿主工作区的右侧变更面板", () => {
    const fixture = renderAgentTracks(OTHER_WORKSPACE_ID, providerRow);
    const otherLayoutBefore =
      useWorkspaceLayoutStore.getState().layoutByWorkspace[fixture.otherWorkspaceKey];

    fireEvent.click(screen.getByRole("button", { name: "打开更改" }));

    const state = useWorkspaceLayoutStore.getState();
    const hostLayout = state.layoutByWorkspace[fixture.hostWorkspaceKey];
    const sidePanelPaneId = state.sidePanelPaneIdByWorkspace[fixture.hostWorkspaceKey];
    const sidePanel = findPaneById(hostLayout.root, sidePanelPaneId);
    const focusedTab = collectAllTabs(hostLayout.root).find(
      (tab) => tab.tabId === sidePanel?.focusedTabId,
    );
    expect(sidePanel?.hidden).not.toBe(true);
    expect(focusedTab?.target).toEqual({ kind: "working_diff" });
    expect(state.layoutByWorkspace[fixture.otherWorkspaceKey]).toBe(otherLayoutBefore);
  });
});

describe("AgentTracks Paseo 子会话路由", () => {
  it("桌面模式下父子同属 B 时在宿主 A 打开子会话", () => {
    const row = seedPaseoChild(OTHER_WORKSPACE_ID);
    const fixture = renderAgentTracks(OTHER_WORKSPACE_ID, row);

    fireEvent.click(screen.getByRole("button", { name: "打开 Paseo 子会话" }));

    expectChildInHost(fixture, { kind: "agent", agentId: row.id });
  });

  it.each([
    {
      scenario: "桌面模式下真正跨归属工作区的子会话仍使用导航",
      isCompact: false,
      childWorkspaceId: "workspace-c",
    },
    {
      scenario: "compact 模式下同归属工作区的子会话仍使用导航",
      isCompact: true,
      childWorkspaceId: OTHER_WORKSPACE_ID,
    },
  ])("$scenario", ({ isCompact, childWorkspaceId }) => {
    layoutMode.isCompact = isCompact;
    const row = seedPaseoChild(childWorkspaceId);
    const fixture = renderAgentTracks(OTHER_WORKSPACE_ID, row);

    fireEvent.click(screen.getByRole("button", { name: "打开 Paseo 子会话" }));

    expect(navigateToAgent).toHaveBeenCalledExactlyOnceWith({
      serverId: SERVER_ID,
      agentId: row.id,
    });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(fixture.layoutsBefore);
  });
});

describe("background process output routing", () => {
  it("reuses a bottom output tab while preserving the host chat and its agent identity", () => {
    const process: BackgroundProcess = {
      id: "daemon-build",
      name: "Background build",
      command: "bun run build",
      cwd: "/repo",
      ownerAgentId: null,
      scope: "workspace",
      source: "omp-daemon",
      status: "exited",
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      terminalId: null,
    };
    const fixture = renderAgentTracks(OTHER_WORKSPACE_ID, providerRow, [
      process,
      { ...process, id: "active-build", name: "Active build", status: "running" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: process.name }));
    fireEvent.click(screen.getByRole("button", { name: process.name }));
    const store = useWorkspaceLayoutStore.getState();
    const tabs = store.getWorkspaceTabs(fixture.hostWorkspaceKey);
    const outputs = tabs.filter((tab) => tab.target.kind === "background_process");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].target).toEqual({
      kind: "background_process",
      agentId: PARENT_AGENT_ID,
      processId: process.id,
    });
    const layout = store.layoutByWorkspace[fixture.hostWorkspaceKey];
    const chatPane = findPaneContainingTab(layout.root, fixture.parentTabId);
    const outputPane = findPaneContainingTab(layout.root, outputs[0].tabId);
    expect(chatPane?.focusedTabId).toBe(fixture.parentTabId);
    expect(outputPane?.id).not.toBe(chatPane?.id);
    store.closeTab(fixture.hostWorkspaceKey, outputs[0].tabId);
    expect(
      store
        .getWorkspaceTabs(fixture.hostWorkspaceKey)
        .some((tab) => tab.tabId === fixture.parentTabId),
    ).toBe(true);
  });
});
