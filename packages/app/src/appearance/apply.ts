import { UnistylesRuntime } from "react-native-unistyles";
import { resolveSyntaxColors, type SyntaxThemeId } from "@omp-desktop/highlight";
import {
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  FONT_SIZE,
  REGISTERED_THEMES,
  type Theme,
} from "@/styles/theme";
import { setCssColorAlpha } from "./color";
import { applyRootUiFont } from "./apply-root-font";

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];
const authoredColorsByTheme = new Map<string, Theme["colors"]>();

export function setAuthoredThemeColors(key: string, colors: Theme["colors"]): void {
  authoredColorsByTheme.set(key, colors);
}

export interface AppearanceInput {
  uiFontFamily: string; // "" -> default stack
  monoFontFamily: string; // "" -> default stack
  uiBaseFontSize: number; // already clamped
  contentFontSize: number; // already clamped
  codeFontSize: number; // already clamped
  syntaxTheme: SyntaxThemeId;
  backgroundActive: boolean;
  backgroundOpacity: number;
}

/**
 * Build the font-size ramp from the canonical `FONT_SIZE` ramp, scaled
 * proportionally from the requested base size so the type hierarchy is preserved
 * sizes. Deriving from the authored ramp — NOT the live (possibly already-scaled)
 * theme — makes `applyAppearance` idempotent: repeated applies never compound, and a
 * code-size change (base size unchanged) leaves the UI ramp at its authored values.
 * `code` is set absolutely to `codeSize`, never scaled by the UI factor — a separate
 * control on a separate semantic axis (mono/diff text).
 */
function scaleFontSize(
  uiBaseSize: number,
  contentSize: number,
  codeSize: number,
): Theme["fontSize"] {
  const r = uiBaseSize / FONT_SIZE.base;
  return {
    sm: Math.round(FONT_SIZE.sm * r),
    base: Math.round(FONT_SIZE.base * r),
    lg: Math.round(FONT_SIZE.lg * r),
    xl: Math.round(FONT_SIZE.xl * r),
    "2xl": Math.round(FONT_SIZE["2xl"] * r),
    "3xl": Math.round(FONT_SIZE["3xl"] * r),
    "4xl": Math.round(FONT_SIZE["4xl"] * r),
    content: contentSize, // absolute, NOT scaled
    code: codeSize, // absolute, NOT scaled
  };
}
function applyBackgroundSurfaces<TColors extends Theme["colors"]>(
  colors: TColors,
  active: boolean,
  opacity: number,
): TColors {
  if (!active) return colors;
  // One control reveals the media and removes the interface veil while preserving
  // the authored surface RGB for repeated opacity previews.
  const surfaceAlpha = 1 - opacity;
  return {
    ...colors,
    surface0: setCssColorAlpha(colors.surface0, 0),
    surfaceWorkspace: setCssColorAlpha(colors.surfaceWorkspace, 0),
    background: setCssColorAlpha(colors.background, 0),
    surface1: setCssColorAlpha(colors.surface1, surfaceAlpha),
    surface2: setCssColorAlpha(colors.surface2, surfaceAlpha),
    surface3: setCssColorAlpha(colors.surface3, surfaceAlpha),
    surface4: setCssColorAlpha(colors.surface4, surfaceAlpha),
    surfaceSidebar: setCssColorAlpha(colors.surfaceSidebar, surfaceAlpha),
    surfaceUserMessage: setCssColorAlpha(colors.surfaceUserMessage, surfaceAlpha),
    surfaceComposer: setCssColorAlpha(colors.surfaceComposer, surfaceAlpha),
    secondary: setCssColorAlpha(colors.secondary, surfaceAlpha),
    muted: setCssColorAlpha(colors.muted, surfaceAlpha),
    input: setCssColorAlpha(colors.input, surfaceAlpha),
  } as TColors;
}

function getAuthoredColors<TColors extends Theme["colors"]>(
  key: string,
  current: TColors,
): TColors {
  const stored = authoredColorsByTheme.get(key) as TColors | undefined;
  if (stored) return stored;
  authoredColorsByTheme.set(key, current);
  return current;
}

/**
 * Patch every registered Unistyles theme with the user's appearance choices.
 * All keys in `ALL_THEME_KEYS` are patched because the active theme can change
 * and adaptive mode can flip light/dark — patching all keys keeps the active key
 * always current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant.
 *
 * The updater starts from authored colors so repeated previews never compound
 * opacity. Base canvases stay transparent while media is ready. The background
 * value fades media in and panel backgrounds out; 100% reveals the original image.
 * Floating popovers retain their authored backing; other overlays restore opacity locally.
 */
export function applyAppearance(input: AppearanceInput): void {
  const ui = input.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const mono = input.monoFontFamily.trim() || DEFAULT_MONO_FONT_STACK;
  const diffLineHeight = Math.round(input.codeFontSize * 1.5); // couple to code size
  const activeTheme = UnistylesRuntime.themeName;
  // Unistyles web emits after each registry patch. Updating the mounted theme
  // first ensures subscribers receive its new numeric tokens in this render;
  // updating it last makes Pure black appear one committed value behind.
  const themeKeys = activeTheme
    ? [activeTheme, ...ALL_THEME_KEYS.filter((key) => key !== activeTheme)]
    : ALL_THEME_KEYS;

  for (const key of themeKeys) {
    UnistylesRuntime.updateTheme(key, (t) => {
      const fontFamily = { ui, mono };
      const fontSize = scaleFontSize(
        input.uiBaseFontSize,
        input.contentFontSize,
        input.codeFontSize,
      );
      const lineHeight = { ...t.lineHeight, diff: diffLineHeight };
      if (t.colorScheme === "light") {
        const colors = applyBackgroundSurfaces(
          getAuthoredColors(key, t.colors),
          input.backgroundActive,
          input.backgroundOpacity,
        );
        return {
          ...t,
          fontFamily,
          fontSize,
          lineHeight,
          colors: {
            ...colors,
            syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme),
          },
        };
      }
      const colors = applyBackgroundSurfaces(
        getAuthoredColors(key, t.colors),
        input.backgroundActive,
        input.backgroundOpacity,
      );
      return {
        ...t,
        fontFamily,
        fontSize,
        lineHeight,
        colors: {
          ...colors,
          syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme),
        },
      };
    });
  }

  // Web: apply the UI font app-wide (RN-web stamps a default font on every text
  // element, so it can't be done through the theme alone). No-op on native.
  applyRootUiFont(ui);
}
