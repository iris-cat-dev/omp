/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  resetRuntimePointerModalityForTests,
  useHasFinePointer,
  useSupportsHover,
  useTouchInteraction,
} from "./use-fine-pointer";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/desktop/host", () => ({
  isElectronRuntime: () => false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

let latest: {
  touch: boolean;
  hover: boolean;
  fine: boolean;
} = { touch: false, hover: true, fine: true };

function Probe() {
  const touch = useTouchInteraction();
  const hover = useSupportsHover();
  const fine = useHasFinePointer();
  latest = { touch, hover, fine };
  return null;
}

function stubMedia(matchesByQuery: Record<string, boolean>): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: Boolean(matchesByQuery[query]),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  useSidebarViewStore.setState({ touchMode: "auto" });
  resetRuntimePointerModalityForTests();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 0,
  });
  stubMedia({
    "(hover: hover) and (pointer: fine)": true,
    "(hover: hover)": true,
    "(pointer: coarse)": false,
    "(any-pointer: coarse)": false,
  });
});

afterEach(() => {
  cleanup();
  useSidebarViewStore.setState({ touchMode: "auto" });
  resetRuntimePointerModalityForTests();
  vi.unstubAllGlobals();
});

describe("useTouchInteraction / useSupportsHover / useHasFinePointer", () => {
  it("switches into touch mode on iPadOS desktop Safari regardless of viewport width", () => {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    stubMedia({
      "(hover: hover) and (pointer: fine)": false,
      "(hover: hover)": false,
      "(pointer: coarse)": true,
      "(any-pointer: coarse)": true,
    });

    render(<Probe />);
    expect(latest).toEqual({ touch: true, hover: false, fine: false });
  });

  it("reacts to runtime touch pointerdown on desktop UA and reverts on mouse pointerdown", () => {
    render(<Probe />);
    expect(latest).toEqual({ touch: false, hover: true, fine: true });

    act(() => {
      const touchDown = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(touchDown, "pointerType", { value: "touch" });
      window.dispatchEvent(touchDown);
    });
    expect(latest).toEqual({ touch: true, hover: false, fine: false });

    act(() => {
      const mouseDown = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(mouseDown, "pointerType", { value: "mouse" });
      window.dispatchEvent(mouseDown);
    });
    expect(latest).toEqual({ touch: false, hover: true, fine: true });
  });

  it("honors explicit touchMode on/off overrides over environment and runtime signals", () => {
    render(<Probe />);
    expect(latest.touch).toBe(false);

    act(() => {
      useSidebarViewStore.getState().setTouchMode("on");
    });
    expect(latest).toEqual({ touch: true, hover: false, fine: false });

    act(() => {
      const touchDown = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(touchDown, "pointerType", { value: "touch" });
      window.dispatchEvent(touchDown);
      useSidebarViewStore.getState().setTouchMode("off");
    });
    expect(latest).toEqual({ touch: false, hover: true, fine: true });
  });
});
