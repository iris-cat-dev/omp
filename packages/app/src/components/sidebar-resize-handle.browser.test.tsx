import React, { act, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import { commands } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "./sidebar-resize-handle";

const mounted: { root: Root; container: HTMLDivElement }[] = [];
const containerStyle = { width: 600, height: 300, flexDirection: "row" as const };
const contentStyle = { flex: 1 };
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

async function mountSidebar(finalize = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  function Sidebar() {
    const [width, setWidth] = useState(250);
    const startWidth = useRef(width);
    const gesture = useMemo(
      () =>
        Gesture.Pan()
          .runOnJS(true)
          .activeOffsetX([-3, 3])
          .onStart((event) => {
            startWidth.current = width - event.translationX;
          })
          .onUpdate((event) => setWidth(startWidth.current + event.translationX))
          .onFinalize((_event, success) => finalize(success)),
      [width],
    );
    const sidebarStyle = useMemo(() => ({ width, zIndex: 1 }), [width]);
    return (
      <GestureHandlerRootView>
        <View style={containerStyle}>
          <View testID="sidebar" style={sidebarStyle}>
            <SidebarResizeHandle
              edge="right"
              gesture={gesture}
              pressed={false}
              testID="sidebar-handle"
            />
          </View>
          <View style={contentStyle} />
        </View>
      </GestureHandlerRootView>
    );
  }
  await act(async () => {
    root.render(<Sidebar />);
  });
  return container;
}

it.each(["blur", "focus"] as const)(
  "releases the sidebar pan on window %s and permits another drag",
  async (interrupt) => {
    const finalize = vi.fn();
    const container = await mountSidebar(finalize);
    const sidebar = container.querySelector('[data-testid="sidebar"]')!;
    const handle = container.querySelector('[data-testid="sidebar-handle"]') as HTMLElement;
    const width = () => sidebar.getBoundingClientRect().width;
    const before = width();
    let interruptedWidth = before;
    const rememberWidth = () => {
      interruptedWidth = width();
    };
    window.addEventListener(interrupt, rememberWidth);
    try {
      await commands.dragPointerWithinElement('[data-testid="sidebar-handle"]', 60, 0, interrupt);
      expect(interruptedWidth).toBeGreaterThan(before);
      expect(width()).toBe(interruptedWidth);
      expect(handle.hasPointerCapture(1)).toBe(false);
      expect(finalize).toHaveBeenCalledExactlyOnceWith(false);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 180);
      await promise;
      expect(container.querySelector('[data-testid="sidebar-handle-highlight"]')).toBeNull();
      await commands.dragPointerWithinElement('[data-testid="sidebar-handle"]', -60, 0);
      expect(width()).toBeLessThan(interruptedWidth);
      expect(finalize).toHaveBeenLastCalledWith(true);
    } finally {
      window.removeEventListener(interrupt, rememberWidth);
    }
  },
);

it.each([false, true])(
  "clears sidebar hover and its pending timer on blur (already highlighted: %s)",
  async (alreadyHighlighted) => {
    const container = await mountSidebar();
    const handle = container.querySelector('[data-testid="sidebar-handle"]')!;
    act(() => handle.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" })));
    if (alreadyHighlighted) {
      await expect
        .poll(() => container.querySelector('[data-testid="sidebar-handle-highlight"]'))
        .not.toBeNull();
    }
    act(() => window.dispatchEvent(new Event("blur")));
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 180);
    await promise;
    expect(container.querySelector('[data-testid="sidebar-handle-highlight"]')).toBeNull();
  },
);
