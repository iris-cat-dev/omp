import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentSelectOption } from "@omp-desktop/protocol/agent-types";
import { ThinkingIcon } from "@/agent-controls/icons";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FastModeFeature } from "@/composer/agent-controls/utils";
import type { Theme } from "@/styles/theme";

const ThemedThinkingIcon = withUnistyles(ThinkingIcon);
const ThemedZap = withUnistyles(Zap);
const foregroundIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fastIconColorMapping = (theme: Theme) => ({ color: theme.colors.palette.yellow[400] });

interface ModelSettingsPanelProps {
  thinkingOptions: AgentSelectOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  fastMode: FastModeFeature | null;
  onSetFeature?: (featureId: string, value: unknown) => void;
  contextWindowMaxTokens?: number;
  contextControl?: ReactNode;
  disabled?: boolean;
  pending?: boolean;
  compact?: boolean;
}

export function ModelSettingsPanel({
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  fastMode,
  onSetFeature,
  contextWindowMaxTokens,
  contextControl,
  disabled,
  pending,
  compact,
}: ModelSettingsPanelProps) {
  const { t } = useTranslation();
  const thinkingAnchorRef = useRef<View>(null);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const thinkingComboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      thinkingOptions.map((option) => ({
        id: option.id,
        label: formatThinkingOptionLabel(option),
        description: option.description,
      })),
    [thinkingOptions],
  );
  const selectedThinking = useMemo(
    () =>
      thinkingComboboxOptions.find((option) => option.id === selectedThinkingOptionId) ??
      thinkingComboboxOptions[0] ??
      null,
    [thinkingComboboxOptions, selectedThinkingOptionId],
  );
  const controlsDisabled = Boolean(disabled || pending);
  const hasThinking = thinkingComboboxOptions.length > 1 && Boolean(onSelectThinkingOption);
  const hasContext = contextControl != null || contextWindowMaxTokens !== undefined;
  const hasControls = hasThinking || fastMode !== null || hasContext;

  const handleThinkingPress = useCallback(() => {
    setThinkingOpen((current) => !current);
  }, []);
  const handleThinkingSelect = useCallback(
    (id: string) => {
      onSelectThinkingOption?.(id);
      setThinkingOpen(false);
    },
    [onSelectThinkingOption],
  );
  const handleFastModeChange = useCallback(
    (value: boolean) => {
      if (fastMode) onSetFeature?.(fastMode.id, value);
    },
    [fastMode, onSetFeature],
  );
  const thinkingLeadingSlot = useMemo(
    () => <ThemedThinkingIcon size={16} uniProps={foregroundIconColorMapping} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean; onPress: () => void }) => (
      <ComboboxItem
        label={args.option.label}
        description={args.option.description}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        leadingSlot={thinkingLeadingSlot}
      />
    ),
    [thinkingLeadingSlot],
  );

  if (!hasControls) return null;

  return (
    <View
      style={[styles.container, compact && styles.containerCompact]}
      testID="model-settings-panel"
    >
      <Text style={styles.heading}>{t("modelSelector.modelSettings")}</Text>
      <View style={styles.controls}>
        {hasThinking ? (
          <>
            <AgentControlTrigger
              ref={thinkingAnchorRef}
              icon={ThinkingIcon}
              surface="sheet"
              label={t("agentControls.thinking.title")}
              value={selectedThinking?.label ?? t("agentControls.thinking.unknown")}
              open={thinkingOpen}
              disabled={controlsDisabled}
              onPress={handleThinkingPress}
              accessibilityLabel={t("agentControls.thinking.selectWithValue", {
                value: selectedThinking?.label ?? t("agentControls.thinking.unknown"),
              })}
              testID="model-settings-thinking"
            />
            <Combobox
              options={thinkingComboboxOptions}
              value={selectedThinking?.id ?? ""}
              onSelect={handleThinkingSelect}
              open={thinkingOpen}
              onOpenChange={setThinkingOpen}
              anchorRef={thinkingAnchorRef}
              presentation={compact ? "push" : undefined}
              title={t("agentControls.thinking.title")}
              searchable={thinkingComboboxOptions.length > 6}
              renderOption={renderThinkingOption}
            />
          </>
        ) : null}
        {fastMode ? (
          <FastModeSetting
            fastMode={fastMode}
            disabled={controlsDisabled}
            canSetFeature={Boolean(onSetFeature)}
            onValueChange={handleFastModeChange}
          />
        ) : null}
        {contextControl ??
          (contextWindowMaxTokens !== undefined ? (
            <View style={styles.settingRow} testID="model-settings-context-window">
              <View style={styles.contextGlyph}>
                <Text style={styles.contextGlyphText}>T</Text>
              </View>
              <Text style={styles.settingLabel}>{t("contextWindow.title")}</Text>
              <Text style={styles.settingValue}>{formatTokenCount(contextWindowMaxTokens)}</Text>
            </View>
          ) : null)}
      </View>
    </View>
  );
}

function FastModeSetting({
  fastMode,
  disabled,
  canSetFeature,
  onValueChange,
}: {
  fastMode: FastModeFeature;
  disabled: boolean;
  canSetFeature: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const rowStyle = useMemo(() => [styles.settingRow, disabled && styles.disabled], [disabled]);
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger style={rowStyle} testID="model-settings-fast-mode-row" accessible={false}>
        <View style={styles.settingGlyph}>
          <ThemedZap
            size={15}
            uniProps={fastMode.value ? fastIconColorMapping : mutedIconColorMapping}
          />
        </View>
        <Text style={styles.settingLabel}>{t("shell.commandCenter.fastModeGroupLabel")}</Text>
        <Switch
          value={fastMode.value}
          onValueChange={onValueChange}
          disabled={disabled || !canSetFeature}
          accessibilityLabel={t("shell.commandCenter.fastModeGroupLabel")}
          testID="model-settings-fast-mode"
        />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        offset={8}
        maxWidth={320}
        testID="model-settings-fast-mode-tooltip"
      >
        <Text style={styles.tooltipText}>{t("shell.commandCenter.fastModeDescription")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  containerCompact: {
    marginHorizontal: 0,
    borderRadius: theme.borderRadius.lg,
    borderTopWidth: 0,
    paddingHorizontal: 0,
    backgroundColor: "transparent",
  },
  heading: {
    paddingHorizontal: 2,
    paddingBottom: 2,
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
  controls: {
    gap: 2,
  },
  settingRow: {
    minHeight: 36,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  settingGlyph: {
    width: 16,
    height: 16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  contextGlyph: {
    width: 18,
    height: 18,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    borderRadius: theme.borderRadius.sm,
  },
  contextGlyphText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  settingLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: theme.fontWeight.medium,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  settingValue: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  disabled: {
    opacity: 0.5,
  },
}));
