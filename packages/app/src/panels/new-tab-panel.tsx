import { memo, useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus, type LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Shortcut } from "@/components/ui/shortcut";
import { isWeb } from "@/constants/platform";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  useWorkspaceTabLaunchCatalog,
  type WorkspaceTabLaunchItem,
} from "@/workspace-tabs/launcher";

const ThemedPlus = withUnistyles(Plus);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** Every launcher row leads with the same glyph box so labels share one rail. */
const LAUNCHER_ICON_SIZE = ICON_SIZE.md;
const LAUNCHER_MAX_WIDTH = 380;
const ROW_DATA_SET = { newTabLauncherRow: "true" };
const ROW_SELECTOR = '[data-new-tab-launcher-row="true"]';
function LauncherIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={LAUNCHER_ICON_SIZE} color={color} />;
}

const ThemedLauncherIcon = withUnistyles(LauncherIcon);

function LauncherShortcut({ actionId }: { actionId: string }): ReactElement | null {
  const keys = useShortcutKeys(actionId);
  return keys ? <Shortcut chord={keys} /> : null;
}

function rowStyle({
  pressed,
  hovered = false,
  focused = false,
}: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) {
  return [
    styles.row,
    (hovered || focused) && styles.rowHovered,
    focused && styles.rowFocused,
    pressed && styles.rowPressed,
  ];
}

function LauncherRow({ item }: { item: WorkspaceTabLaunchItem }) {
  const { tabId } = usePaneContext();
  const handlePress = useCallback(() => {
    item.launch({ kind: "replace", tabId });
  }, [item, tabId]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.description ? `${item.label}. ${item.description}` : item.label}
      dataSet={ROW_DATA_SET}
      disabled={item.disabled}
      onPress={handlePress}
      style={rowStyle}
      tabIndex={-1}
      testID={`workspace-new-tab-${item.id}`}
    >
      {item.Icon ? <ThemedLauncherIcon Icon={item.Icon} uniProps={mutedColorMapping} /> : null}
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.rowLabel}>
          {item.label}
        </Text>
        {item.description ? <Text style={styles.rowDescription}>{item.description}</Text> : null}
      </View>
      {item.shortcutActionId ? <LauncherShortcut actionId={item.shortcutActionId} /> : null}
    </Pressable>
  );
}

function useNewTabDescriptor() {
  const { t } = useTranslation();
  const label = t("workspace.tabs.actions.newTab");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: ThemedPlus,
    statusBucket: null,
  };
}

const NewTabPanel = memo(function NewTabPanel(): ReactElement {
  const { isSidePanel, serverId, tabId } = usePaneContext();
  const { isInteractive, focusPane } = usePaneFocus();
  const containerRef = useRef<View | null>(null);
  const groups = useWorkspaceTabLaunchCatalog({
    serverId,
    purpose: isSidePanel ? "supporting" : "primary",
  });
  const itemsById = useMemo(
    () => new Map(groups.flatMap((group) => group.items).map((item) => [item.id, item])),
    [groups],
  );

  useEffect(() => {
    if (!isWeb || !isInteractive) return;
    const container: unknown = containerRef.current;
    if (!(container instanceof HTMLElement)) return;
    const webContainer = container as HTMLElement;

    function rows() {
      return Array.from(webContainer.querySelectorAll(ROW_SELECTOR)) as HTMLElement[];
    }
    function focusFirstRow() {
      rows()[0]?.focus({ preventScroll: true });
    }
    function handlePointerDown(event: PointerEvent) {
      focusPane();
      if (!(event.target instanceof Element) || !event.target.closest(ROW_SELECTOR)) {
        requestAnimationFrame(focusFirstRow);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      const availableRows = rows();
      const currentIndex = availableRows.findIndex((row) => row === document.activeElement);
      let direction = 0;
      if (event.key === "ArrowDown") {
        direction = 1;
      } else if (event.key === "ArrowUp") {
        direction = -1;
      }
      if (direction !== 0 && availableRows.length > 0) {
        event.preventDefault();
        let start = currentIndex;
        if (currentIndex < 0) {
          start = direction > 0 ? -1 : 0;
        }
        const nextIndex = (start + direction + availableRows.length) % availableRows.length;
        availableRows[nextIndex]?.focus();
      }
      if (event.key === "Enter" && currentIndex >= 0) {
        event.preventDefault();
        availableRows[currentIndex]?.click();
      }
    }

    webContainer.addEventListener("pointerdown", handlePointerDown, true);
    webContainer.addEventListener("keydown", handleKeyDown);
    focusFirstRow();
    return () => {
      webContainer.removeEventListener("pointerdown", handlePointerDown, true);
      webContainer.removeEventListener("keydown", handleKeyDown);
    };
  }, [focusPane, isInteractive]);

  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id === "workspace.agent.new" || action.id === "workspace.tab.target.agent") {
        itemsById.get("agent")?.launch({ kind: "replace", tabId });
        return true;
      }
      if (action.id === "workspace.terminal.new") {
        itemsById.get("terminal")?.launch({ kind: "replace", tabId });
        return true;
      }
      if (action.id === "workspace.tab.target.changes") {
        itemsById.get("changes")?.launch({ kind: "replace", tabId });
        return true;
      }
      if (action.id === "workspace.tab.target.files") {
        itemsById.get("files")?.launch({ kind: "replace", tabId });
        return true;
      }
      return false;
    },
    [itemsById, tabId],
  );
  useKeyboardActionHandler({
    handlerId: `new-tab:${tabId}`,
    actions: [
      "workspace.agent.new",
      "workspace.terminal.new",
      "workspace.tab.target.agent",
      "workspace.tab.target.changes",
      "workspace.tab.target.files",
    ],
    enabled: isInteractive,
    priority: 250,
    handle: handleKeyboardAction,
  });

  return (
    <View ref={containerRef} style={styles.container} testID="workspace-new-tab-panel">
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.rail}>
          {groups.map((group) => (
            <View key={group.id} style={styles.group}>
              {group.label ? <Text style={styles.groupLabel}>{group.label}</Text> : null}
              {group.items.map((item) => (
                <LauncherRow key={item.id} item={item} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
});

export const newTabPanelRegistration: PanelRegistration<"new_tab"> = {
  kind: "new_tab",
  resourceKey: () => "new_tab",
  component: NewTabPanel,
  useDescriptor: useNewTabDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  rail: {
    width: "100%",
    maxWidth: LAUNCHER_MAX_WIDTH,
    gap: theme.spacing[12],
  },
  group: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    outlineWidth: 0,
    outlineColor: "transparent",
    backgroundColor: theme.colors.surface1,
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowFocused: { borderColor: theme.colors.borderAccent },
  rowPressed: { opacity: 0.85 },
  rowText: { flex: 1, paddingVertical: theme.spacing[2] },
  rowLabel: { color: theme.colors.foreground },
  rowDescription: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  groupLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: 2,
    marginBottom: theme.spacing[1],
  },
}));
