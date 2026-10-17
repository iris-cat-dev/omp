import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_KEY,
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_CONTENT_FONT_SIZE,
  DEFAULT_UI_BASE_FONT_SIZE,
  defaultUiBaseFontSize,
  defaultContentFontSize,
  loadAppSettingsFromStorage,
  loadSettingsFromStorage,
  parseClampedFontSize,
  parseTerminalScrollbackLines,
  saveAppSettings,
  type SettingsDeps,
} from "./storage";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "./fakes";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  SIDEBAR_ROW_ITEMS,
} from "@/components/sidebar/display-preferences/row-items";
import { THEME_OPTIONS } from "@/styles/theme";

const LEGACY_SETTINGS_KEY = "@omp-desktop:settings";

function makeDeps(
  overrides: {
    storage?: ReturnType<typeof createInMemoryKeyValueStorage>;
    desktop?: ReturnType<typeof createFakeDesktopBridge>;
  } = {},
): SettingsDeps & {
  storage: ReturnType<typeof createInMemoryKeyValueStorage>;
  desktop: ReturnType<typeof createFakeDesktopBridge>;
} {
  return {
    storage: overrides.storage ?? createInMemoryKeyValueStorage(),
    desktop: overrides.desktop ?? createFakeDesktopBridge(),
  };
}

describe("loadAppSettingsFromStorage", () => {
  it("preserves a persisted steer send behavior", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        "@omp-desktop:app-settings": JSON.stringify({ sendBehavior: "steer" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).sendBehavior).toBe("steer");
  });
  it("migrates a stored interrupt to steer and persists it", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sendBehavior: "interrupt" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.sendBehavior).toBe("steer");
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "{}").sendBehavior).toBe(
      "steer",
    );
  });

  it("keeps an interrupt the user picked after the migration ran", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sendBehavior: "interrupt" }),
      }),
    });
    await loadAppSettingsFromStorage(deps);
    await saveAppSettings({
      queryClient: new QueryClient(),
      updates: { sendBehavior: "interrupt" },
      deps,
    });

    expect((await loadAppSettingsFromStorage(deps)).sendBehavior).toBe("interrupt");
  });

  it("drops a retired in-app service URL preference without losing other settings", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          serviceUrlBehavior: "in-app",
          language: "ja",
          theme: "light",
          contentFontSize: 17,
        }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result).toMatchObject({ language: "ja", theme: "light", contentFontSize: 17 });
    expect(result).not.toHaveProperty("serviceUrlBehavior");
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).not.toHaveProperty(
      "serviceUrlBehavior",
    );
  });

  it("defaults theme to dark when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.theme).toBe("dark");
  });
  it("defaults the Relay address to the hosted WSS endpoint", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.relayServerAddress).toBe("wss://relay.paseo.sh:443");
  });

  it.each(THEME_OPTIONS)("loads the persisted $name theme", async ({ name }) => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: name }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.theme).toBe(name);
  });

  it("seeds storage with the client defaults when nothing is persisted", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result).toEqual(DEFAULT_CLIENT_SETTINGS);
    expect(DEFAULT_CLIENT_SETTINGS.language).toBe("system");
    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(
      JSON.stringify(DEFAULT_CLIENT_SETTINGS),
    );
  });

  it("defaults language to system when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("system");
  });

  it("enables the chat outline by default", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.chatOutlineEnabled).toBe(true);
  });

  it("loads a disabled chat outline preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ chatOutlineEnabled: false }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.chatOutlineEnabled).toBe(false);
  });

  it("loads a disabled home animations preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ homeAnimationsEnabled: false }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.homeAnimationsEnabled).toBe(false);
  });

  it("uses the native terminal renderer by default", async () => {
    const deps = makeDeps();

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.useLegacyTerminalRenderer).toBe(false);
  });

  it("loads the per-device legacy terminal renderer preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ useLegacyTerminalRenderer: true }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.useLegacyTerminalRenderer).toBe(true);
  });

  it("loads configured terminal scrollback lines from app settings", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ terminalScrollbackLines: 42_000 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.terminalScrollbackLines).toBe(42_000);
  });

  it("removes retired sidebar choices without resetting other settings", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          workspaceTitleSource: "branch",
          sidebarWorkspaceTrailing: "none",
          theme: "light",
          language: "zh-CN",
          chatOutlineEnabled: false,
          uiBaseFontSize: 16,
          contentFontSize: 18,
        }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);
    const preserved = {
      theme: "light",
      language: "zh-CN",
      chatOutlineEnabled: false,
      uiBaseFontSize: 16,
      contentFontSize: 18,
    };
    expect(result).toMatchObject(preserved);
    expect(result).not.toHaveProperty("workspaceTitleSource");
    expect(result).not.toHaveProperty("sidebarWorkspaceTrailing");
    const persisted = JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY)!);
    expect(persisted).toMatchObject(preserved);
    expect(persisted).not.toHaveProperty("workspaceTitleSource");
    expect(persisted).not.toHaveProperty("sidebarWorkspaceTrailing");
  });

  it("normalizes terminal scrollback lines from storage", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ terminalScrollbackLines: 1_000_000.9 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.terminalScrollbackLines).toBe(1_000_000);
  });

  it("migrates the legacy theme key into the new settings object", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({
          theme: "dark",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      theme: "dark",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
    });
    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(JSON.stringify(result));
  });

  it("preserves the legacy key's explicit interface size as content size", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiBaseFontSize).toBe(17);
    expect(result.contentFontSize).toBe(17);
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toMatchObject({
      uiBaseFontSize: 17,
      contentFontSize: 17,
    });
  });

  it("preserves the legacy interface scale as content size", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [LEGACY_SETTINGS_KEY]: JSON.stringify({ uiFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiBaseFontSize).toBe(15);
    expect(result.contentFontSize).toBe(15);
    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toMatchObject({
      uiBaseFontSize: 15,
      contentFontSize: 15,
    });
  });

  it("loads a persisted explicit language", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ language: "zh-CN" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("zh-CN");
  });

  it("drops an unknown persisted language back to system", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ language: "klingon" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.language).toBe("system");
  });
});

