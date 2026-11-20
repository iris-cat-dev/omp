import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidFenceHost } from "./host.web";
import { parseMermaidRuntimeMessage } from "./runtime/messages";

const pointerMode = vi.hoisted(() => ({ persistentActions: false }));
vi.mock("@/hooks/use-fine-pointer", () => ({
  useShowPersistentActions: () => pointerMode.persistentActions,
  useTouchInteraction: () => false,
  useSupportsHover: () => true,
  useHasFinePointer: () => true,
}));

vi.mock("expo-clipboard", () => ({}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

const mounted: { root: Root; container: HTMLDivElement }[] = [];
const inheritedStyles = {};
const textStyle = { backgroundColor: "#fff", padding: 8 };

afterEach(async () => {
  pointerMode.persistentActions = false;
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});
function waitForRenderFromAnotherFrame(excludedWindow: Window | null): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timeout = window.setTimeout(() => {
    window.removeEventListener("message", receive);
    reject(new Error("Timed out waiting for remounted Mermaid runtime"));
  }, 10_000);
  function receive(event: MessageEvent): void {
    if (event.source === excludedWindow) {
      return;
    }
    const message = parseMermaidRuntimeMessage(event.data);
    if (message?.type !== "rendered") {
      return;
    }
    window.clearTimeout(timeout);
    window.removeEventListener("message", receive);
    resolve();
  }
  window.addEventListener("message", receive);
  return promise;
}

describe("Mermaid diagram viewer", () => {
  it.each([false, true])(
    "opens and closes fullscreen with persistent actions %s",
    async (persistentActions) => {
      pointerMode.persistentActions = persistentActions;
      const container = document.createElement("div");
      container.style.width = "640px";
      document.body.appendChild(container);
      const root = createRoot(container);
      mounted.push({ root, container });

      await act(async () => {
        root.render(
          <MermaidFenceHost
            code={"flowchart LR\nA[Request] --> B[Response]"}
            phase="complete"
            inheritedStyles={inheritedStyles}
            textStyle={textStyle}
          />,
        );
      });

      await expect
        .poll(() => container.querySelector('[role="img"]') instanceof HTMLElement, {
          timeout: 10_000,
        })
        .toBe(true);
      const diagram = container.querySelector('[role="img"]');
      if (!(diagram instanceof HTMLElement)) {
        throw new Error("Mermaid diagram did not render");
      }
      if (!persistentActions) await userEvent.hover(diagram);

      const openButton = document.querySelector('[aria-label="message.diagram.viewFullscreen"]');
      expect(openButton).toBeInstanceOf(HTMLElement);
      if (persistentActions) {
        expect(getComputedStyle(openButton as HTMLElement).opacity).toBe("1");
        expect(getComputedStyle(openButton as HTMLElement).pointerEvents).not.toBe("none");
      }
      const inlineWindow = container.querySelector("iframe")?.contentWindow ?? null;
      const fullscreenRendered = waitForRenderFromAnotherFrame(inlineWindow);
      await userEvent.click(openButton as HTMLElement);
      await fullscreenRendered;

      await expect
        .poll(() => document.querySelector('[data-testid="mermaid-diagram-viewer"]'))
        .toBeInstanceOf(HTMLElement);
      const closeButton = document.querySelector('[aria-label="message.diagram.exitFullscreen"]');
      expect(closeButton).toBeInstanceOf(HTMLElement);
      if (persistentActions) {
        const viewport = document.querySelector<HTMLElement>(
          '[data-testid="mermaid-diagram-viewer"] [role="img"]',
        );
        if (!viewport || !(viewport.firstElementChild instanceof HTMLElement)) {
          throw new Error("Missing fullscreen pan viewport");
        }
        const content = viewport.firstElementChild;
        expect(getComputedStyle(viewport).touchAction).toBe("none");
        const capture = vi.spyOn(viewport, "setPointerCapture").mockImplementation(() => {});
        viewport.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
            button: 0,
            clientX: 100,
            clientY: 100,
          }),
        );
        viewport.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
            clientX: 140,
            clientY: 130,
          }),
        );
        expect(content.style.transform).toBe("translate(40px, 30px) scale(1)");
        viewport.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
          }),
        );
        viewport.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
            clientX: 200,
            clientY: 200,
          }),
        );
        expect(content.style.transform).toBe("translate(40px, 30px) scale(1)");
        capture.mockRestore();
      }
      const fullscreenWindow =
        document.querySelector<HTMLIFrameElement>('[data-testid="mermaid-diagram-viewer"] iframe')
          ?.contentWindow ?? null;
      const inlineRendered = waitForRenderFromAnotherFrame(fullscreenWindow);
      await userEvent.click(closeButton as HTMLElement);
      await inlineRendered;

      await expect
        .poll(() => document.querySelector('[data-testid="mermaid-diagram-viewer"]'))
        .toBeNull();
      await expect
        .poll(() => container.querySelector('[role="img"]') instanceof HTMLElement, {
          timeout: 10_000,
        })
        .toBe(true);
    },
  );
});
