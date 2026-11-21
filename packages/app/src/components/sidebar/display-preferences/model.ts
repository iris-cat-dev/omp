import { useCallback, useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import {
  useSidebarViewStore,
  type SidebarGroupMode,
  type SidebarLabelFilter,
} from "@/stores/sidebar-view-store";
import type { TouchInteractionPreference } from "@/utils/device-input";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY, type SidebarChecksDisplay } from "./checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS, type SidebarRowItem, type SidebarRowItems } from "./row-items";

export interface SidebarDisplayPreferences {
  grouping: SidebarGroupMode;
  setGrouping: (mode: SidebarGroupMode) => void;
  touchMode: TouchInteractionPreference;
  setTouchMode: (mode: TouchInteractionPreference) => void;
  reorderMode: boolean;
  toggleReorderMode: () => void;
  rowItems: SidebarRowItems;
  toggleRowItem: (item: SidebarRowItem) => void;
  checksDisplay: SidebarChecksDisplay;
  setChecksDisplay: (display: SidebarChecksDisplay) => void;
  hostFilters: readonly string[];
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  hiddenProjectViewKeys: readonly string[];
  toggleProjectVisibility: (viewKey: string) => void;
  showAllProjects: () => void;
  labelFilter: SidebarLabelFilter;
  toggleLabelFilter: (name: string) => void;
  clearLabelFilter: () => void;
}

/**
 * Every decision the sidebar's display-preferences menu can make, behind one interface.
 *
 * Grouping and host filters live in a local zustand store while row items
 * are synced app settings — a split that exists for good reasons (a filter is transient view
 * state; a preference follows you) and that the menu has no business knowing about. Callers ask
 * this for a value and set it; where it lands is this module's problem.
 */
export function useSidebarDisplayPreferences(): SidebarDisplayPreferences {
  const grouping = useSidebarViewStore((state) => state.groupMode);
  const setGrouping = useSidebarViewStore((state) => state.setGroupMode);
  const touchMode = useSidebarViewStore((state) => state.touchMode);
  const setTouchMode = useSidebarViewStore((state) => state.setTouchMode);
  const reorderMode = useSidebarViewStore((state) => state.reorderMode);
  const toggleReorderMode = useSidebarViewStore((state) => state.toggleReorderMode);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  const hiddenProjectViewKeys = useSidebarViewStore((state) => state.hiddenProjectViewKeys);
  const toggleProjectVisibility = useSidebarViewStore((state) => state.toggleProjectVisibility);
  const showAllProjects = useSidebarViewStore((state) => state.showAllProjects);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const toggleLabelFilter = useSidebarViewStore((state) => state.toggleLabelFilter);
  const clearLabelFilter = useSidebarViewStore((state) => state.clearLabelFilter);

  const {
    settings: { sidebarRowItems, sidebarChecksDisplay },
    updateSettings,
  } = useAppSettings();

  const toggleRowItem = useCallback(
    (item: SidebarRowItem) => {
      void updateSettings({
        sidebarRowItems: { ...sidebarRowItems, [item]: !sidebarRowItems[item] },
      });
    },
    [updateSettings, sidebarRowItems],
  );

  const setChecksDisplay = useCallback(
    (display: SidebarChecksDisplay) => {
      void updateSettings({ sidebarChecksDisplay: display });
    },
    [updateSettings],
  );

  return useMemo(
    () => ({
      grouping,
      setGrouping,
      touchMode,
      setTouchMode,
      reorderMode,
      toggleReorderMode,
      rowItems: sidebarRowItems,
      toggleRowItem,
      checksDisplay: sidebarChecksDisplay,
      setChecksDisplay,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
      hiddenProjectViewKeys,
      toggleProjectVisibility,
      showAllProjects,
      labelFilter,
      toggleLabelFilter,
      clearLabelFilter,
    }),
    [
      grouping,
      setGrouping,
      touchMode,
      setTouchMode,
      reorderMode,
      toggleReorderMode,
      sidebarRowItems,
      toggleRowItem,
      sidebarChecksDisplay,
      setChecksDisplay,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
      hiddenProjectViewKeys,
      toggleProjectVisibility,
      showAllProjects,
      labelFilter,
      toggleLabelFilter,
      clearLabelFilter,
    ],
  );
}

/**
 * Just the row items, for the row renderers. They re-render per workspace, so they subscribe to
 * the one field they use rather than to every preference in the menu.
 */
export function useSidebarRowItems(): SidebarRowItems {
  const {
    settings: { sidebarRowItems },
  } = useAppSettings();
  return sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS;
}

/**
 * Everything the line under a workspace title needs to know, in one read. The two settings are
 * answered together by `selectMetaRowItems`, so asking for them separately would only mean two
 * subscriptions per row for one decision.
 */
export function useSidebarMetaPreferences(): {
  rowItems: SidebarRowItems;
  checksDisplay: SidebarChecksDisplay;
} {
  const {
    settings: { sidebarRowItems, sidebarChecksDisplay },
  } = useAppSettings();
  return useMemo(
    () => ({
      rowItems: sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS,
      checksDisplay: sidebarChecksDisplay ?? DEFAULT_SIDEBAR_CHECKS_DISPLAY,
    }),
    [sidebarRowItems, sidebarChecksDisplay],
  );
}
