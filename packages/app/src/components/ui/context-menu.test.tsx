/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuTrigger } from "./context-menu";

const state = vi.hoisted(() => ({
  style: undefined as unknown,
  open: false,
  setAnchorRect: vi.fn(),
  setOpen: vi.fn(),
  props: null as Record<string, unknown> | null,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StatusBar: {},
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/components/ui/menu", () => ({
  MenuHint: () => null,
  MenuItem: () => null,
  MenuLabel: () => null,
  MenuRoot: () => null,
  MenuSeparator: () => null,
  MenuSurface: () => null,
  useMenuContext: () => ({
    open: state.open,
    setAnchorRect: state.setAnchorRect,
    setOpen: state.setOpen,
    triggerRef: { current: null },
  }),
}));

vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: (props: Record<string, unknown>) => {
    state.style = props.style;
    state.props = props;
    return <div data-testid="trigger">{props.children as React.ReactNode}</div>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  state.style = undefined;
  state.props = null;
  state.open = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function callHandler(name: string, event: Record<string, unknown>): void {
  const fn = state.props?.[name];
  if (typeof fn !== "function") {
    throw new Error(`Expected handler ${name} to be defined`);
  }
  act(() => {
    (fn as (e: Record<string, unknown>) => void)(event);
  });
}

describe("ContextMenuTrigger", () => {
  it("preserves a static trigger style so the native press highlight can inherit its corners", () => {
    const rowStyle = [{ borderRadius: 8 }, { backgroundColor: "#111" }];

    render(<ContextMenuTrigger style={rowStyle} />);

    expect(state.style).toBe(rowStyle);
  });

  it("opens on a stationary 400ms web touch long press and suppresses trailing press and native contextmenu", () => {
    const onPress = vi.fn();
    render(<ContextMenuTrigger enableTouchLongPress onPress={onPress} />);

    callHandler("onPointerDown", {
      nativeEvent: { pointerType: "touch", pageX: 120, pageY: 240 },
    });

    act(() => vi.advanceTimersByTime(399));
    expect(state.setOpen).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(state.setAnchorRect).toHaveBeenCalledWith({ x: 120, y: 240, width: 0, height: 0 });
    expect(state.setOpen).toHaveBeenCalledExactlyOnceWith(true);

    // Trailing tap press after long press must be swallowed.
    callHandler("onPress", {});
    expect(onPress).not.toHaveBeenCalled();

    // Native browser contextmenu within suppression window must not reopen.
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    callHandler("onContextMenu", {
      pageX: 125,
      pageY: 245,
      preventDefault,
      stopPropagation,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(state.setOpen).toHaveBeenCalledTimes(1);
  });

  it("cancels web touch long press when the finger moves beyond 8px or lifts early", () => {
    const onPress = vi.fn();
    render(<ContextMenuTrigger enableTouchLongPress onPress={onPress} />);

    callHandler("onPointerDown", {
      nativeEvent: { pointerType: "touch", pageX: 100, pageY: 100 },
    });
    callHandler("onPointerMove", {
      nativeEvent: { pointerType: "touch", pageX: 100, pageY: 112 },
    });
    act(() => vi.advanceTimersByTime(500));
    expect(state.setOpen).not.toHaveBeenCalled();

    // Early lift before 400ms allows normal tap.
    callHandler("onPointerDown", {
      nativeEvent: { pointerType: "touch", pageX: 100, pageY: 100 },
    });
    act(() => vi.advanceTimersByTime(150));
    callHandler("onPointerUp", {
      nativeEvent: { pointerType: "touch", pageX: 100, pageY: 100 },
    });
    act(() => vi.advanceTimersByTime(300));
    expect(state.setOpen).not.toHaveBeenCalled();
    callHandler("onPress", {});
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("ignores mouse pointers and nested sidebar controls during web touch long press", () => {
    render(<ContextMenuTrigger enableTouchLongPress />);

    // Mouse pointer never starts the touch long-press timer.
    callHandler("onPointerDown", {
      nativeEvent: { pointerType: "mouse", pageX: 100, pageY: 100 },
    });
    act(() => vi.advanceTimersByTime(500));
    expect(state.setOpen).not.toHaveBeenCalled();

    // Nested control marked with data-sidebar-nested-control="true" must not trigger row menu.
    const host = document.createElement("div");
    host.setAttribute("data-sidebar-nested-control", "true");
    const icon = document.createElement("span");
    host.appendChild(icon);
    document.body.appendChild(host);

    callHandler("onPointerDown", {
      nativeEvent: { pointerType: "touch", pageX: 100, pageY: 100, target: icon },
    });
    act(() => vi.advanceTimersByTime(500));
    expect(state.setOpen).not.toHaveBeenCalled();
    host.remove();
  });
});
