import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { StreamItem } from "@/types/stream";
import type { StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";
import { estimateStreamItemHeight } from "./web-virtualization";

const ROW_COUNT = 80;
const mounted: { root: Root; container: HTMLDivElement }[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
});

function message(index: number): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
    timestamp: new Date(0),
  };
}

const ESTIMATED_HEIGHT = estimateStreamItemHeight(message(1));
const WRAPPED_ROW_STYLE = { fontFamily: "monospace", fontSize: 14, lineHeight: "20px" };
const ROW_STYLE = { height: ESTIMATED_HEIGHT };
const FOOTER_STYLE = { height: 40 };

async function frames(count = 6) {
  // Commit each frame's measurements before the next browser frame, as the
  // browser does outside act; do not batch an entire settle across stale DOM.
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      const frame = Promise.withResolvers<void>();
      requestAnimationFrame(() => frame.resolve());
      await frame.promise;
    });
  }
}

async function mountHistory() {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    width: "320px",
    height: "320px",
  });
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const onNearHistoryStart = vi.fn().mockResolvedValue(true);
  const renderRow = (item: StreamItem) =>
    item.id === "message-0" ? (
      <div style={WRAPPED_ROW_STYLE}>{"wrapped history content ".repeat(100)}</div>
    ) : (
      <div style={ROW_STYLE}>{item.id}</div>
    );
  let input: StreamRenderInput = {
    agentId: "width-regression",
    segments: {
      historyVirtualized: Array.from({ length: ROW_COUNT }, (_, index) => message(index)),
      historyMounted: [message(ROW_COUNT)],
      liveHead: [],
    },
    boundary: { hasVirtualizedHistory: true, hasMountedHistory: true, hasLiveHead: false },
    renderers: {
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: () => <div data-testid="width-regression-footer" style={FOOTER_STYLE} />,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearBottomChange: vi.fn(),
    // Intentionally no reading-position consumer: preserving the viewport must
    // not depend on an optional reporting callback being installed.
    onNearHistoryStart,
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: "epoch:80",
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
  };
  async function render(patch: Partial<StreamRenderInput> = {}, active = true) {
    input = { ...input, ...patch };
    await act(async () =>
      root.render(
        <RetainedPanelActivity active={active}>{strategy.render(input)}</RetainedPanelActivity>,
      ),
    );
    await frames();
  }
  await render();
  const scroll = container.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = (index: number) =>
    container.querySelector<HTMLElement>(`[data-history-row-id="message-${index}"]`);
  const block = () => container.querySelector<HTMLElement>("[data-index]")!.parentElement!;
  const total = () => Number.parseFloat(block().style.height);
  const offset = (index: number) =>
    row(index)!.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  const bottomDistance = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
  async function jump(index: number) {
    act(() => viewportRef.current!.scrollToMessage!(`message-${index}`));
    await expect.poll(() => row(index)).not.toBeNull();
    await expect.poll(() => Math.abs(offset(index) - 8)).toBeLessThanOrEqual(1);
    await frames();
  }
  async function measureThenUnmountFirstRow() {
    await jump(0);
    const narrowHeight = row(0)!.offsetHeight;
    expect(narrowHeight).toBeGreaterThan(ESTIMATED_HEIGHT * 2);
    await expect.poll(total).toBe((ROW_COUNT - 1) * ESTIMATED_HEIGHT + narrowHeight);
    await jump(40);
    expect(row(0)).toBeNull();
    return narrowHeight;
  }
  return {
    container,
    scroll,
    row,
    total,
    offset,
    bottomDistance,
    jump,
    render,
    input: () => input,
    viewportRef,
    onNearHistoryStart,
    measureThenUnmountFirstRow,
  };
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("invalidates a measured, unmounted narrow row before remount on a split-pane width change and keeps the reading anchor", async () => {
  const history = await mountHistory();
  await history.measureThenUnmountFirstRow();
  const before = history.offset(40);
  const windowWidth = window.innerWidth;
  for (const width of [640, 320, 560, 360, 640]) {
    const beforeTransition = history.offset(40);
    history.container.style.width = `${width}px`;
    await expect.poll(history.total).toBe(ROW_COUNT * ESTIMATED_HEIGHT);
    expect(window.innerWidth).toBe(windowWidth);
    expect(history.row(0)).toBeNull();
    await frames();
    expect(Math.abs(history.offset(40) - beforeTransition)).toBeLessThanOrEqual(1);
    expect(Math.abs(history.offset(40) - before)).toBeLessThanOrEqual(1);
  }
  expect(history.bottomDistance()).toBeGreaterThan(1000);

  await history.jump(0);
  const wideHeight = history.row(0)!.offsetHeight;
  expect(wideHeight).toBeGreaterThan(ESTIMATED_HEIGHT);
  await expect.poll(history.total).toBe((ROW_COUNT - 1) * ESTIMATED_HEIGHT + wideHeight);
  // Remeasuring at the new width must not reintroduce the narrow cached size.
  await history.jump(40);
  const wideTotal = history.total();
  history.container.style.height = "360px";
  await frames();
  expect(history.total()).toBe(wideTotal);
});

it("retains offscreen measurements for height-only, content-only, and unchanged geometry", async () => {
  const history = await mountHistory();
  const narrowHeight = await history.measureThenUnmountFirstRow();
  const expectedTotal = (ROW_COUNT - 1) * ESTIMATED_HEIGHT + narrowHeight;
  const before = history.offset(40);
  history.container.style.height = "400px";
  await frames();
  expect(history.total()).toBe(expectedTotal);
  const footer = history.container.querySelector<HTMLElement>(
    '[data-testid="width-regression-footer"]',
  )!;
  footer.style.height = "80px";
  await frames();
  expect(history.total()).toBe(expectedTotal);
  await history.render();
  await frames();
  expect(history.total()).toBe(expectedTotal);
  expect(history.row(0)).toBeNull();
  expect(Math.abs(history.offset(40) - before)).toBeLessThanOrEqual(1);
});

it("does not invalidate an inactive retained panel until it becomes active at its new width", async () => {
  const history = await mountHistory();
  const narrowHeight = await history.measureThenUnmountFirstRow();
  await history.render({}, false);
  history.container.style.width = "640px";
  await frames();
  expect(history.total()).toBe((ROW_COUNT - 1) * ESTIMATED_HEIGHT + narrowHeight);
  expect(history.row(0)).toBeNull();
  await history.render({}, true);
  await expect.poll(history.total).toBe(ROW_COUNT * ESTIMATED_HEIGHT);
  expect(history.row(0)).toBeNull();
});

it("keeps following the bottom through width invalidation and subsequent output growth", async () => {
  const history = await mountHistory();
  await history.measureThenUnmountFirstRow();
  act(() => history.viewportRef.current!.scrollToBottom());
  await frames();
  await expect.poll(() => Math.abs(history.bottomDistance())).toBeLessThanOrEqual(1);
  history.container.style.width = "640px";
  await expect.poll(history.total).toBe(ROW_COUNT * ESTIMATED_HEIGHT);
  await expect.poll(() => Math.abs(history.bottomDistance())).toBeLessThanOrEqual(1);
  expect(history.row(0)).toBeNull();
  await history.render({ segments: { ...history.input().segments, liveHead: [message(81)] } });
  await expect.poll(() => Math.abs(history.bottomDistance())).toBeLessThanOrEqual(1);
});

it("preserves a pending history prepend across width remeasurement without counting reflow as inserted history", async () => {
  const history = await mountHistory();
  await history.jump(0);
  await history.render({ hasOlderHistory: true });
  act(() => {
    history.scroll.scrollTop = 0;
    history.scroll.dispatchEvent(new Event("scroll"));
    // A prompt jump deliberately does not arm pagination. Exercise the real
    // upward intent at the history boundary before the request starts.
    history.scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
  });
  await expect.poll(() => history.onNearHistoryStart.mock.calls.length).toBe(1);
  await history.render({ isLoadingOlderHistory: true });
  const before = history.offset(0);
  history.container.style.width = "640px";
  await frames();
  expect(Math.abs(history.offset(0) - before)).toBeLessThanOrEqual(1);
  await history.render({
    segments: {
      ...history.input().segments,
      historyVirtualized: [message(-1), ...history.input().segments.historyVirtualized],
    },
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: "epoch:79",
  });
  expect(Math.abs(history.offset(0) - before)).toBeLessThanOrEqual(1);
  expect(history.onNearHistoryStart).toHaveBeenCalledOnce();
});
