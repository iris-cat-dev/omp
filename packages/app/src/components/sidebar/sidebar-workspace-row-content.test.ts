import { describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { resolveTrailingActionVisibility } from "./sidebar-workspace-row-content";

vi.mock("@/components/workspace-hover-card", () => ({
  WorkspaceHoverCard: () => null,
}));

vi.mock("@/components/sidebar/workspace-meta-row", () => ({
  WorkspaceMetaRow: () => null,
}));

vi.mock("@/components/sidebar/sidebar-workspace-inline-rename", () => ({
  SidebarWorkspaceInlineRename: () => null,
}));

vi.mock("@/workspace-labels", () => ({
  useWorkspaceLabelDefinitions: () => [],
}));

function makeWorkspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: "host:ws-1",
    serverId: "host",
    workspaceId: "ws-1",
    projectViewKey: "proj-1",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    title: "Main",
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: 1_700_000_000_000,
    archivingAt: null,
    pinnedAt: null,
    isUnstarted: false,
    isUnstartedWorktree: false,
    prHint: null,
    scripts: [],
    labels: [],
    rootAgents: [],
    ...overrides,
  } as SidebarWorkspaceEntry;
}

describe("resolveTrailingActionVisibility", () => {
  it("shows only timestamp on unselected touch rows and keeps timestamp + kebab on selected touch rows without scrim", () => {
    const workspace = makeWorkspace();

    expect(
      resolveTrailingActionVisibility({
        workspace,
        hasArchiveAction: true,
        selected: false,
        isHovered: true,
        isTouchInteraction: true,
        showShortcut: false,
      }),
    ).toEqual({
      showTrailing: true,
      showKebab: false,
      showScrim: false,
      renderSlot: true,
      reserveSlotWidth: false,
    });

    expect(
      resolveTrailingActionVisibility({
        workspace,
        hasArchiveAction: true,
        selected: true,
        isHovered: false,
        isTouchInteraction: true,
        showShortcut: false,
      }),
    ).toEqual({
      showTrailing: true,
      showKebab: true,
      showScrim: false,
      renderSlot: true,
      reserveSlotWidth: false,
    });
  });

  it("suppresses both timestamp and kebab on touch when shortcut badges are active", () => {
    const workspace = makeWorkspace();
    expect(
      resolveTrailingActionVisibility({
        workspace,
        hasArchiveAction: true,
        selected: true,
        isHovered: false,
        isTouchInteraction: true,
        showShortcut: true,
      }),
    ).toEqual({
      showTrailing: false,
      showKebab: false,
      showScrim: false,
      renderSlot: true,
      reserveSlotWidth: false,
    });
  });

  it("preserves desktop hover overlay with backdrop scrim while keeping timestamp behind it", () => {
    const workspace = makeWorkspace();
    expect(
      resolveTrailingActionVisibility({
        workspace,
        hasArchiveAction: true,
        selected: false,
        isHovered: true,
        isTouchInteraction: false,
        showPersistentActions: false,
        showShortcut: false,
      }),
    ).toEqual({
      showTrailing: true,
      showKebab: true,
      showScrim: true,
      renderSlot: true,
      reserveSlotWidth: true,
    });

    expect(
      resolveTrailingActionVisibility({
        workspace,
        hasArchiveAction: true,
        selected: true,
        isHovered: false,
        isTouchInteraction: false,
        showPersistentActions: false,
        showShortcut: false,
      }),
    ).toEqual({
      showTrailing: true,
      showKebab: false,
      showScrim: false,
      renderSlot: true,
      reserveSlotWidth: true,
    });
  });
});
