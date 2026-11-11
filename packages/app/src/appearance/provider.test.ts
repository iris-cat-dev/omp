// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { darkTheme, REGISTERED_THEMES, type Theme } from "@/styles/theme";
import { AppearanceProvider, type ContributedThemeOption } from "./provider";
import { withUnistyles } from "react-native-unistyles";

const state = vi.hoisted(() => ({
  themes: {} as Record<string, Theme>,
  active: "dark",
  listeners: new Set<() => void>(),
  selected: null as ContributedThemeOption | null,
  background: { status: "disabled", opacity: 0.85 },
  settings: { theme: "dark", uiFontFamily: "", monoFontFamily: "", uiBaseFontSize: 13, contentFontSize: 15, codeFontSize: 13, syntaxTheme: "one" },
}));
vi.mock("@/hooks/use-settings", () => ({
  DEFAULT_THEME_PREFERENCE: "dark",
  useAppSettings: () => ({ settings: state.settings, isLoading: false }),
}));
vi.mock("@/plugins/background", () => ({ usePluginBackgroundState: () => state.background }));
vi.mock("@/plugins/themes", () => ({ useContributedPluginThemes: () => ({ sources: state.selected ? [state.selected] : [], selected: state.selected, select: async () => {} }) }));
vi.mock("./apply-root-font", () => ({ applyRootUiFont: () => {} }));
vi.mock("react-native-unistyles", () => {
  const notify = () => { for (const listener of state.listeners) listener(); };
  return {
    UnistylesRuntime: {
      get themeName() { return state.active; },
      updateTheme(key: string, update: (theme: Theme) => Theme) { state.themes[key] = update(state.themes[key]!); notify(); },
      setAdaptiveThemes() {},
      setTheme(key: string) { state.active = key; notify(); },
    },
    withUnistyles: (Component: ComponentType<Record<string, unknown>>, mapping: (theme: Theme) => Record<string, unknown>) =>
      function ThemedConsumer(props: Record<string, unknown>) {
        const theme = useSyncExternalStore(
          (listener) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
          () => state.themes[state.active]!,
        );
        return createElement(Component, { ...props, ...mapping(theme) });
      },
  };
});

function Editor({ foreground, background }: { foreground?: string; background?: string }) {
  return createElement("textarea", { "aria-label": "Message draft", defaultValue: "", style: { color: foreground, backgroundColor: background } });
}
const ThemedEditor = withUnistyles(Editor, (theme) => ({ foreground: theme.colors.foreground, background: theme.colors.surface1 }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.themes = { ...REGISTERED_THEMES };
  state.active = "dark";
  state.selected = null;
  state.settings = { ...state.settings, theme: "dark" };
  state.background = { status: "disabled", opacity: 0.85 };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function renderEditor() {
  await act(async () => root.render(createElement(AppearanceProvider, null, createElement(ThemedEditor))));
}

describe("appearance consumers", () => {
  it("preserves input identity, draft, focus, selection and scroll while theme and opacity update", async () => {
    await renderEditor();
    const input = container.querySelector("textarea")!;
    input.value = "draft stays across appearance changes";
    input.focus();
    input.setSelectionRange(6, 17);
    input.scrollTop = 24;
    const previousColor = input.style.color;
    state.settings = { ...state.settings, theme: "light" };
    await renderEditor();
    expect(input.style.color).not.toBe(previousColor);
    for (const opacity of [0, 0.85, 1]) {
      state.background = { status: "ready", opacity };
      await renderEditor();
      expect(container.querySelector("textarea")).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("draft stays across appearance changes");
      expect([input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual([6, 17, 24]);
    }
  });

  it("uses a replacement plugin palette instead of its first cached slot colors", async () => {
    state.settings = { ...state.settings, theme: "plugin" };
    const select = (foreground: string, surface1: string): ContributedThemeOption => ({
      id: "review/theme/dark", serverId: "host", owner: "daemon", name: "Review", swatch: surface1,
      theme: { ...darkTheme, colors: { ...darkTheme.colors, foreground, surface1 } },
    });
    state.selected = select("#123456", "#234567");
    await renderEditor();
    const input = container.querySelector("textarea")!;
    expect(input.style.color).toBe("rgb(18, 52, 86)");
    state.selected = select("#abcdef", "#456789");
    await renderEditor();
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.style.color).toBe("rgb(171, 205, 239)");
    expect(input.style.backgroundColor).toBe("rgb(69, 103, 137)");
  });
});
