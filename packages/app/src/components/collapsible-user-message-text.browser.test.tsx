import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsibleUserMessageText } from "./collapsible-user-message-text";
import type { StyleSheet as ThemeStyleSheet } from "react-native-unistyles";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", async (importOriginal) => {
  const actual = await importOriginal<{ StyleSheet: typeof ThemeStyleSheet }>();
  return {
    ...actual,
    StyleSheet: {
      ...actual.StyleSheet,
      create: (styles: unknown) =>
        actual.StyleSheet.create((theme) =>
          typeof styles === "function"
            ? styles({ ...theme, fontSize: { ...theme.fontSize, content: 14 } })
            : styles,
        ),
    },
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const textStyle = { fontSize: 14 };

function element(testID: string): HTMLElement {
  const result = container?.querySelector(`[data-testid="${testID}"]`);
  if (!(result instanceof HTMLElement)) throw new Error(`Missing ${testID}`);
  return result;
}

function toggle(): HTMLElement | null {
  return container?.querySelector('[data-testid="user-message-text-toggle"]') ?? null;
}

async function renderMessage(message: string, width = 240) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  container.style.width = `${width}px`;
  await act(async () => {
    root?.render(
      <CollapsibleUserMessageText message={message} style={textStyle} testID="message-full-text" />,
    );
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("user message text disclosure", () => {
  it("leaves short text fully visible without a disclosure control", async () => {
    await renderMessage("A short message");
    await vi.waitFor(() => {
      expect(element("message-full-text").getBoundingClientRect().height).toBeGreaterThan(0);
    });
    expect(toggle()).toBeNull();
    expect(element("user-message-text-viewport").getBoundingClientRect().height).toBe(
      element("message-full-text").getBoundingClientRect().height,
    );
  });

  it("clips multiline text, supports keyboard expansion and collapse, and resets edited content", async () => {
    const message = Array.from({ length: 9 }, (_, index) => `Line ${index}`).join("\n");
    await renderMessage(message);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
    const fullHeight = element("message-full-text").getBoundingClientRect().height;
    expect(element("user-message-text-viewport").getBoundingClientRect().height).toBeLessThan(
      fullHeight,
    );
    expect(element("message-full-text").textContent).toBe(message);

    toggle()?.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
    expect(element("user-message-text-viewport").getBoundingClientRect().height).toBe(fullHeight);

    await userEvent.keyboard(" ");
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
    await userEvent.click(element("user-message-text-toggle"));
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
    await renderMessage(message.replaceAll("Line", "Text"));
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
  });

  it("remeasures a wrapped single line when its available width changes", async () => {
    const message = "unbroken".repeat(70);
    await renderMessage(message, 2000);
    await vi.waitFor(() =>
      expect(element("message-full-text").getBoundingClientRect().width).toBe(2000),
    );
    expect(toggle()).toBeNull();

    await renderMessage(message, 180);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
    await userEvent.click(element("user-message-text-toggle"));
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
    expect(element("message-full-text").textContent).toBe(message);

    await renderMessage(message, 2000);
    await vi.waitFor(() => expect(toggle()).toBeNull());
    await renderMessage(message, 180);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
  });
});
