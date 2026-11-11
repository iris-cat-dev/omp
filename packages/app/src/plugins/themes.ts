import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { PLUGIN_THEME_PREFERENCE, buildDarkSemanticColors, buildDarkTheme, buildLightSemanticColors, buildLightTheme, darkTheme, lightTheme } from "@/styles/theme";
import type { ContributedThemeOption } from "@/appearance/provider";
import { usePluginContributions } from "./hooks";
import { pluginSelectionMemory } from "./selection-memory";
import type { PluginContributions } from "./registry";
const cachedOptions = new WeakMap<PluginContributions["theme"], ContributedThemeOption>();

export function useContributedPluginThemes() {
  const contributions = usePluginContributions("theme");
  const memory = useSyncExternalStore(pluginSelectionMemory.subscribe, pluginSelectionMemory.getSnapshot, pluginSelectionMemory.getSnapshot);
  const { settings, updateSettings } = useAppSettings();
  const all = useMemo(() => contributions.map((entry) => {
    const { instance, contribution } = entry;
    const previous = cachedOptions.get(contribution);
    if (previous) return previous;
    const colors = contribution.colors;
    const base = contribution.appearance === "light" ? lightTheme : darkTheme;
    const tint = {
      surface0: colors.background, surface1: colors.raised, surface2: colors.control,
      surface3: colors.border, surface4: colors.ring, surfaceDiffEmpty: colors.raised,
      surfaceSidebar: contribution.appearance === "light" ? colors.control : colors.background, foreground: colors.foreground,
      foregroundMuted: colors.mutedForeground, foregroundExtraMuted: colors.ring,
      border: colors.border, borderAccent: colors.border, destructive: base.colors.destructive,
      terminalBlack: contribution.appearance === "light" ? colors.foreground : colors.control, terminalBrightBlack: colors.ring,
      ring: colors.ring, accent: colors.accent ?? colors.foreground, accentBright: colors.accent ?? colors.foreground, accentForeground: colors.background, primary: colors.foreground, primaryForeground: colors.background,
    };
    const theme = contribution.appearance === "light"
      ? buildLightTheme(buildLightSemanticColors(tint))
      : buildDarkTheme(buildDarkSemanticColors(tint));
    const option: ContributedThemeOption = { id: `${instance.installation.id}/theme/${contribution.id}`, serverId: instance.hostId, owner: instance.installation.owner, name: contribution.name, swatch: colors.background, theme };
    cachedOptions.set(contribution, option);
    return option;
  }), [contributions]);
  const preferred = settings.pluginThemeId ? memory.hosts[`theme:${settings.pluginThemeId}`] : undefined;
  const selected = settings.theme === PLUGIN_THEME_PREFERENCE && preferred ? all.find((option) => option.id === settings.pluginThemeId && option.serverId === preferred.hostId && option.owner === preferred.owner) ?? null : null;
  const select = useCallback(async (option: ContributedThemeOption) => {
    await pluginSelectionMemory.select("theme", option.id, option.serverId, option.owner);
    await updateSettings({ theme: PLUGIN_THEME_PREFERENCE, pluginThemeId: option.id });
  }, [updateSettings]);
  return { sources: all, selected, select };
}
