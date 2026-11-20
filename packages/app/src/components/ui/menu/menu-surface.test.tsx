/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuSurface, useMenuSurface, type MenuSurfaceContextValue } from "./menu-surface";

const state = vi.hoisted(() => ({
  openSub: vi.fn(),
  closeSub: vi.fn(),
  goBack: vi.fn(),
  path: [] as string[],
  isTouchInteraction: false,
}));
vi.mock("@/hooks/use-fine-pointer", () => ({
  useTouchInteraction: () => state.isTouchInteraction,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react-native", () => ({
  ChevronLeft: () => null,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetBackdrop: () => null,
  BottomSheetScrollView: () => null,
}));
vi.mock("@/components/ui/isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: () => null,
  useIsolatedBottomSheetVisibility: vi.fn(),
}));
vi.mock("./menu-context", () => ({
  useMenuContext: () => ({
    presentation: "popover",
    path: state.path,
    open: true,
    setOpen: vi.fn(),
    triggerRef: { current: null },
    anchorRect: null,
    openSub: state.openSub,
    closeSub: state.closeSub,
    goBack: state.goBack,
  }),
  MenuContextProvider: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("./menu-item", () => ({
  MenuPage: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("./menu-overlay", () => ({
  MenuOverlay: ({ children }: React.PropsWithChildren) => children,
  AnchoredSurface: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

let surface: MenuSurfaceContextValue;
function Probe() {
  surface = useMenuSurface("Probe");
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  state.path = [];
  state.isTouchInteraction = false;
  render(
    <MenuSurface>
      <Probe />
    </MenuSurface>,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("menu hover timers", () => {
  it.each(["touch", "pen", ""])(
    "never schedules hover-open or hover-close for %s",
    (pointerType) => {
      act(() => {
        surface.hoverOpen({ id: "labels", depth: 0 }, pointerType);
        surface.hoverClose(0, pointerType);
        vi.runAllTimers();
      });
      expect(state.openSub).not.toHaveBeenCalled();
      expect(state.closeSub).not.toHaveBeenCalled();
    },
  );

  it("keeps delayed mouse hover-open and close", () => {
    act(() => surface.hoverOpen({ id: "labels", depth: 0 }, "mouse"));
    expect(state.openSub).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(90));
    expect(state.openSub).toHaveBeenCalledWith({ id: "labels", depth: 0 });
    act(() => surface.hoverClose(0, "mouse"));
    act(() => vi.advanceTimersByTime(259));
    expect(state.closeSub).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(state.closeSub).toHaveBeenCalledWith(0);
  });

  it("lets an explicit submenu selection cancel both sibling-open and leave-close timers", () => {
    act(() => {
      surface.hoverOpen({ id: "other", depth: 0 }, "mouse");
      surface.cancelHoverClose();
      vi.runAllTimers();
      surface.hoverClose(0, "mouse");
      surface.cancelHoverClose();
      vi.runAllTimers();
    });
    expect(state.openSub).not.toHaveBeenCalled();
    expect(state.closeSub).not.toHaveBeenCalled();
  });

  it("cancels outstanding intent when its surface unmounts", () => {
    act(() => surface.hoverOpen({ id: "labels", depth: 0 }, "mouse"));
    cleanup();
    act(() => vi.runAllTimers());
    expect(state.openSub).not.toHaveBeenCalled();
  });
});

describe("touch popover drill-down", () => {
  it("renders the active submenu page in place with a back button instead of a flyout and blocks mouse hover timers", () => {
    cleanup();
    state.isTouchInteraction = true;
    state.path = ["touchMode"];

    const { queryByTestId } = render(
      <MenuSurface
        testID="prefs-menu"
        pages={[
          {
            id: "touchMode",
            title: "Touch mode",
            content: <div data-testid="touch-mode-page">Auto / On / Off</div>,
          },
        ]}
      >
        <div data-testid="root-page">Root items</div>
        <Probe />
      </MenuSurface>,
    );

    expect(queryByTestId("root-page")).toBeNull();
    expect(queryByTestId("touch-mode-page")).not.toBeNull();
    expect(queryByTestId("prefs-menu-touchMode")).toBeNull();

    const backButton = queryByTestId("menu-sheet-back");
    expect(backButton).not.toBeNull();
    act(() => {
      backButton!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(state.goBack).toHaveBeenCalledOnce();
  });

  it("ignores mouse hoverOpen when touch interaction is active", () => {
    cleanup();
    state.isTouchInteraction = true;
    state.path = [];

    render(
      <MenuSurface
        testID="prefs-menu"
        pages={[{ id: "touchMode", title: "Touch mode", content: <div>Sub</div> }]}
      >
        <Probe />
      </MenuSurface>,
    );

    act(() => {
      surface.hoverOpen({ id: "touchMode", depth: 0 }, "mouse");
      vi.runAllTimers();
    });
    expect(state.openSub).not.toHaveBeenCalled();
  });
});
