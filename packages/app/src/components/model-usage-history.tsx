import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, X } from "lucide-react-native";
import { formatAgentFeatureOptionLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import { FAST_MODE_FEATURE_ID } from "@/agent-controls/policy";
import { Gesture, GestureDetector, type NativeGesture } from "react-native-gesture-handler";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";
import {
  getModelUsageKey,
  type ModelUsageEntry,
  type ModelUsageSelection,
} from "@/stores/model-usage-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export const IndependentScrollGestureContext = createContext<NativeGesture | null>(null);

interface ModelBrowserPressableProps {
  children: React.ReactNode | ((state: PressableStateCallbackType) => React.ReactNode);
  style?:
    | StyleProp<ViewStyle>
    | ((state: PressableStateCallbackType & { hovered?: boolean }) => StyleProp<ViewStyle>);
  onPress: () => void;
  hitSlop?: number;
  accessibilityLabel?: string;
  /** Only rows that can express selection pass this; the rest stay unannotated. */
  accessibilitySelected?: boolean;
  accessibilityDisabled?: boolean;
  testID?: string;
}

export function ModelBrowserPressable({
  children,
  style,
  onPress,
  hitSlop,
  accessibilityLabel,
  accessibilitySelected,
  accessibilityDisabled,
  testID,
}: ModelBrowserPressableProps) {
  const independentScrollGesture = useContext(IndependentScrollGestureContext);
  const [pressed, setPressed] = useState(false);
  // Android's scroll handler must keep the pointer stream until release so a
  // fling survives leaving the short viewport. A simultaneous Tap keeps rows
  // interactive, while maxDistance makes a real scroll fail instead of select.
  const tapGesture = useMemo(() => {
    const gesture = Gesture.Tap()
      .enabled(!accessibilityDisabled)
      .maxDistance(8)
      .shouldCancelWhenOutside(true)
      .runOnJS(true)
      .onBegin(() => setPressed(true))
      .onEnd((_event, success) => {
        if (success) onPress();
      })
      .onFinalize(() => setPressed(false));
    if (hitSlop !== undefined) gesture.hitSlop(hitSlop);
    if (independentScrollGesture) {
      gesture.simultaneousWithExternalGesture(independentScrollGesture);
    }
    return gesture;
  }, [accessibilityDisabled, hitSlop, independentScrollGesture, onPress]);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (!accessibilityDisabled && event.nativeEvent.actionName === "activate") onPress();
    },
    [accessibilityDisabled, onPress],
  );
  const accessibilityState = useMemo(
    () => ({ selected: accessibilitySelected, disabled: accessibilityDisabled }),
    [accessibilityDisabled, accessibilitySelected],
  );

  if (!independentScrollGesture) {
    return (
      <Pressable
        onPress={handlePress}
        disabled={accessibilityDisabled}
        hitSlop={hitSlop}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        testID={testID}
      >
        {children}
      </Pressable>
    );
  }

  const state = { pressed };
  const resolvedStyle = typeof style === "function" ? style(state) : style;
  const resolvedChildren = typeof children === "function" ? children(state) : children;
  return (
    <GestureDetector gesture={tapGesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-selected={accessibilitySelected}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={handleAccessibilityAction}
        style={resolvedStyle}
        testID={testID}
      >
        {resolvedChildren}
      </View>
    </GestureDetector>
  );
}

