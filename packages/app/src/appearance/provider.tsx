import { createContext, type ReactNode, useContext, useEffect } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings } from "@/hooks/use-settings";
import { PLUGIN_THEME_PREFERENCE, THEME_TO_UNISTYLES, type Theme } from "@/styles/theme";
import { getEffectiveWallpaperSourceKey } from "@/wallpaper/source";
import { useWallpaperLibrary } from "@/wallpaper/desktop-client";
import { useWallpaperLoadStatus } from "@/wallpaper/load-state";
import { applyAppearance } from "./apply";

export interface ContributedThemeOption {
  id: string;
  serverId: string;
  name: string;
  swatch: string;
  theme: Theme;
}

interface ContributedThemes {
  options: ContributedThemeOption[];
  selected: ContributedThemeOption | null;
  select: (option: ContributedThemeOption) => void;
}

const EMPTY_CONTRIBUTED_THEMES: ContributedThemes = {
  options: [],
  selected: null,
  select: () => undefined,
};

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, isLoading } = useAppSettings();
  const { library, error: libraryError } = useWallpaperLibrary();
  const wallpaperKey = getEffectiveWallpaperSourceKey(settings, libraryError ? null : library);
  const wallpaperActive = useWallpaperLoadStatus(wallpaperKey) === "ready";

  useEffect(() => {
    if (isLoading) return;
    const preference =
      settings.theme === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : settings.theme;
    if (preference === "auto") {
      UnistylesRuntime.setAdaptiveThemes(true);
    } else {
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[preference]);
    }
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
      wallpaperActive,
      wallpaperOpacity: settings.wallpaperOpacity,
    });
  }, [
    isLoading,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.syntaxTheme,
    settings.wallpaperOpacity,
    wallpaperActive,
  ]);

  return (
    <ContributedThemesContext.Provider value={EMPTY_CONTRIBUTED_THEMES}>
      {children}
    </ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
