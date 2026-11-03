import React, { act, useCallback, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { commands } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./resize-handle";

declare module "vitest/browser" {
  interface BrowserCommands {
    dragPointerWithinElement(
      selector: string,
      deltaX: number,
      deltaY: number,
      interrupt?: "blur" | "focus",
    ): Promise<void>;
  }
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];
const splitStyles = {
  horizontal: { width: 400, height: 300, flexDirection: "row" as const },
  vertical: { width: 400, height: 300, flexDirection: "column" as const },
};
const paneStyle = { flex: 1 };

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

for (const direction of ["horizontal", "vertical"] as const) {
  it.each([1, 0.75])(
    `keeps both sides of the ${direction} divider draggable with visible weight %s`,
    async (visibleSizeTotal) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });

      function Split() {
        const [sizes, setSizes] = useState([
          visibleSizeTotal / 2,
          visibleSizeTotal / 2,
          1 - visibleSizeTotal,
        ]);
        const firstPaneStyle = useMemo(
          () => ({ flex: sizes[0] / visibleSizeTotal, minWidth: 0, minHeight: 0 }),
          [sizes],
        );
        const secondPaneStyle = useMemo(
          () => ({ flex: sizes[1] / visibleSizeTotal, minWidth: 0, minHeight: 0 }),
          [sizes],
        );
        const handleResize = useCallback((_group: string, next: number[]) => setSizes(next), []);
        return (
          <View style={splitStyles[direction]}>
            <View testID="first-pane" style={firstPaneStyle} />
            <ResizeHandle
              testID="divider"
              direction={direction}
              groupId="group"
              index={0}
              sizes={sizes}
              visibleSizeTotal={visibleSizeTotal}
              onPreviewResizeSplit={handleResize}
              onResizeSplit={handleResize}
            />
            <View style={secondPaneStyle} />
          </View>
        );
      }

      act(() => root.render(<Split />));
      const separator = container.querySelector('[role="separator"]');
      const firstPane = container.querySelector('[data-testid="first-pane"]');
      if (!(separator instanceof HTMLElement) || !(firstPane instanceof HTMLElement)) {
        throw new Error("Split divider did not mount");
      }
      const rect = separator.getBoundingClientRect();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      for (const side of [-1, 1]) {
        const x = centerX + (direction === "horizontal" ? side * 3 : 0);
        const y = centerY + (direction === "vertical" ? side * 3 : 0);
        expect(document.elementFromPoint(x, y)).toBe(separator);
      }

      const size = () => {
        const box = firstPane.getBoundingClientRect();
        return direction === "horizontal" ? box.width : box.height;
      };
      const before = size();
      let pointerStart = Number.NaN;
      let pointerEnd = Number.NaN;
      separator.addEventListener("pointerdown", (event) => {
        pointerStart = pointerEnd = direction === "horizontal" ? event.clientX : event.clientY;
      });
      separator.addEventListener("pointermove", (event) => {
        if (event.buttons & 1) {
          pointerEnd = direction === "horizontal" ? event.clientX : event.clientY;
        }
      });
      await commands.dragPointerWithinElement(
        '[data-testid="divider"] [role="separator"]',
        direction === "horizontal" ? 40 : 0,
        direction === "vertical" ? 40 : 0,
      );
      // Browser commands move in host-page pixels; the test iframe may be scaled.
      const delta = pointerEnd - pointerStart;
      expect(delta).toBeGreaterThan(20);
      await expect.poll(() => Math.abs(size() - before - delta)).toBeLessThan(1);
    },
  );
}

for (const direction of ["horizontal", "vertical"] as const) {
  it.each(["blur", "focus"] as const)(
    `ends the ${direction} drag on window %s even without pointerup`,
    async (interrupt) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });
      let latestPreview: number[] | undefined;
      let interruptedSizes: number[] | undefined;
      const preview = vi.fn((_group: string, sizes: number[]) => {
        latestPreview = sizes;
      });
      const commit = vi.fn();
      const rememberSize = () => {
        interruptedSizes = latestPreview;
      };
      window.addEventListener(interrupt, rememberSize);
      const cursorBefore = document.body.style.cursor;
      act(() =>
        root.render(
          <View style={splitStyles[direction]}>
            <View style={paneStyle} />
            <ResizeHandle
              testID="interrupted-divider"
              direction={direction}
              groupId="group"
              index={0}
              sizes={[0.5, 0.5]}
              visibleSizeTotal={1}
              onPreviewResizeSplit={preview}
              onResizeSplit={commit}
            />
            <View style={paneStyle} />
          </View>,
        ),
      );
      try {
        await commands.dragPointerWithinElement(
          '[data-testid="interrupted-divider"] [role="separator"]',
          direction === "horizontal" ? 40 : 0,
          direction === "vertical" ? 40 : 0,
          interrupt,
        );
        expect(interruptedSizes?.[0]).toBeGreaterThan(0.5);
        expect(latestPreview).toEqual(interruptedSizes);
        expect(commit).toHaveBeenCalledExactlyOnceWith("group", interruptedSizes);
        expect(document.body.style.cursor).toBe(cursorBefore);
        // A pending hover timer must not re-highlight after the window transition.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 180);
        await promise;
        expect(container.querySelector('[data-testid="interrupted-divider-highlight"]')).toBeNull();
        await commands.dragPointerWithinElement(
          '[data-testid="interrupted-divider"] [role="separator"]',
          direction === "horizontal" ? -30 : 0,
          direction === "vertical" ? -30 : 0,
        );
        expect(commit).toHaveBeenCalledTimes(2);
        expect(latestPreview?.[0]).toBeLessThan(0.5);
      } finally {
        window.removeEventListener(interrupt, rememberSize);
      }
    },
  );
}