describe("loadSettingsFromStorage", () => {
  it("defaults built-in daemon management to enabled when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadSettingsFromStorage(deps);

    expect(result).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("defaults release channel to stable when storage is empty", async () => {
    const deps = makeDeps();

    const result = await loadSettingsFromStorage(deps);

    expect(result.releaseChannel).toBe("stable");
  });

  it("ignores renderer-owned daemon management state outside Electron", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
        }),
      }),
    });

    const result = await loadSettingsFromStorage(deps);

    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
    });
  });

  it("ignores renderer-owned release channel outside Electron", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ releaseChannel: "beta" }),
      }),
    });

    const result = await loadSettingsFromStorage(deps);

    expect(result.releaseChannel).toBe("stable");
  });

  it("migrates legacy desktop-owned settings through the bridge before reading effective settings", async () => {
    const desktop = createFakeDesktopBridge({
      isElectron: true,
      settings: {
        releaseChannel: "beta",
        browser: { target: "system" },
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
        pet: { enabled: false, size: "medium", selectedId: "iris", position: null },
      },
    });
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          theme: "light",
          manageBuiltInDaemon: false,
          releaseChannel: "beta",
        }),
      }),
      desktop,
    });

    const result = await loadSettingsFromStorage(deps);

    expect(desktop.migrationsApplied).toEqual([
      { manageBuiltInDaemon: false, releaseChannel: "beta" },
    ]);
    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
      manageBuiltInDaemon: false,
      releaseChannel: "beta",
    });
  });

  it("does not call the desktop bridge outside Electron", async () => {
    const desktop = createFakeDesktopBridge({ isElectron: false });
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: "light" }),
      }),
      desktop,
    });

    const result = await loadSettingsFromStorage(deps);

    expect(desktop.migrationsApplied).toEqual([]);
    expect(result).toEqual({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
    });
  });
});

