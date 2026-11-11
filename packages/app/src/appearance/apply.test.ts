import { beforeEach, describe, expect, it, vi } from "vitest";
import { darkHighlightColors, resolveSyntaxColors } from "@omp-desktop/highlight";
import { DEFAULT_UI_FONT_STACK, REGISTERED_THEMES, type Theme } from "@/styles/theme";
import { setCssColorAlpha } from "@/appearance/color"
import { applyAppearance, type AppearanceInput } from "./apply";

// Override the global react-native-unistyles mock (vitest.setup.ts) so that
// UnistylesRuntime.updateTheme is a spy that records (themeName, updater) calls.
const { runtime, updateTheme } = vi.hoisted(() => {
  const updateThemeSpy = vi.fn();
  return {
    runtime: { themeName: undefined as string | undefined, updateTheme: updateThemeSpy },
    updateTheme: updateThemeSpy,
  };
});
vi.mock("react-native-unistyles", () => ({ UnistylesRuntime: runtime }));

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES);

// The signature of the updater passed to UnistylesRuntime.updateTheme.
type ThemeUpdater = (theme: FakeTheme) => FakeTheme;

// The subset of the theme shape the updater reads / spreads. The real Theme type
// is a frozen `as const` literal; the updater only touches these fields. Casting a
// fake of this shape through `unknown` to ThemeUpdater's param is test-only.
interface FakeTheme {
  colorScheme: "light" | "dark";
  fontFamily: { ui: string; mono: string };
  fontSize: {
    code: number;
    content: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
    "4xl": number;
  };
  lineHeight: { diff: number };
  colors: Theme["colors"];
}

function makeFakeTheme(): FakeTheme {
  return {
    colorScheme: "dark",
    fontFamily: { ui: "seed-ui-stack", mono: "seed-mono-stack" },
    fontSize: {
      code: 13,
      content: 15,
      sm: 12,
      base: 13,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    },
    lineHeight: { diff: 22 },
    colors: { ...REGISTERED_THEMES.dark.colors },
  };
}

function makeInput(overrides: Partial<AppearanceInput> = {}): AppearanceInput {
  return {
    uiFontFamily: "",
    monoFontFamily: "",
    uiBaseFontSize: 13,
    contentFontSize: 15,
    codeFontSize: 13,
    syntaxTheme: "one",
    backgroundActive: false,
    backgroundOpacity: 0.85,
    ...overrides,
  };
}

// Run a single captured updater (default the first) against a fresh fake theme.
function runCapturedUpdater(call = 0): FakeTheme {
  const updater = updateTheme.mock.calls[call]?.[1] as unknown as ThemeUpdater;
  return updater(makeFakeTheme());
}