export interface ModelUsageHistoryProps {
  entries: readonly ModelUsageEntry[];
  selection: ModelUsageSelection | null;
  onSelect: (entry: ModelUsageEntry) => void | Promise<void>;
  onRemove: (key: string) => void;
  disabled?: boolean;
}

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const accentMapping = (theme: Theme) => ({ color: theme.colors.accent });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ModelUsageHistory({
  entries,
  selection,
  onSelect,
  onRemove,
  disabled = false,
  rows,
  searchQuery,
  showProviderLabel = false,
}: ModelUsageHistoryProps & {
  rows: readonly ProviderSelectionModelRow[];
  searchQuery: string;
  showProviderLabel?: boolean;
}) {
  const { t } = useTranslation();
  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return entries.flatMap((entry) => {
      const row = rows.find(
        (candidate) => candidate.provider === entry.provider && candidate.modelId === entry.modelId,
      );
      if (!row) return [];
      const thinking =
        entry.thinkingOptionId === null
          ? t("modelSelector.thinkingUnsupported")
          : formatThinkingOptionLabel({ id: entry.thinkingOptionId });
      const speed =
        entry.speed === null
          ? t("modelSelector.speedUnsupported")
          : formatAgentFeatureOptionLabel(FAST_MODE_FEATURE_ID, { id: entry.speed }, t);
      const fields = [row.modelLabel, row.modelId, row.provider, row.providerLabel, thinking, speed]
        .join(" ")
        .toLowerCase();
      if (query && !query.split(/\s+/).every((word) => fields.includes(word))) return [];
      return [
        {
          entry,
          row,
          detail: [showProviderLabel ? row.providerLabel : null, thinking, speed]
            .filter(Boolean)
            .join(" · "),
        },
      ];
    });
  }, [entries, rows, searchQuery, showProviderLabel, t]);
  if (visibleEntries.length === 0) return null;
  const selectedKey = selection === null ? null : getModelUsageKey(selection);
  return (
    <View style={styles.section} testID="model-usage-history">
      <Text style={styles.heading}>{t("modelSelector.frequentlyUsed")}</Text>
      {visibleEntries.map(({ entry, row, detail }) => (
        <HistoryRow
          key={entry.key}
          entry={entry}
          row={row}
          detail={detail}
          selected={entry.key === selectedKey}
          disabled={disabled}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </View>
  );
}

function HistoryRow({
  entry,
  row,
  detail,
  selected,
  disabled,
  onSelect,
  onRemove,
}: {
  entry: ModelUsageEntry;
  row: ProviderSelectionModelRow;
  detail: string;
  selected: boolean;
  disabled: boolean;
  onSelect: ModelUsageHistoryProps["onSelect"];
  onRemove: ModelUsageHistoryProps["onRemove"];
}) {
  const { t } = useTranslation();
  const deleteLabel = t("modelSelector.deleteUsageRecord", { model: row.modelLabel });
  const handleSelect = useCallback(() => {
    if (!disabled) void onSelect(entry);
  }, [disabled, entry, onSelect]);
  const handleRemove = useCallback(() => onRemove(entry.key), [entry.key, onRemove]);
  const selectStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.select,
      (hovered || pressed) && styles.hovered,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  const removeStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.remove,
      (hovered || pressed) && styles.hovered,
    ],
    [],
  );
  return (
    <View style={[styles.row, selected && styles.selected]}>
      <ModelBrowserPressable
        onPress={handleSelect}
        accessibilityLabel={`${row.providerLabel} · ${row.modelLabel} · ${detail}`}
        accessibilitySelected={selected}
        accessibilityDisabled={disabled}
        style={selectStyle}
      >
        <View style={styles.labels}>
          <Text numberOfLines={1} style={styles.model}>
            {row.modelLabel}
          </Text>
          <Text numberOfLines={1} style={styles.detail}>
            {detail}
          </Text>
        </View>
        <Text style={styles.count}>{t("modelSelector.usageCount", { count: entry.useCount })}</Text>
        {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={accentMapping} /> : null}
      </ModelBrowserPressable>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View collapsable={false}>
            <ModelBrowserPressable
              onPress={handleRemove}
              accessibilityLabel={deleteLabel}
              style={removeStyle}
            >
              <ThemedX size={ICON_SIZE.sm} uniProps={mutedMapping} />
            </ModelBrowserPressable>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top">
          <Text style={styles.tooltip}>{deleteLabel}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    marginBottom: theme.spacing[2],
  },
  heading: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingVertical: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: isWeb ? theme.spacing[2] : theme.spacing[4],
  },
  selected: { backgroundColor: theme.colors.surface1 },
  select: {
    flex: 1,
    minWidth: 0,
    minHeight: isWeb ? 42 : 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: isWeb ? theme.spacing[3] : theme.spacing[6],
    paddingRight: theme.spacing[2],
    paddingVertical: 5,
  },
  labels: { flex: 1, minWidth: 0 },
  model: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  detail: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  remove: {
    width: isWeb ? 28 : 40,
    minHeight: isWeb ? 32 : 44,
    alignItems: "center",
    justifyContent: "center",
  },
  hovered: { backgroundColor: theme.colors.surface1 },
  disabled: { opacity: 0.5 },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