describe("saveAppSettings", () => {
  it("saves terminal scrollback through app settings persistence", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify(DEFAULT_CLIENT_SETTINGS),
      }),
    });
    const queryClient = new QueryClient();

    await saveAppSettings({
      queryClient,
      updates: { terminalScrollbackLines: 42_000 },
      deps,
    });

    expect(deps.storage.entries.get(APP_SETTINGS_KEY)).toBe(
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        terminalScrollbackLines: 42_000,
      }),
    );
  });

  it("normalizes a legacy cached settings shape before saving", async () => {
    const deps = makeDeps();
    const queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
      theme: "dark",
      compactToolCalls: true,
    });

    await saveAppSettings({
      queryClient,
      updates: { theme: "light" },
      deps,
    });

    expect(JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null")).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      theme: "light",
      contentFontSize: DEFAULT_UI_BASE_FONT_SIZE,
      toolCallDetailLevel: "overview",
    });
  });

  it("persists a selected plugin theme", async () => {
    const deps = makeDeps();
    const queryClient = new QueryClient();

    await saveAppSettings({
      queryClient,
      updates: { theme: "plugin", pluginThemeId: "catppuccin/theme/mocha" },
      deps,
    });

    const loaded = await loadAppSettingsFromStorage(deps);
    expect(loaded.theme).toBe("plugin");
    expect(loaded.pluginThemeId).toBe("catppuccin/theme/mocha");
  });

  // The row items are written as one object through one strict schema, so an item the schema
  // does not know does not just fail to persist itself — it takes every sibling toggle with it.
  it.each(SIDEBAR_ROW_ITEMS)("persists the %s row item being switched off", async (item) => {
    const deps = makeDeps();
    const queryClient = new QueryClient();
    const sidebarRowItems = { ...DEFAULT_SIDEBAR_ROW_ITEMS, [item]: false };

    await saveAppSettings({ queryClient, updates: { sidebarRowItems }, deps });

    expect((await loadAppSettingsFromStorage(deps)).sidebarRowItems).toEqual(sidebarRowItems);
  });

  it("serializes concurrent saves so a later field update cannot erase an earlier one", async () => {
    const entries = new Map<string, string>([
      [APP_SETTINGS_KEY, JSON.stringify(DEFAULT_CLIENT_SETTINGS)],
    ]);
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    let setCalls = 0;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const deps = makeDeps({
      storage: {
        entries,
        async getItem(key) {
          return entries.get(key) ?? null;
        },
        async setItem(key, value) {
          setCalls += 1;
          if (setCalls === 1) {
            markFirstWriteStarted();
            await firstWrite;
          }
          entries.set(key, value);
        },
        async removeItem(key) {
          entries.delete(key);
        },
      },
    });
    const queryClient = new QueryClient();

    const first = saveAppSettings({ queryClient, updates: { theme: "light" }, deps });
    const second = saveAppSettings({
      queryClient,
      updates: { syntaxTheme: "dracula" },
      deps,
    });
    await firstWriteStarted;
    expect(setCalls).toBe(1);

    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(JSON.parse(entries.get(APP_SETTINGS_KEY) ?? "null")).toMatchObject({
      theme: "light",
      syntaxTheme: "dracula",
    });
  });

  it("rejects non-finite and out-of-range wallpaper opacity values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          ...DEFAULT_CLIENT_SETTINGS,
          wallpaperOpacity: 3,
        }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).wallpaperOpacity).toBe(
      DEFAULT_CLIENT_SETTINGS.wallpaperOpacity,
    );
  });
});

describe("parseTerminalScrollbackLines", () => {
  it("clamps negative values to the minimum and rejects non-numeric strings", () => {
    expect(parseTerminalScrollbackLines("-10")).toBe(0);
    expect(parseTerminalScrollbackLines("abc")).toBeNull();
  });
});

