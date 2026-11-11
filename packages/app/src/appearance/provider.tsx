import { createContext, type ReactNode, useContext, useEffect } from "react";
import { UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { DEFAULT_THEME_PREFERENCE, useAppSettings } from "@/hooks/use-settings";
import { PLUGIN_THEME_NAMES, PLUGIN_THEME_PREFERENCE, THEME_TO_UNISTYLES, type Theme } from "@/styles/theme";
import { usePluginBackgroundState } from "@/plugins/background";
import { useContributedPluginThemes } from "@/plugins/themes";
import { applyAppearance, setAuthoredThemeColors } from "./apply";

export interface ContributedThemeOption {
  id: string;
  serverId: string;
  owner: "desktop" | "daemon";
  name: string;
  swatch: string;
  theme: Theme;
}

interface ContributedThemes {
  sources: ContributedThemeOption[];
  selected: ContributedThemeOption | null;
  select: (option: ContributedThemeOption) => Promise<void>;
}


const ContributedThemesContext = createContext<ContributedThemes | null>(null);

function DocumentColorSchemeBase({ colorScheme }: { colorScheme: Theme["colorScheme"] }) {
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.colorScheme = colorScheme;
    }
  }, [colorScheme]);
  return null;
}

const DocumentColorScheme = withUnistyles(DocumentColorSchemeBase, (theme) => ({
  colorScheme: theme.colorScheme,
}));

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, isLoading } = useAppSettings();
  const contributedThemes = useContributedPluginThemes();
  const background = usePluginBackgroundState();
  const backgroundActive = background.status === "ready";

  useEffect(() => {
    if (isLoading) return;
    const selectedTheme = contributedThemes.selected;
    const preference = settings.theme === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : settings.theme;
    if (selectedTheme) {
      const slot = PLUGIN_THEME_NAMES[selectedTheme.theme.colorScheme];
      setAuthoredThemeColors(slot, selectedTheme.theme.colors);
      UnistylesRuntime.updateTheme(slot, () => selectedTheme.theme);
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(slot);
    } else if (preference === "auto") {
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
      backgroundActive,
      backgroundOpacity: background.opacity,
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
    contributedThemes.selected,
    background.opacity,
    backgroundActive,
  ]);

  return (
    <ContributedThemesContext.Provider value={contributedThemes}>
      <DocumentColorScheme />
      {children}
    </ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
