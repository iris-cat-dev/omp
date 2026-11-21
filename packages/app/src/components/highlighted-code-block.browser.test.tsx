import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighlightedCodeBlock } from "./highlighted-code-block";

const state = vi.hoisted(() => ({ persistentActions: true, copy: vi.fn() }));
vi.mock("@/hooks/use-fine-pointer", () => ({
  useShowPersistentActions: () => state.persistentActions,
  useTouchInteraction: () => false,
  useSupportsHover: () => true,
  useHasFinePointer: () => true,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: state.copy }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const inheritedStyles = {};
const textStyle = { backgroundColor: "#27272a", padding: 8 };
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.persistentActions = true;
  state.copy.mockClear();
});

async function mountCode() {
  container = document.createElement("div");
  container.style.width = "900px";
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <HighlightedCodeBlock
        code={"echo hello\n\n"}
        language="text"
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />,
    ),
  );
  const button = container.querySelector('[aria-label="message.actions.copyCode"]');
  if (!(button instanceof HTMLElement)) throw new Error("Missing code Copy button");
  return button;
}

describe("code Copy affordance", () => {
  it("is discoverable and copies on a wide persistent-actions surface without hover", async () => {
    const button = await mountCode();
    expect(getComputedStyle(button).opacity).toBe("1");
    expect(getComputedStyle(button).pointerEvents).not.toBe("none");
    await userEvent.click(button);
    expect(state.copy).toHaveBeenCalledExactlyOnceWith("echo hello");
  });

  it("keeps mouse-only controls non-interactive while hidden and reveals keyboard focus", async () => {
    state.persistentActions = false;
    const button = await mountCode();
    expect(getComputedStyle(button).opacity).toBe("0");
    expect(getComputedStyle(button).pointerEvents).toBe("none");
    await act(async () => button.focus());
    expect(getComputedStyle(button).opacity).toBe("1");
    expect(getComputedStyle(button).pointerEvents).not.toBe("none");
  });
});