describe("applyAppearance", () => {
  beforeEach(() => {
    updateTheme.mockClear();
    runtime.themeName = undefined;
  });

  it("patches every registered Unistyles theme exactly once", () => {
    applyAppearance(makeInput());

    expect(updateTheme).toHaveBeenCalledTimes(ALL_THEME_KEYS.length);
    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([...ALL_THEME_KEYS]);
  });

  it("patches the active theme before inactive registry entries", () => {
    runtime.themeName = "darkPureBlack";

    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([
      "darkPureBlack",
      ...ALL_THEME_KEYS.filter((key) => key !== "darkPureBlack"),
    ]);
  });

  it("resolves an empty UI font family to the default stack", () => {
    applyAppearance(makeInput({ uiFontFamily: "" }));

    expect(runCapturedUpdater().fontFamily.ui).toBe(DEFAULT_UI_FONT_STACK);
  });

  it("passes a non-empty UI font family through trimmed", () => {
    applyAppearance(makeInput({ uiFontFamily: "  Menlo  " }));

    expect(runCapturedUpdater().fontFamily.ui).toBe("Menlo");
  });

  it("scales the whole UI ramp proportionally while preserving ratios", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(15);
    expect(fontSize.sm).toBe(14);
    expect(fontSize.lg).toBe(18);
    expect(fontSize.xl).toBe(21);
    expect(fontSize["4xl"]).toBe(30);
  });

  it("derives the UI ramp from the canonical sizes, not the live theme (no compounding)", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    // Simulate a theme whose fontSize was already scaled by a prior apply; the
    // updater must ignore it and rebuild from the authored FONT_SIZE ramp.
    const updater = updateTheme.mock.calls[0]?.[1] as unknown as ThemeUpdater;
    const alreadyScaled = makeFakeTheme();
    alreadyScaled.fontSize = {
      code: 4,
      content: 4,
      sm: 4,
      base: 4,
      lg: 4,
      xl: 4,
      "2xl": 4,
      "3xl": 4,
      "4xl": 4,
    };

    const { fontSize } = updater(alreadyScaled);
    expect(fontSize.base).toBe(15); // rebuilt from FONT_SIZE, not the live value of 4
    expect(fontSize.lg).toBe(18);
  });

  it("leaves the UI ramp at authored sizes when only the code size changes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 13, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(13);
    expect(fontSize.lg).toBe(16);
    expect(fontSize.sm).toBe(12);
    expect(fontSize.code).toBe(10);
  });

  it("sets content size independently of the interface and code sizes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 13, contentFontSize: 19, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(13);
    expect(fontSize.content).toBe(19);
    expect(fontSize.code).toBe(10);
  });

  it("sets fontSize.code to codeFontSize regardless of the UI font size", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 13, codeFontSize: 18 }));

    expect(runCapturedUpdater().fontSize.code).toBe(18);
  });

  it("couples lineHeight.diff to the code font size", () => {
    applyAppearance(makeInput({ codeFontSize: 18 }));

    expect(runCapturedUpdater().lineHeight.diff).toBe(Math.round(18 * 1.5)); // 27
  });

  it("swaps colors.syntax to the resolved palette for the named theme", () => {
    applyAppearance(makeInput({ syntaxTheme: "dracula" }));

    const { colors } = runCapturedUpdater();
    expect(colors.syntax).toEqual(resolveSyntaxColors("dracula", "dark"));
  });

  it("resolves a syntax theme using the theme's own color scheme", () => {
    applyAppearance(makeInput({ syntaxTheme: "github" }));

    // makeFakeTheme().colorScheme === "dark" -> github resolves to the dark palette.
    expect(runCapturedUpdater().colors.syntax).toEqual(darkHighlightColors);
    expect(runCapturedUpdater().colors.syntax).toEqual(resolveSyntaxColors("github", "dark"));
  });

  it("removes panel and composer backgrounds at 100% without changing text colors", () => {
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 1 }));

    const { colors } = runCapturedUpdater();
    expect(colors.surface0).toBe("rgba(24, 24, 24, 0)");
    expect(colors.background).toBe("rgba(24, 24, 24, 0)");
    expect(colors.surface1).toBe("rgba(35, 35, 35, 0)");
    expect(colors.surface2).toBe("rgba(46, 46, 46, 0)");
    expect(colors.surfaceUserMessage).toBe("rgba(69, 69, 69, 0)");
    expect(colors.surfaceSidebar).toBe(
      setCssColorAlpha(REGISTERED_THEMES.dark.colors.surfaceSidebar, 0),
    );
    expect(colors.input).toBe(setCssColorAlpha(REGISTERED_THEMES.dark.colors.input, 0));
    expect(colors.foreground).toBe(REGISTERED_THEMES.dark.colors.foreground);
    expect(colors.surfaceComposer).toBe(
      setCssColorAlpha(REGISTERED_THEMES.dark.colors.surfaceComposer, 0),
    );
  });

  it("preserves the selected theme canvas color beneath fully transparent media", () => {
    for (const theme of Object.values(REGISTERED_THEMES)) {
      const transparentCanvas = setCssColorAlpha(theme.colors.surface0, 0);
      expect(setCssColorAlpha(transparentCanvas, 1)).toBe(
        setCssColorAlpha(theme.colors.surface0, 1),
      );
    }
  });

  it("keeps floating panels opaque over a transparent wallpaper canvas", () => {
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 1 }));

    const { colors } = runCapturedUpdater();
    expect(colors.popover).toBe(REGISTERED_THEMES.dark.colors.popover);
    expect(colors.surface0).toBe("rgba(24, 24, 24, 0)");
  });

  it("previews intermediate transparency and restores solid panels without compounding", () => {
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 0.5 }));
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 1 }));
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 0 }));

    expect(runCapturedUpdater().colors.surface1).toBe("rgba(35, 35, 35, 0.5)");
    expect(runCapturedUpdater(ALL_THEME_KEYS.length).colors.surface1).toBe("rgba(35, 35, 35, 0)");
    const solid = runCapturedUpdater(ALL_THEME_KEYS.length * 2);
    expect(solid.colors.surface1).toBe("rgba(35, 35, 35, 1)");
    expect(solid.colors.surfaceUserMessage).toBe("rgba(69, 69, 69, 1)");
    expect(solid.colors.surfaceComposer).toBe(
      setCssColorAlpha(REGISTERED_THEMES.dark.colors.surfaceComposer, 1),
    );
  });

  it("restores authored surfaces when wallpaper is disabled", () => {
    applyAppearance(makeInput({ backgroundActive: true, backgroundOpacity: 1 }));
    applyAppearance(makeInput({ backgroundActive: false, backgroundOpacity: 1 }));

    const restored = runCapturedUpdater(ALL_THEME_KEYS.length);
    expect(restored.colors.surface0).toBe(REGISTERED_THEMES.dark.colors.surface0);
    expect(restored.colors.surface2).toBe(REGISTERED_THEMES.dark.colors.surface2);
    expect(restored.colors.surfaceComposer).toBe(REGISTERED_THEMES.dark.colors.surfaceComposer);
  });
});
