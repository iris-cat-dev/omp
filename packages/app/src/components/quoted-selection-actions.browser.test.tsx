import React, { act, type ReactNode } from "react";
import type { StyleProp, View as NativeView, ViewStyle } from "react-native";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotedSelectionContextMenu } from "./quoted-selection-context-menu";

interface StaticFloatingSurfaceProps {
  children?: ReactNode;
  frameStyle?: StyleProp<ViewStyle>;
  nativeID?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-fine-pointer", () => ({
  useShowPersistentActions: () => true,
  useTouchInteraction: () => false,
  useSupportsHover: () => true,
  useHasFinePointer: () => true,
}));
// Vitest hoists this platform-module mock before static imports; dynamically
// load its rendering dependencies only inside the mock factory.
// Keep the real menu overlay and focus, replacing only the animated frame.
vi.mock("@/components/ui/floating", async () => {
  const { forwardRef } = await import("react");
  const { ScrollView, View } = await import("react-native");
  return {
    FloatingSurface: forwardRef<NativeView, StaticFloatingSurfaceProps>(
      function StaticFloatingSurface({ children, frameStyle, nativeID, style, testID }, ref) {
        return (
          <View ref={ref} nativeID={nativeID} style={[style, frameStyle]} testID={testID}>
            {children}
          </View>
        );
      },
    ),
    FloatingScrollView: ScrollView,
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function answerQuestion() {
  return "answer";
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  window.getSelection()?.removeAllRanges();
  root = null;
  container = null;
  delete window.paseoDesktop;
});

async function mountTranscript() {
  const onQuote = vi.fn();
  container = document.createElement("div");
  container.style.cssText = "width: 900px; height: 500px; display: flex";
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QuotedSelectionContextMenu onQuote={onQuote} onAsk={answerQuestion}>
        <p data-testid="transcript-text">Selected transcript text</p>
        <div
          className="cm-editor"
          contentEditable
          suppressContentEditableWarning
          data-testid="editor"
        >
          Editable source text
        </div>
      </QuotedSelectionContextMenu>,
    );
  });
  return onQuote;
}

async function selectText(element: Element) {
  await act(async () => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function getElement(selector: string): HTMLElement {
  const element = container?.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return element;
}
async function openSelectionContextMenu(): Promise<void> {
  const transcript = getElement('[data-testid="transcript-text"]');
  await selectText(transcript);
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 120,
    clientY: 120,
  });
  await act(async () => transcript.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="quoted-selection-context-menu-quote"]'),
    ).not.toBeNull();
  });
}

function menuElement(testId: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing context menu item ${testId}`);
  return node;
}

describe("explicit transcript selection actions", () => {
  it("quotes a native text selection without hover or right click", async () => {
    const onQuote = await mountTranscript();
    await selectText(getElement('[data-testid="transcript-text"]'));
    expect(window.getSelection()?.toString()).toBe("Selected transcript text");
    const quote = getElement('[data-testid="quoted-selection-action-quote"]');
    expect(quote.textContent).toBe("composer.attachments.quoteSelection");
    await act(async () => userEvent.click(quote));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("Selected transcript text");
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("quotes the captured transcript selection from a mouse right-click menu", async () => {
    const onQuote = await mountTranscript();
    await openSelectionContextMenu();
    // Focusing a native menu item may clear the DOM range before its click arrives.
    await act(async () => {
      menuElement("quoted-selection-context-menu-quote").focus();
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(window.getSelection()?.toString()).toBe("");
    await act(async () => userEvent.click(menuElement("quoted-selection-context-menu-quote")));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("Selected transcript text");
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("opens Quick Ask with the captured transcript selection from a mouse right-click menu", async () => {
    await mountTranscript();
    await openSelectionContextMenu();
    await act(async () => {
      menuElement("quoted-selection-context-menu-ask").focus();
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(window.getSelection()?.toString()).toBe("");
    await act(async () => userEvent.click(menuElement("quoted-selection-context-menu-ask")));
    await vi.waitFor(() => {
      expect(menuElement("quick-ask-popover").textContent).toContain("Selected transcript text");
    });
  });

  it("invalidates the action when selection collapses or moves outside the transcript", async () => {
    await mountTranscript();
    await selectText(getElement('[data-testid="transcript-text"]'));
    expect(container?.querySelector('[data-testid="quoted-selection-actions"]')).not.toBeNull();
    await act(async () => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(container?.querySelector('[data-testid="quoted-selection-actions"]')).toBeNull();

    await selectText(getElement('[data-testid="transcript-text"]'));
    const outside = document.createElement("p");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    try {
      await selectText(outside);
      expect(container?.querySelector('[data-testid="quoted-selection-actions"]')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it("does not hijack editor selection, native copy, or touch context menus", async () => {
    const onQuote = await mountTranscript();
    const transcript = getElement('[data-testid="transcript-text"]');
    await selectText(transcript);
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    transcript.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    const touchMenu = new PointerEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    transcript.dispatchEvent(touchMenu);
    expect(touchMenu.defaultPrevented).toBe(false);
    expect(window.getSelection()?.toString()).toBe("Selected transcript text");

    const editor = getElement('[data-testid="editor"]');
    await act(async () => editor.focus());
    await selectText(editor);
    expect(container?.querySelector('[data-testid="quoted-selection-actions"]')).toBeNull();
    expect(onQuote).not.toHaveBeenCalled();
  });

  it("refuses a stale captured action even before selectionchange is delivered", async () => {
    const onQuote = await mountTranscript();
    await selectText(getElement('[data-testid="transcript-text"]'));
    const quote = getElement('[data-testid="quoted-selection-action-quote"]');
    await act(async () => {
      window.getSelection()?.removeAllRanges();
      quote.click();
    });
    expect(onQuote).not.toHaveBeenCalled();
  });

  it("hides persistent Quote and Ask in Electron while retaining the right-click menu", async () => {
    window.paseoDesktop = { platform: "win32" };
    const onQuote = await mountTranscript();
    await openSelectionContextMenu();
    expect(container?.querySelector('[data-testid="quoted-selection-actions"]')).toBeNull();
    await act(async () => userEvent.click(menuElement("quoted-selection-context-menu-quote")));
    expect(onQuote).toHaveBeenCalledExactlyOnceWith("Selected transcript text");
  });
});