describe("appearance settings", () => {
  it("defaults the appearance fields when an old blob omits them", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ theme: "dark" }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);

    expect(result.uiFontFamily).toBe("");
    expect(result.monoFontFamily).toBe("");
    expect(result.uiBaseFontSize).toBe(DEFAULT_UI_BASE_FONT_SIZE);
    expect(result.contentFontSize).toBe(DEFAULT_UI_BASE_FONT_SIZE);
    expect(result.codeFontSize).toBe(DEFAULT_CODE_FONT_SIZE);
    expect(result.syntaxTheme).toBe("cursor");
    expect(result.toolCallDetailLevel).toBe("detailed");
  });

  it("migrates the enabled compact tool call preference to overview", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ compactToolCalls: true }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).toolCallDetailLevel).toBe("overview");
  });

  it("clears settings with an unrecognized tool call detail level", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ toolCallDetailLevel: "unknown" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).toolCallDetailLevel).toBe("detailed");
  });

  it("migrates a switched-off checks row item to the hidden checks display", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ sidebarRowItems: { checks: false } }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).sidebarChecksDisplay).toBe("none");
  });

  it("lets a stored checks display win over the row item it replaced", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          sidebarChecksDisplay: "icon",
          sidebarRowItems: { checks: false },
        }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).sidebarChecksDisplay).toBe("icon");
  });

  it("uses a 13px interface default on mobile and web", () => {
    expect(defaultUiBaseFontSize(true)).toBe(13);
    expect(defaultUiBaseFontSize(false)).toBe(13);
  });

  it("uses a 14px content default on web and keeps 15px on mobile", () => {
    expect(defaultContentFontSize(true)).toBe(15);
    expect(defaultContentFontSize(false)).toBe(14);
    expect(DEFAULT_CONTENT_FONT_SIZE).toBe(defaultContentFontSize(false));
  });

  it("derives and persists content size from an existing interface-size preference", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 17 }),
      }),
    });

    const result = await loadAppSettingsFromStorage(deps);
    const persisted = JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null");

    expect(result.contentFontSize).toBe(17);
    expect(persisted).toMatchObject({ uiBaseFontSize: 17, contentFontSize: 17 });
  });

  it("clamps the content font size into range and rejects non-numeric values", async () => {
    const high = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(high)).contentFontSize).toBe(21);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).contentFontSize).toBe(10);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ contentFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).contentFontSize).toBe(
      DEFAULT_CONTENT_FONT_SIZE,
    );
  });

  it.each([
    { legacySize: 16, baseSize: 14 },
    { legacySize: 17, baseSize: 15 },
    { legacySize: 18, baseSize: 16 },
  ])(
    "migrates legacy interface size $legacySize to base size $baseSize",
    async ({ legacySize, baseSize }) => {
      const deps = makeDeps({
        storage: createInMemoryKeyValueStorage({
          [APP_SETTINGS_KEY]: JSON.stringify({ uiFontSize: legacySize }),
        }),
      });

      const result = await loadAppSettingsFromStorage(deps);
      const persisted = JSON.parse(deps.storage.entries.get(APP_SETTINGS_KEY) ?? "null");

      expect(result.uiBaseFontSize).toBe(baseSize);
      expect(persisted).toMatchObject({ uiBaseFontSize: baseSize });
      expect(persisted).not.toHaveProperty("uiFontSize");
    },
  );

  it("lets an explicit base size win over the legacy interface scale", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 16, uiFontSize: 17 }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiBaseFontSize).toBe(16);
  });

  it("clamps the UI base font size into range and rejects non-numeric values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).uiBaseFontSize).toBe(21);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).uiBaseFontSize).toBe(10);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiBaseFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).uiBaseFontSize).toBe(
      DEFAULT_UI_BASE_FONT_SIZE,
    );
  });

  it("clamps the code font size into range and rejects non-numeric values", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: 999 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(deps)).codeFontSize).toBe(22);

    const low = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: 8 }),
      }),
    });
    expect((await loadAppSettingsFromStorage(low)).codeFontSize).toBe(9);

    const bogus = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ codeFontSize: "abc" }),
      }),
    });
    expect((await loadAppSettingsFromStorage(bogus)).codeFontSize).toBe(DEFAULT_CODE_FONT_SIZE);
  });

  it("trims an accepted font family", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "  Menlo  " }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("Menlo");
  });

  it("keeps an explicit empty font family as the default sentinel", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("rejects a font family containing CSS-breaking characters", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "a;b{c}" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("rejects an over-length font family", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ uiFontFamily: "a".repeat(201) }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).uiFontFamily).toBe("");
  });

  it("accepts a known syntax theme id", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "dracula" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("dracula");
  });

  it("drops a removed syntax theme id back to the default", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "auto" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("cursor");
  });

  it("drops an unknown syntax theme id back to the default", async () => {
    const deps = makeDeps({
      storage: createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({ syntaxTheme: "bogus" }),
      }),
    });

    expect((await loadAppSettingsFromStorage(deps)).syntaxTheme).toBe("cursor");
  });
});

