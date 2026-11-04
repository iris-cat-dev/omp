import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueWriter, QueuedComposerMessage } from "./actions";
import { QueuedMessageTrack } from "./queued-message-track";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
// The real session store imports timeline-assets, whose Expo crypto boundary is
// unrelated to queue interactions and is not bundled by the Vitest browser harness.
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, text: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  },
}));

const serverId = "browser-queued-messages";
const agentId = "browser-agent";
const emptyMessages: QueuedComposerMessage[] = [];
let root: Root;
let container: HTMLDivElement;
const queue: QueueWriter = {
  read: (id) => useSessionStore.getState().sessions[serverId]?.queuedMessages.get(id) ?? [],
  write: (updater) => useSessionStore.getState().setQueuedMessages(serverId, updater),
};
const ignoreAction = (_id: string) => {};

function queuedIds(): string[] {
  return queue.read(agentId).map((item) => item.id);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function Harness() {
  const messages =
    useSessionStore((state) => state.sessions[serverId]?.queuedMessages.get(agentId)) ??
    emptyMessages;
  return (
    <QueuedMessageTrack
      agentId={agentId}
      messages={messages}
      queue={queue}
      onEdit={ignoreAction}
      onSendNow={ignoreAction}
    />
  );
}

function setMessages(...ids: string[]): void {
  useSessionStore
    .getState()
    .setQueuedMessages(
      serverId,
      new Map([[agentId, ids.map((id) => ({ id, text: `Pending ${id}`, attachments: [] }))]]),
    );
}

function orderedRows(): string[] {
  return [...container.querySelectorAll('[data-testid^="queued-message-"]')]
    .filter((row) => /^queued-message-(A|B|C|D)$/.test(row.getAttribute("data-testid") ?? ""))
    .map((row) => row.getAttribute("data-testid")!.replace("queued-message-", ""));
}

function element(testId: string): HTMLElement {
  const found = container.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`Missing visible queue item ${testId}`);
  return found;
}

function sendTouch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  x: number,
  y: number,
): void {
  const touch = new Touch({
    identifier: 1,
    target,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    screenX: x,
    screenY: y,
  });
  const activeTouches = type === "touchend" ? [] : [touch];
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: activeTouches,
      targetTouches: activeTouches,
      changedTouches: [touch],
    }),
  );
}
function sendMouse(
  target: EventTarget,
  type: "mousedown" | "mousemove" | "mouseup",
  x: number,
  y: number,
): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "mouseup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!i18n.isInitialized) await i18n.init();
  await i18n.changeLanguage("en");
  useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
  container = document.createElement("div");
  container.style.width = "360px";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSessionStore.getState().clearSession(serverId);
  vi.unstubAllGlobals();
});

describe("queued message submission controls", () => {
  it("blocks sending while a request is pending without blocking editing", () => {
    act(() => setMessages("A"));
    const onEdit = vi.fn();
    const onSendNow = vi.fn();
    act(() =>
      root.render(
        <QueuedMessageTrack
          agentId={agentId}
          messages={queue.read(agentId)}
          queue={queue}
          onEdit={onEdit}
          onSendNow={onSendNow}
          sendDisabled
        />,
      ),
    );
    const actions = element("queued-message-A").querySelectorAll<HTMLElement>('[role="button"]');
    expect(actions).toHaveLength(2);
    act(() => {
      actions[1]!.click();
      actions[0]!.click();
    });
    expect(onSendNow).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith("A");
    expect(queue.read(agentId)[0]?.text).toBe("Pending A");

    act(() =>
      root.render(
        <QueuedMessageTrack
          agentId={agentId}
          messages={queue.read(agentId)}
          queue={queue}
          onEdit={onEdit}
          onSendNow={onSendNow}
          sendDisabled={false}
        />,
      ),
    );
    act(() =>
      element("queued-message-A").querySelectorAll<HTMLElement>('[role="button"]')[1]!.click(),
    );
    expect(onSendNow).toHaveBeenCalledOnce();
  });
});

