import React, { memo } from "react";
import { Platform, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { PluginTurnMetricProps } from "@omp-desktop/plugin";
import {
  calculateCompletedOutputRate,
  formatOutputTokenSpeed,
  useNativeOutputRate,
  type NativeOutputRate,
} from "./token-output-speed";

const sourceLabels = {
  en: {
    measured: "Measured",
    estimated: "Estimated",
    agentReference: "own-agent reference",
    modelReference: "same-model own-agent reference",
    formula: "valid own output / measured request duration",
  },
  zh: {
    measured: "实测",
    estimated: "估算",
    agentReference: "自身请求参考",
    modelReference: "同模型自身请求参考",
    formula: "有效自身 output / 实测请求时长",
  },
};

function describeOutputSpeed(
  label: string,
  rate: NativeOutputRate | null,
  active: boolean,
  language: string,
) {
  const labels = language.startsWith("zh") ? sourceLabels.zh : sourceLabels.en;
  const estimatedRate = active && rate && rate.estimated > 0 ? rate : null;
  const source = estimatedRate ? labels.estimated : labels.measured;
  const referenceLabel =
    rate?.reference === "agent" ? labels.agentReference : labels.modelReference;
  const tooltip = estimatedRate
    ? `${source}: ${label}; ${labels.measured} ${formatOutputTokenSpeed(estimatedRate.measured)} t/s + ${labels.estimated} ${formatOutputTokenSpeed(estimatedRate.estimated)} t/s (${referenceLabel})`
    : `${source}: ${label}; ${labels.formula}`;
  return { source, tooltip };
}

export const TurnOutputSpeed = memo(function TurnOutputSpeed(props: PluginTurnMetricProps) {
  const { t, i18n } = useTranslation();
  const rate = useNativeOutputRate(
    JSON.stringify([props.hostId, props.agentId, props.turnId]),
    props.visible && props.active && !props.cancelling,
    props.recordedUsage?.scope === "session" ? null : props.recordedUsage?.nativeMetrics,
  );
  if (!props.visible || props.cancelling) return null;
  const value = props.active
    ? (rate?.output ?? null)
    : calculateCompletedOutputRate(props.recordedUsage, props.replayedUsage);
  if (value === null) return null;
  const label = t("agentStream.turnMetadata.tokensPerSecond", {
    speed: formatOutputTokenSpeed(value),
  });
  const { source, tooltip } = describeOutputSpeed(label, rate, props.active, i18n.language);
  const text = (
    <Text
      style={styles.text}
      accessibilityLabel={`${label}, ${source}`}
      accessibilityHint={tooltip}
      testID={props.active ? "turn-token-output-speed" : "turn-avg-speed"}
    >
      {label}
    </Text>
  );
  return (
    <View style={props.active ? styles.live : undefined}>
      {Platform.OS === "web" ? React.createElement("span", { title: tooltip }, text) : text}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  live: {
    height: 24,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
}));
