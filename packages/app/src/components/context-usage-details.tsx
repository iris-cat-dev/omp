import { useMemo, useState } from "react";
import { Database, Gauge, MessageSquare } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentUsage } from "@omp-desktop/protocol/agent-types";
import { CompactMetricRow } from "@/provider-usage/compact-metric-row";
import { UsageSectionHeading } from "./usage-section-heading";
import {
  formatSessionCost,
  getCacheHitRatio,
  getContextProgressColor,
  hasSessionCache,
  type ContextWindowReading,
} from "./context-window-meter.utils";

function SessionUsage({ usage }: { usage: AgentUsage }) {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const { inputTokens, cachedInputTokens: read, cacheWriteTokens: written, compactionCount } = usage;
  const amount = usage.totalCostUsd === undefined ? null : formatSessionCost(usage.totalCostUsd);
  const cost = amount ? t("contextWindow.sessionCost", { cost: amount }) : null;
  const compactions =
    compactionCount === undefined ? null : t("contextWindow.compactionCount", { count: compactionCount });
  const hasCache = hasSessionCache(usage);
  if (!hasCache && !cost && !compactions) return null;

  const ratio = getCacheHitRatio(inputTokens, read, written);
  const summary = hasCache
    ? t("contextWindow.cacheHitSummary", {
        rate: ratio === null
          ? "—"
          : ratio.toLocaleString(i18n.language, { style: "percent", maximumFractionDigits: 1 }),
      })
    : cost ?? compactions ?? undefined;
  const canExpand = hasCache || Boolean(cost && compactions);
  const formatTokens = (value: number | undefined) =>
    value === undefined ? "—" : `${value.toLocaleString(i18n.language)} ${t("agentStream.turnMetadata.tokens")}`;
  return (
    <View style={styles.section}>
      <UsageSectionHeading
        icon={hasCache ? Database : MessageSquare}
        iconColor={hasCache ? theme.colors.accent : undefined}
        title={t(hasCache ? "contextWindow.sessionCache" : "contextWindow.sessionUsage")}
        value={summary}
        expanded={expanded}
        onPress={canExpand ? () => setExpanded(!expanded) : undefined}
        testID="session-usage-disclosure"
      />
      {canExpand && expanded ? (
        <View style={styles.details}>
          {hasCache ? (
            <>
              <CompactMetricRow label={t("contextWindow.cacheRead")} value={formatTokens(read)} />
              <CompactMetricRow label={t("contextWindow.cacheWrite")} value={formatTokens(written)} />
            </>
          ) : null}
          {(hasCache && cost) || compactions ? (
            <View style={styles.notes}>
              {hasCache && cost ? <Text style={styles.caption}>{cost}</Text> : null}
              {compactions ? <Text style={styles.caption}>{compactions}</Text> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function ContextUsageDetails({
  usage,
  reading,
}: {
  usage: AgentUsage;
  reading: ContextWindowReading | null;
}) {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const counts = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        notation: "compact",
        maximumSignificantDigits: 3,
        useGrouping: true,
      }),
    [i18n.language],
  );
  const color = reading ? getContextProgressColor(reading.percentage, theme) : undefined;
  return (
    <>
      {reading ? (
        <View style={styles.section}>
          <UsageSectionHeading
            icon={Gauge}
            iconColor={color}
            title={t("contextWindow.title")}
            value={t("contextWindow.used", { percentage: Math.round(reading.percentage) })}
          />
          <View style={styles.contextBody}>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.min(100, reading.percentage)}%`, backgroundColor: color },
                ]}
              />
            </View>
            <Text style={styles.caption}>
              {t("contextWindow.tokens", {
                used: counts.format(reading.used),
                max: counts.format(reading.max),
              })}
            </Text>
          </View>
        </View>
      ) : null}
      <SessionUsage usage={usage} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[1] },
  contextBody: { paddingStart: 36, gap: theme.spacing[1] },
  track: {
    height: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: theme.borderRadius.full },
  details: { paddingStart: 36, gap: theme.spacing[2] },
  notes: { flexDirection: "row", flexWrap: "wrap", columnGap: theme.spacing[3], rowGap: theme.spacing[1] },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