describe("queued message order on a touch-sized screen", () => {
  it("moves a pending message from last to first by touch", async () => {
    act(() => setMessages("A", "B", "C"));
    expect(orderedRows()).toEqual(["A", "B", "C"]);
    const handle = element("queued-message-drag-C");
    const from = handle.getBoundingClientRect();
    const to = element("queued-message-A").getBoundingClientRect();
    const x = from.x + from.width / 2;
    const startY = from.y + from.height / 2;
    const endY = to.y + to.height / 2;
    expect(from.width).toBeGreaterThanOrEqual(36);
    expect(from.height).toBeGreaterThanOrEqual(44);

    act(() => sendTouch(handle, "touchstart", x, startY));
    await new Promise((resolve) => setTimeout(resolve, 230));
    act(() => sendTouch(handle, "touchmove", x, endY));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    act(() => sendTouch(handle, "touchend", x, endY));

    await vi.waitFor(() => {
      expect(queuedIds()).toEqual(["C", "A", "B"]);
      expect(orderedRows()).toEqual(["C", "A", "B"]);
    });
    expect(element("queued-message-C").textContent).toContain("Pending C");
  });

  it("reorders with an attached mouse without a separate move button", async () => {
    act(() => setMessages("A", "B", "C"));
    const handle = element("queued-message-drag-C");
    const from = handle.getBoundingClientRect();
    const to = element("queued-message-A").getBoundingClientRect();
    const x = from.x + from.width / 2;
    const startY = from.y + from.height / 2;
    const endY = to.y + to.height / 2;

    act(() => sendMouse(handle, "mousedown", x, startY));
    act(() => sendMouse(document, "mousemove", x, startY - 12));
    act(() => sendMouse(document, "mousemove", x, endY));
    await nextFrame();
    act(() => sendMouse(document, "mouseup", x, endY));

    await vi.waitFor(() => {
      expect(queuedIds()).toEqual(["C", "A", "B"]);
      expect(orderedRows()).toEqual(["C", "A", "B"]);
    });
  });

  it.each([
    {
      change: "an earlier message is sent",
      duringDrag: ["B", "C"],
      targetId: "B",
      expected: ["B", "C"],
      removedIds: ["A"],
    },
    {
      change: "another queued message is edited",
      duringDrag: ["A", "C"],
      targetId: "A",
      expected: ["C", "A"],
      removedIds: ["B"],
    },
    {
      change: "a new message is queued",
      duringDrag: ["A", "B", "C", "D"],
      targetId: "A",
      expected: ["C", "A", "B", "D"],
      removedIds: [],
    },
    {
      change: "the dragged message is sent",
      duringDrag: ["A", "B"],
      targetId: "A",
      expected: ["A", "B"],
      removedIds: ["C"],
    },
  ])(
    "uses the live queue after $change during a held drag",
    async ({ duringDrag, targetId, expected, removedIds }) => {
      act(() => setMessages("A", "B", "C"));
      const handle = element("queued-message-drag-C");
      const from = handle.getBoundingClientRect();
      const x = from.x + from.width / 2;
      const startY = from.y + from.height / 2;

      act(() => sendTouch(handle, "touchstart", x, startY));
      const hold = Promise.withResolvers<void>();
      setTimeout(hold.resolve, 230);
      await hold.promise;
      act(() => setMessages(...duringDrag));
      await nextFrame();
      expect(orderedRows()).toEqual(duringDrag);
      const to = element(`queued-message-${targetId}`).getBoundingClientRect();
      const endY = to.y + to.height / 2;
      act(() => sendTouch(handle, "touchmove", x, endY));
      await nextFrame();
      act(() => sendTouch(handle, "touchend", x, endY));

      await vi.waitFor(() => {
        expect(queuedIds()).toEqual(expected);
        expect(orderedRows()).toEqual(expected);
      });
      for (const id of removedIds) {
        expect(container.querySelector(`[data-testid="queued-message-${id}"]`)).toBeNull();
      }
    },
  );

  it("supports keyboard drag and hides the handle when only one message remains", async () => {
    act(() => setMessages("A"));
    expect(orderedRows()).toEqual(["A"]);
    expect(container.querySelector('[data-testid^="queued-message-drag-"]')).toBeNull();

    act(() => setMessages("A", "B"));
    const handle = element("queued-message-drag-B");
    handle.focus();
    await act(async () => userEvent.keyboard("[Space]"));
    await act(async () => {
      await nextFrame();
    });
    await act(async () => userEvent.keyboard("[ArrowUp]"));
    await act(async () => userEvent.keyboard("[Space]"));

    await vi.waitFor(() => {
      expect(queuedIds()).toEqual(["B", "A"]);
      expect(orderedRows()).toEqual(["B", "A"]);
    });
  });
});
