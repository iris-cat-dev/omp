import React, { act, useCallback, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import type * as Reanimated from "react-native-reanimated";
import { PortalProvider } from "@gorhom/portal";
import { Home } from "lucide-react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuItem, MenuRoot, MenuSubTrigger, MenuSurface, MenuTrigger } from "@/components/ui/menu";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarWorkspaceRowContent } from "@/components/sidebar/sidebar-workspace-row-content";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { resetRuntimePointerModalityForTests } from "@/hooks/use-fine-pointer";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

// Keep real menu DOM/interaction and replace only the Reanimated animation boundary.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof Reanimated>();
  const { View: RNView } = await import("react-native");
  return { ...actual, default: { ...actual.default, View: RNView } };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("expo-router", () => ({
  router: { navigate: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  useRouter: () => ({ navigate: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ copied: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/components/project-icon-view", () => ({
  ProjectIconView: () => null,
}));
vi.mock("@/components/sidebar/project-leading-visual", () => ({
  ProjectStatusIndicator: () => null,
}));
vi.mock("@/components/status-ring", () => ({
  StatusRing: () => null,
}));
vi.mock("@/components/workspace-hover-card", () => ({
  WorkspaceHoverCard: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("@/workspace-labels", () => ({
  useWorkspaceLabelDefinitions: () => [],
}));
vi.mock("@/components/sidebar/workspace-meta-row", () => ({
  WorkspaceMetaRow: () => null,
}));
vi.mock("@/components/sidebar/sidebar-workspace-inline-rename", () => ({
  SidebarWorkspaceInlineRename: () => null,
}));

const mounted: { root: Root; container: HTMLDivElement }[] = [];

const VIEWPORT_STYLE = { flexDirection: "row", width: 2048, height: 1024 } as const;
const SIDEBAR_STYLE = { width: 308, height: 600, position: "relative" } as const;
const TOUCH_ROW_STYLE = {
  minHeight: 44,
  paddingVertical: 4,
  paddingHorizontal: 12,
  justifyContent: "center",
} as const;
const KEBAB_STYLE = {
  width: 36,
  height: 36,
  alignItems: "center",
  justifyContent: "center",
} as const;
const ICON_TRIGGER_STYLE = { width: 36, height: 36 } as const;
const NESTED_CONTROL_DATASET = { sidebarNestedControl: "true" };
const NOOP = () => {};
const WORKSPACE_KEBAB_ACCESSORY = (
  <View testID="workspace-kebab" dataSet={NESTED_CONTROL_DATASET} style={KEBAB_STYLE}>
    <Text>⋮</Text>
  </View>
);
const SELECTED_KEBAB_ACCESSORY = (
  <View testID="selected-kebab" style={KEBAB_STYLE}>
    <Text>⋮</Text>
  </View>
);

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
    name: "feature/ipad-touch",
    title: "iPad touch sidebar",
    currentBranch: "feature/ipad-touch",
    statusBucket: "done",
    statusEnteredAt: Date.now() - 60_000,
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

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(2048, 1024);
  useSidebarViewStore.setState({ touchMode: "auto", reorderMode: false });
  resetRuntimePointerModalityForTests();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useSidebarViewStore.setState({ touchMode: "auto", reorderMode: false });
  resetRuntimePointerModalityForTests();
  vi.unstubAllGlobals();
});

function mountApp(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <GestureHandlerRootView>
        <PortalProvider>
          {element}
          <FloatingPanelPortalHost />
        </PortalProvider>
      </GestureHandlerRootView>,
    );
  });
  return container;
}

function SwitchHarness({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const [selected, setSelected] = useState(false);
  const gesture = useMemo(() => Gesture.Pan(), []);
  const handleToggleSelected = useCallback(() => {
    setSelected((prev) => !prev);
  }, []);
  return (
    <View style={VIEWPORT_STYLE}>
      <View testID="sidebar" style={SIDEBAR_STYLE}>
        <SidebarHeaderRow
          label="Sessions"
          icon={Home}
          variant="compact"
          onPress={handleToggleSelected}
          testID="compact-header-row"
        />
        <View testID="workspace-row-shell" style={TOUCH_ROW_STYLE}>
          <SidebarWorkspaceRowContent
            workspace={workspace}
            backdrop="surfaceSidebar"
            selected={selected}
            isHovered={false}
            isLoading={false}
            trailingAccessory={selected ? SELECTED_KEBAB_ACCESSORY : null}
          >
            <Text testID="row-timestamp">2m</Text>
          </SidebarWorkspaceRowContent>
        </View>
        <SidebarResizeHandle
          edge="right"
          gesture={gesture}
          pressed={false}
          testID="resize-handle"
        />
      </View>
    </View>
  );
}

describe("high-res iPad touch sidebar geometry and interactions (2048x1024)", () => {
  it("activates 44px rows, outside-positioned resize grip, in-place menu drill-down, long-press context menu, and tooltip suppression on touchMode='on'", async () => {
    useSidebarViewStore.setState({ touchMode: "on" });
    const workspace = makeWorkspace();
    let longPressActionPicked = false;
    let selectedMode = "on";

    function Harness() {
      const [contextOpen, setContextOpen] = useState(false);
      const gesture = useMemo(() => Gesture.Pan(), []);
      const handleSelectRename = useCallback(() => {
        longPressActionPicked = true;
      }, []);
      const handleSelectAuto = useCallback(() => {
        selectedMode = "auto";
      }, []);
      const menuPages = useMemo(
        () => [
          {
            id: "touchMode",
            title: "Touch mode",
            content: (
              <MenuItem testID="touch-mode-auto" onSelect={handleSelectAuto}>
                Auto
              </MenuItem>
            ),
          },
        ],
        [handleSelectAuto],
      );
      return (
        <View style={VIEWPORT_STYLE}>
          <View testID="sidebar" style={SIDEBAR_STYLE}>
            <SidebarHeaderRow
              label="Sessions"
              icon={Home}
              onPress={NOOP}
              testID="sidebar-header-row"
            />
            <ContextMenu open={contextOpen} onOpenChange={setContextOpen}>
              <ContextMenuTrigger
                enableTouchLongPress
                style={TOUCH_ROW_STYLE}
                testID="workspace-row"
              >
                <SidebarWorkspaceRowContent
                  workspace={workspace}
                  backdrop="surfaceSidebar"
                  selected
                  isHovered={false}
                  isLoading={false}
                  trailingAccessory={WORKSPACE_KEBAB_ACCESSORY}
                >
                  <Text testID="workspace-timestamp">1m</Text>
                </SidebarWorkspaceRowContent>
              </ContextMenuTrigger>
              <ContextMenuContent testID="workspace-context-menu" width={240}>
                <ContextMenuItem testID="context-rename" onSelect={handleSelectRename}>
                  Rename
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            <MenuRoot compactMode="sheet">
              <MenuTrigger testID="prefs-trigger" style={ICON_TRIGGER_STYLE}>
                <Text>⚙</Text>
              </MenuTrigger>
              <MenuSurface testID="prefs-surface" width={232} pages={menuPages}>
                <MenuSubTrigger id="touchMode" testID="prefs-sub-touch">
                  Touch mode
                </MenuSubTrigger>
              </MenuSurface>
            </MenuRoot>

            <Tooltip enabledOnDesktop enabledOnMobile={false}>
              <TooltipTrigger testID="search-tooltip-trigger" style={ICON_TRIGGER_STYLE}>
                <Text>S</Text>
              </TooltipTrigger>
              <TooltipContent testID="search-tooltip-content">
                <Text>Search</Text>
              </TooltipContent>
            </Tooltip>

            <SidebarResizeHandle
              edge="right"
              gesture={gesture}
              pressed={false}
              testID="sidebar-resize-handle"
            />
          </View>
        </View>
      );
    }

    const container = mountApp(<Harness />);

    // 1. Viewport is truly high-res iPad (2048x1024), NOT compact breakpoint.
    expect(window.innerWidth).toBe(2048);

    // 2. Touch header row & workspace row meet >= 44px touch target height, and kebab does not overlap resize handle.
    const headerRect = container
      .querySelector<HTMLElement>('[data-testid="sidebar-header-row"]')!
      .getBoundingClientRect();
    const rowRect = container
      .querySelector<HTMLElement>('[data-testid="workspace-row"]')!
      .getBoundingClientRect();
    const kebabRect = container
      .querySelector<HTMLElement>('[data-testid="workspace-kebab"]')!
      .getBoundingClientRect();
    const timestampRect = container
      .querySelector<HTMLElement>('[data-testid="workspace-timestamp"]')!
      .getBoundingClientRect();
    const sidebarRect = container
      .querySelector<HTMLElement>('[data-testid="sidebar"]')!
      .getBoundingClientRect();
    const handleRect = container
      .querySelector<HTMLElement>('[data-testid="sidebar-resize-handle"]')!
      .getBoundingClientRect();

    expect(headerRect.height).toBeGreaterThanOrEqual(44);
    expect(rowRect.height).toBeGreaterThanOrEqual(44);
    expect(kebabRect.width).toBe(36);
    expect(kebabRect.height).toBe(36);
    // Timestamp stays visible beside the kebab without overlapping it.
    expect(timestampRect.right).toBeLessThanOrEqual(kebabRect.left);
    // Web touch resize handle sits mostly outside the sidebar right edge (overlaps sidebar by <= 4px)
    // and never overlaps the 36x36 kebab button inside the sidebar.
    expect(sidebarRect.right - handleRect.left).toBeLessThanOrEqual(5);
    expect(handleRect.left).toBeGreaterThanOrEqual(kebabRect.right);

    // 3. Tooltip stays suppressed on touch pointer/click.
    const tooltipTrigger = container.querySelector<HTMLElement>(
      '[data-testid="search-tooltip-trigger"]',
    )!;
    act(() => {
      tooltipTrigger.dispatchEvent(
        new PointerEvent("pointerenter", { pointerType: "touch", bubbles: true }),
      );
      tooltipTrigger.click();
    });
    expect(document.querySelector('[data-testid="search-tooltip-content"]')).toBeNull();

    // 4. Anchored popover submenu drills in place with a back button and 44px menu items.
    const prefsTrigger = container.querySelector<HTMLElement>('[data-testid="prefs-trigger"]')!;
    act(() => {
      prefsTrigger.click();
    });
    await expect
      .poll(() => document.querySelector('[data-testid="prefs-sub-touch"]'))
      .not.toBeNull();
    const subTrigger = document.querySelector<HTMLElement>('[data-testid="prefs-sub-touch"]')!;
    expect(subTrigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    act(() => {
      subTrigger.click();
    });
    await expect
      .poll(() => document.querySelector('[data-testid="touch-mode-auto"]'))
      .not.toBeNull();
    // Drill-down replaces root content in place rather than opening a second flyout surface.
    expect(document.querySelector('[data-testid="prefs-sub-touch"]')).toBeNull();
    expect(document.querySelector('[data-testid="prefs-surface-touchMode"]')).toBeNull();
    const backBtn = document.querySelector<HTMLElement>('[data-testid="menu-sheet-back"]')!;
    expect(backBtn.getBoundingClientRect().width).toBeGreaterThanOrEqual(36);
    expect(backBtn.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
    act(() => {
      document.querySelector<HTMLElement>('[data-testid="touch-mode-auto"]')!.click();
    });
    expect(selectedMode).toBe("auto");

    // 5. Stationary 400ms touch long press opens the workspace context menu in real Chromium.
    const row = container.querySelector<HTMLElement>('[data-testid="workspace-row"]')!;
    act(() => {
      row.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerType: "touch",
          clientX: rowRect.left + 40,
          clientY: rowRect.top + 20,
          bubbles: true,
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 440));
    await expect
      .poll(() => document.querySelector('[data-testid="context-rename"]'))
      .not.toBeNull();
    const renameItem = document.querySelector<HTMLElement>('[data-testid="context-rename"]')!;
    expect(renameItem.offsetHeight).toBeGreaterThanOrEqual(44);
    await expect.poll(() => renameItem.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    act(() => {
      renameItem.click();
    });
    expect(longPressActionPicked).toBe(true);
    // Allow exit keyframe (100ms) to finish before unmounting the React tree.
    await new Promise((resolve) => setTimeout(resolve, 140));
  });

  it("preserves desktop density at 2048x1024 for mouse, switches automatically on runtime touch pointerdown, and keeps selected/unselected touch rows the same height", async () => {
    const workspace = makeWorkspace();
    const container = mountApp(<SwitchHarness workspace={workspace} />);
    const header = container.querySelector<HTMLElement>('[data-testid="compact-header-row"]')!;
    const getHandle = () => container.querySelector<HTMLElement>('[data-testid="resize-handle"]')!;

    // Desktop mouse default at 2048x1024: compact row (< 44px) and hairline desktop handle (width 10).
    expect(header.getBoundingClientRect().height).toBeLessThan(44);
    expect(getHandle().getBoundingClientRect().width).toBe(10);

    // Runtime touch pointerdown switches the high-res viewport into touch mode automatically.
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
      );
    });
    await expect.poll(() => header.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(getHandle().getBoundingClientRect().width).toBe(24);

    // Unselected vs selected touch workspace row keeps identical height (no layout jump when 36x36 kebab appears).
    const rowShell = container.querySelector<HTMLElement>('[data-testid="workspace-row-shell"]')!;
    const unselectedHeight = rowShell.getBoundingClientRect().height;
    expect(unselectedHeight).toBeGreaterThanOrEqual(44);
    expect(container.querySelector('[data-testid="selected-kebab"]')).toBeNull();

    act(() => {
      header.click();
    });
    await expect
      .poll(() => container.querySelector('[data-testid="selected-kebab"]'))
      .not.toBeNull();
    expect(rowShell.getBoundingClientRect().height).toBe(unselectedHeight);

    // Switching back to mouse pointerdown restores desktop compact density.
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }),
      );
    });
    await expect.poll(() => header.getBoundingClientRect().height).toBeLessThan(44);
    expect(getHandle().getBoundingClientRect().width).toBe(10);
  });
});
