import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@gorhom/bottom-sheet", () => ({
  useBottomSheetModalInternal: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & { testID?: string }
    >(function AnimatedView(
      { children, testID, onPointerEnter, onPointerLeave, onFocus, onBlur },
      ref,
    ) {
      return (
        <div
          ref={ref}
          data-testid={testID}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {children}
        </div>
      );
    }),
  },
  FadeIn: { duration: () => undefined },
  FadeOut: { duration: () => undefined },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderTrigger({
  childDisabled,
  onPress,
}: {
  childDisabled: boolean;
  onPress: () => void;
}): void {
  act(() => {
    root?.render(
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable disabled={childDisabled} onPress={onPress} testID="trigger">
            <Text>Send</Text>
          </Pressable>
        </TooltipTrigger>
      </Tooltip>,
    );
  });
}

function pressTrigger(): void {
  const trigger = container?.querySelector('[data-testid="trigger"]');
  expect(trigger).not.toBeNull();

  act(() => {
    trigger?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("TooltipTrigger", () => {
  it("keeps an asChild trigger disabled when the child is disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: true, onPress });
    pressTrigger();

    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps an asChild trigger interactive when the child is not disabled", () => {
    const onPress = vi.fn();

    renderTrigger({ childDisabled: false, onPress });
    pressTrigger();

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("opens and closes a wide-layout tooltip on a direct press", () => {
    const onOpenChange = vi.fn();
    act(() => {
      root?.render(
        <Tooltip openOnPress onOpenChange={onOpenChange}>
          <TooltipTrigger testID="trigger">
            <Text>Context window</Text>
          </TooltipTrigger>
        </Tooltip>,
      );
    });

    pressTrigger();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    pressTrigger();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps its action reachable across the hover gap and dismisses on Escape or outside input", async () => {
    vi.useFakeTimers();
    const onPress = vi.fn();
    await act(async () => {
      root?.render(
        <Tooltip interactive openOnPress>
          <TooltipTrigger testID="trigger">
            <Text>Context window</Text>
          </TooltipTrigger>
          <TooltipContent testID="content">
            <Pressable testID="action" onPress={onPress}>
              <Text>Prompt analysis</Text>
            </Pressable>
          </TooltipContent>
        </Tooltip>,
      );
    });
    pressTrigger();
    await act(async () => {});
    const trigger = container!.querySelector('[data-testid="trigger"]')!;
    act(() => {
      trigger.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true }));
      trigger.dispatchEvent(new window.MouseEvent("pointerout", { bubbles: true }));
      vi.advanceTimersByTime(100);
    });
    const content = document.querySelector('[data-testid="content"]')!;
    act(() => {
      content.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    const action = document.querySelector('[data-testid="action"]')!;
    act(() => action.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    expect(onPress).toHaveBeenCalledOnce();
    act(() =>
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[data-testid="action"]')).toBeNull();
    pressTrigger();
    await act(async () => {});
    expect(document.querySelector('[data-testid="action"]')).not.toBeNull();
    act(() => document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })));
    expect(document.querySelector('[data-testid="action"]')).toBeNull();
  });

  it("moves keyboard focus into its action and restores the trigger on Escape", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root?.render(
        <Tooltip interactive defaultOpen>
          <TooltipTrigger testID="trigger" accessibilityRole="button">
            <Text>Context window</Text>
          </TooltipTrigger>
          <TooltipContent testID="content">
            <Pressable testID="action" accessibilityRole="button">
              <Text>Prompt analysis</Text>
            </Pressable>
          </TooltipContent>
        </Tooltip>,
      );
    });
    const trigger = container!.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    const action = document.querySelector<HTMLElement>('[data-testid="action"]')!;
    act(() => trigger.focus());
    const tab = new window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => trigger.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(action);
    act(() => vi.advanceTimersByTime(300));
    expect(document.activeElement).toBe(action);
    expect(document.querySelector('[data-testid="action"]')).toBe(action);
    act(() =>
      action.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[data-testid="action"]')).toBeNull();
  });
});