describe("parseClampedFontSize", () => {
  it("clamps to the bounds and rejects non-numeric strings", () => {
    expect(parseClampedFontSize(999, { min: 11, max: 24 })).toBe(24);
    expect(parseClampedFontSize(8, { min: 11, max: 24 })).toBe(11);
    expect(parseClampedFontSize("15", { min: 11, max: 24 })).toBe(15);
    expect(parseClampedFontSize("abc", { min: 11, max: 24 })).toBeNull();
  });
});

describe("wallpaper migration through the real app settings loader", () => {
  const importedId = "0199ef80-5ff5-7000-8000-000000000001";
  const selectedId = "0199ef80-5ff5-7000-8000-000000000002";
  const oldWallpaper = {
    wallpaperEnabled: true,
    wallpaperSource: "file",
    wallpaperDir: "C:/wallpapers",
    wallpaperPath: "C:/wallpapers/a.png",
    language: "ja",
    sendBehavior: "interrupt",
  };

  it("keeps the raw path through needsWrite and other migrations until binding is confirmed", async () => {
    const storage = createInMemoryKeyValueStorage({
      [APP_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
    });
    let complete!: (value: { candidateId: string; reason: null }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const binding = new Promise<{ candidateId: string; reason: null }>((resolve) => {
      complete = resolve;
    });
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        async importLegacy() {
          entered();
          return binding;
        },
      },
    };
    const load = loadAppSettingsFromStorage(deps);
    await started;
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).toMatchObject({
      ...oldWallpaper,
      sendBehavior: "steer",
    });
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty(
      "wallpaperCandidateId",
    );
    complete({ candidateId: importedId, reason: null });
    expect((await load).wallpaperCandidateId).toBe(importedId);
    const persisted = JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!);
    expect(persisted.wallpaperCandidateId).toBe(importedId);
    expect(persisted).not.toHaveProperty("wallpaperPath");
    expect(persisted).not.toHaveProperty("wallpaperDir");
  });

  it("does not wait for local migration before using URL settings or saving ordinary edits", async () => {
    const storage = createInMemoryKeyValueStorage({
      [APP_SETTINGS_KEY]: JSON.stringify({
        ...oldWallpaper,
        wallpaperSource: "url",
        wallpaperUrl: "https://example.com/a.webm",
      }),
    });
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        importLegacy() {
          return new Promise<never>(() => {});
        },
      },
    };
    const loaded = await loadAppSettingsFromStorage(deps);
    expect(loaded).toMatchObject({
      language: "ja",
      wallpaperSource: "url",
      wallpaperUrl: "https://example.com/a.webm",
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, loaded);
    await saveAppSettings({ deps, queryClient, updates: { theme: "light" } });
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).toMatchObject({
      wallpaperPath: oldWallpaper.wallpaperPath,
      wallpaperDir: oldWallpaper.wallpaperDir,
      wallpaperUrl: "https://example.com/a.webm",
      theme: "light",
    });
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty(
      "wallpaperCandidateId",
    );
  });

  it.each([null, selectedId])(
    "does not overwrite a new explicit choice %s with a late binding",
    async (choice) => {
      const storage = createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
      });
      let complete!: (value: { candidateId: string; reason: null }) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const binding = new Promise<{ candidateId: string; reason: null }>((resolve) => {
        complete = resolve;
      });
      const deps: SettingsDeps = {
        storage,
        desktop: createFakeDesktopBridge({ isElectron: true }),
        wallpaper: {
          async importLegacy() {
            entered();
            return binding;
          },
        },
      };
      const loading = loadAppSettingsFromStorage(deps);
      await started;
      const queryClient = new QueryClient();
      queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
      await saveAppSettings({ deps, queryClient, updates: { wallpaperCandidateId: choice } });
      complete({ candidateId: importedId, reason: null });
      expect((await loading).wallpaperCandidateId).toBe(choice);
      expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!).wallpaperCandidateId).toBe(choice);
    },
  );

  it("retries the first main-process binding after the renderer write failed", async () => {
    const storage = createInMemoryKeyValueStorage({
      [APP_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
    });
    const write = storage.setItem.bind(storage);
    let failBindingWrite = true;
    storage.setItem = async (key, value) => {
      if (
        key === APP_SETTINGS_KEY &&
        JSON.parse(value).wallpaperCandidateId === importedId &&
        failBindingWrite
      ) {
        failBindingWrite = false;
        throw new Error("disk full");
      }
      await write(key, value);
    };
    // The desktop store owns the fixed first binding even if that item was since removed.
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        async importLegacy() {
          return { candidateId: importedId, reason: null };
        },
      },
    };
    expect((await loadAppSettingsFromStorage(deps)).wallpaperCandidateId).toBeNull();
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!).wallpaperPath).toBe(
      oldWallpaper.wallpaperPath,
    );
    expect((await loadAppSettingsFromStorage(deps)).wallpaperCandidateId).toBe(importedId);
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty("wallpaperPath");
  });

  it.each([{}, { wallpaperPath: "C:/missing.png", wallpaperDir: "C:/" }, { wallpaperPath: 42 }])(
    "seals empty or invalid legacy input once without discarding ordinary settings",
    async (legacyInput) => {
      const storage = createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          language: "ja",
          ...legacyInput,
        }),
      });
      let calls = 0;
      const deps: SettingsDeps = {
        storage,
        desktop: createFakeDesktopBridge({ isElectron: true }),
        wallpaper: {
          async importLegacy() {
            calls += 1;
            return { candidateId: null, reason: "invalid-file" };
          },
        },
      };
      expect(await loadAppSettingsFromStorage(deps)).toMatchObject({
        language: "ja",
        wallpaperCandidateId: null,
      });
      await loadAppSettingsFromStorage(deps);
      expect(calls).toBe(1);
      expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty(
        "wallpaperPath",
      );
    },
  );

  it("respects persisted explicit null and normalizes a corrupt candidate without resetting URL settings", async () => {
    for (const candidateId of [null, 42, "not-a-uuid"]) {
      const storage = createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify({
          ...oldWallpaper,
          wallpaperCandidateId: candidateId,
          wallpaperSource: "url",
          wallpaperUrl: "https://example.com/a.png",
        }),
      });
      const deps: SettingsDeps = {
        storage,
        desktop: createFakeDesktopBridge({ isElectron: true }),
        wallpaper: {
          async importLegacy() {
            throw new Error("must not rebind an explicit choice");
          },
        },
      };
      expect(await loadAppSettingsFromStorage(deps)).toMatchObject({
        language: "ja",
        wallpaperCandidateId: null,
        wallpaperUrl: "https://example.com/a.png",
      });
      expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty(
        "wallpaperPath",
      );
    }
  });

  it("imports the old renderer key without dropping its only media path during normalization", async () => {
    const storage = createInMemoryKeyValueStorage({
      [LEGACY_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
    });
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        async importLegacy() {
          return { candidateId: importedId, reason: null };
        },
      },
    };
    expect(await loadAppSettingsFromStorage(deps)).toMatchObject({
      wallpaperEnabled: true,
      wallpaperSource: "file",
      wallpaperCandidateId: importedId,
    });
    const persisted = JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!);
    expect(persisted.wallpaperCandidateId).toBe(importedId);
    expect(persisted).not.toHaveProperty("wallpaperPath");
    expect(persisted).not.toHaveProperty("wallpaperDir");
  });

  it("retries a deferred URL migration on entering local mode and keeps ordinary edits", async () => {
    const storage = createInMemoryKeyValueStorage({
      [APP_SETTINGS_KEY]: JSON.stringify({
        ...oldWallpaper,
        wallpaperSource: "url",
        wallpaperUrl: "https://example.com/a.webm",
      }),
    });
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        async importLegacy() {
          return { candidateId: importedId, reason: null };
        },
      },
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, await loadAppSettingsFromStorage(deps));
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).not.toHaveProperty(
      "wallpaperCandidateId",
    );
    await saveAppSettings({
      deps,
      queryClient,
      updates: { wallpaperSource: "file", theme: "light" },
    });
    expect(await loadAppSettingsFromStorage(deps)).toMatchObject({
      wallpaperCandidateId: importedId,
      wallpaperSource: "file",
      theme: "light",
      language: "ja",
    });
  });

  it("returns ordinary settings without deleting legacy input when local import fails", async () => {
    const storage = createInMemoryKeyValueStorage({
      [APP_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
    });
    const deps: SettingsDeps = {
      storage,
      desktop: createFakeDesktopBridge({ isElectron: true }),
      wallpaper: {
        async importLegacy() {
          throw new Error("library read failed");
        },
      },
    };
    expect(await loadAppSettingsFromStorage(deps)).toMatchObject({
      language: "ja",
      wallpaperSource: "file",
      wallpaperCandidateId: null,
    });
    expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!).wallpaperPath).toBe(
      oldWallpaper.wallpaperPath,
    );
  });

  it.each(["import", "binding write"] as const)(
    "keeps newer ordinary edits when a pending wallpaper %s fails",
    async (failureStage) => {
      const storage = createInMemoryKeyValueStorage({
        [APP_SETTINGS_KEY]: JSON.stringify(oldWallpaper),
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = storage.setItem.bind(storage);
      storage.setItem = async (key, value) => {
        if (
          failureStage === "binding write" &&
          key === APP_SETTINGS_KEY &&
          JSON.parse(value).wallpaperCandidateId === importedId
        ) {
          throw new Error("binding write failed");
        }
        await write(key, value);
      };
      const deps: SettingsDeps = {
        storage,
        desktop: createFakeDesktopBridge({ isElectron: true }),
        wallpaper: {
          async importLegacy() {
            entered.resolve();
            await release.promise;
            if (failureStage === "import") throw new Error("import failed");
            return { candidateId: importedId, reason: null };
          },
        },
      };
      const queryClient = new QueryClient();
      const initial = await loadAppSettingsFromStorage({ ...deps, wallpaper: undefined });
      queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, initial);
      const loading = loadAppSettingsFromStorage(deps);
      await entered.promise;
      const updates = {
        theme: "light",
        wallpaperSource: "url",
        wallpaperEnabled: false,
        wallpaperUrl: "https://example.com/new.webm",
      } as const;
      await saveAppSettings({ deps, queryClient, updates });
      release.resolve();
      const loaded = await loading;
      expect(loaded).toMatchObject(updates);
      // React Query publishes the completed load, so a subsequent edit must not persist a rollback.
      queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, loaded);
      await saveAppSettings({ deps, queryClient, updates: { wallpaperOpacity: 0.5 } });
      expect(JSON.parse(storage.entries.get(APP_SETTINGS_KEY)!)).toMatchObject({
        ...updates,
        wallpaperOpacity: 0.5,
        wallpaperPath: oldWallpaper.wallpaperPath,
        wallpaperDir: oldWallpaper.wallpaperDir,
      });
    },
  );
});
