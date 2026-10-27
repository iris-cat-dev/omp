import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Info, RefreshCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  OmpStatsMetrics,
  OmpStatsRange,
  OmpStatsSnapshot,
} from "@omp-desktop/protocol/omp-stats";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { useOmpStats, type OmpStatsView } from "./use-omp-stats";

const CacheWriteInfo = withUnistyles(Info);
const cacheWriteInfoProps = (theme: Theme) => ({
  size: theme.iconSize.xs,
  color: theme.colors.foregroundMuted,
});

const RANGES: readonly OmpStatsRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];
const BREAKDOWNS = ["byProvider", "byModel", "byAgentType"] as const;
type Breakdown = (typeof BREAKDOWNS)[number];
interface BreakdownRow {
  id: string;
  label: string;
  provider?: string;
  metrics: OmpStatsMetrics;
}

export function OmpStatsSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<OmpStatsRange>("24h");
  const { view, refresh } = useOmpStats(serverId, range);
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);
  const rangeOptions = useMemo(
    () =>
      RANGES.map((value) => ({
        value,
        label: t(`providerUsage.nativeStats.ranges.${value}`),
        testID: `omp-native-stats-range-${value}`,
      })),
    [t],
  );
  const refreshButton = useMemo(
    () => (
      <Button
        testID="omp-native-stats-refresh"
        variant="ghost"
        size="sm"
        leftIcon={RefreshCw}
        loading={busy}
        onPress={onRefresh}
        accessibilityLabel={t("providerUsage.nativeStats.refresh")}
      >
        {t(busy ? "providerUsage.nativeStats.refreshing" : "providerUsage.nativeStats.refresh")}
      </Button>
    ),
    [busy, onRefresh, t],
  );
  return (
    <SettingsSection
      title={t("providerUsage.nativeStats.title")}
      testID="omp-native-stats-section"
      trailing={refreshButton}
    >
      <SegmentedControl
        options={rangeOptions}
        value={range}
        onValueChange={setRange}
        size="sm"
        style={styles.ranges}
      />
      <OmpStatsBody view={view} onRefresh={onRefresh} />
    </SettingsSection>
  );
}

function OmpStatsBody({ view, onRefresh }: { view: OmpStatsView; onRefresh: () => void }) {
  const { t } = useTranslation();
  if (view.kind === "loading")
    return (
      <View style={[settingsStyles.card, styles.card]}>
        <Text style={styles.note}>{t("providerUsage.nativeStats.loading")}</Text>
      </View>
    );
  if (view.kind === "error") {
    return (
      <Alert
        variant="error"
        title={t("providerUsage.nativeStats.errorTitle")}
        description={t(`providerUsage.nativeStats.${view.reason}`)}
      >
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {t("providerUsage.nativeStats.retry")}
        </Button>
      </Alert>
    );
  }
  if (view.stats.status !== "available") {
    return (
      <Alert
        variant="error"
        title={t("providerUsage.nativeStats.errorTitle")}
        description={t(`providerUsage.nativeStats.reasons.${view.stats.reason}`)}
      >
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {t("providerUsage.nativeStats.retry")}
        </Button>
      </Alert>
    );
  }
  return (
    <>
      {view.refreshFailed ? (
        <Alert variant="error" description={t("providerUsage.nativeStats.refreshFailed")} />
      ) : null}
      <OmpStatsSnapshotCards snapshot={view.stats} />
    </>
  );
}

function OmpStatsSnapshotCards({ snapshot }: { snapshot: OmpStatsSnapshot }) {
  const { t, i18n } = useTranslation();
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const compactNumber = useMemo(
    () => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 2 }),
    [i18n.language],
  );
  const currency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }),
    [i18n.language],
  );
  const headlineCurrency = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const overall = snapshot.overall;
  const metrics = [
    {
      key: "requests",
      value: number.format(overall.totalRequests),
      displayValue:
        overall.totalRequests >= 1_000_000
          ? compactNumber.format(overall.totalRequests)
          : undefined,
      hint: (
        <>
          <Text testID="omp-native-stats-failed">{number.format(overall.failedRequests)}</Text>{" "}
          {t("providerUsage.nativeStats.failedLabel")}
        </>
      ),
      warning: overall.failedRequests > 0,
    },
    {
      key: "totalTokens",
      value: number.format(overall.totalTokens),
      displayValue:
        overall.totalTokens >= 1_000_000 ? compactNumber.format(overall.totalTokens) : undefined,
      hint: t("providerUsage.nativeStats.includesCache"),
    },
    {
      key: "cost",
      value: formatCost(overall, currency, t("providerUsage.nativeStats.unpricedCost")),
      displayValue: formatCost(
        overall,
        overall.totalCostUsd > 0 && overall.totalCostUsd < 0.01 ? currency : headlineCurrency,
        t("providerUsage.nativeStats.unpricedCost"),
      ),
      hint:
        overall.unpricedRequests > 0
          ? t("providerUsage.nativeStats.unpricedShort", { count: overall.unpricedRequests })
          : t("providerUsage.nativeStats.notBill"),
      warning: overall.unpricedRequests > 0,
    },
    {
      key: "transcripts",
      value: number.format(overall.transcriptCount),
      displayValue:
        overall.transcriptCount >= 1_000_000
          ? compactNumber.format(overall.transcriptCount)
          : undefined,
      hint: t("providerUsage.nativeStats.notSessions"),
    },
  ];
  return (
    <>
      <View style={styles.summary} testID="omp-native-stats-summary">
        <View style={styles.metaLine}>
          <Text style={styles.note}>
            {t("providerUsage.nativeStats.scope", {
              profile:
                snapshot.scope.profile === "default"
                  ? t("providerUsage.nativeStats.defaultProfile")
                  : snapshot.scope.profile,
            })}
          </Text>
          <Text style={styles.note}>
            {t("providerUsage.nativeStats.updatedAt", {
              time: new Date(snapshot.fetchedAt).toLocaleTimeString(i18n.language, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </Text>
        </View>
        {overall.totalRequests === 0 ? (
          <Text style={styles.note}>{t("providerUsage.nativeStats.empty")}</Text>
        ) : null}
        <View style={styles.metricGrid}>
          {metrics.map(({ key, value, displayValue, hint, warning }) => (
            <View key={key} style={[settingsStyles.card, styles.metricCard]}>
              <Text style={styles.note}>{t(`providerUsage.nativeStats.metrics.${key}`)}</Text>
              <OmpStatsMetricValue metric={key} value={value} displayValue={displayValue} />
              <Text
                style={[styles.caption, warning && styles.warning]}
                testID={`omp-native-stats-${key}-hint`}
              >
                {hint}
              </Text>
            </View>
          ))}
        </View>
        <OmpStatsTokens metrics={overall} number={number} />
      </View>
      {snapshot.byProvider.length + snapshot.byModel.length + snapshot.byAgentType.length > 0 ? (
        <OmpStatsBreakdown snapshot={snapshot} number={number} currency={currency} />
      ) : null}
      <OmpStatsDetails snapshot={snapshot} />
    </>
  );
}

function OmpStatsTokens({
  metrics,
  number,
}: {
  metrics: OmpStatsMetrics;
  number: Intl.NumberFormat;
}) {
  const { t, i18n } = useTranslation();
  const percent = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [i18n.language],
  );
  const promptTokens =
    metrics.totalInputTokens + metrics.totalCacheReadTokens + metrics.totalCacheWriteTokens;
  const hitRate =
    promptTokens > 0 ? percent.format(metrics.totalCacheReadTokens / promptTokens) : "—";
  const tokens = [
    ["input", metrics.totalInputTokens],
    ["output", metrics.totalOutputTokens],
    ["cacheRead", metrics.totalCacheReadTokens],
    ["cacheWrite", metrics.totalCacheWriteTokens],
  ] as const;
  return (
    <View style={settingsStyles.card}>
      <View style={styles.tokenHeader}>
        <Text style={styles.heading}>{t("providerUsage.nativeStats.tokensTitle")}</Text>
      </View>
      <View style={styles.tokenGrid}>
        {tokens.map(([key, value]) => (
          <View key={key} style={styles.tokenCell}>
            {key === "cacheWrite" ? (
              <Tooltip enabledOnDesktop enabledOnMobile>
                <TooltipTrigger
                  style={styles.cacheRate}
                  accessibilityRole="button"
                  accessibilityLabel={t("providerUsage.nativeStats.metrics.cacheWrite")}
                >
                  <Text style={styles.note}>
                    {t("providerUsage.nativeStats.metrics.cacheWrite")}
                  </Text>
                  <CacheWriteInfo uniProps={cacheWriteInfoProps} />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <Text style={styles.tooltipNote}>
                    {t("providerUsage.nativeStats.cacheWriteNotice")}
                  </Text>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Text style={styles.note}>{t(`providerUsage.nativeStats.metrics.${key}`)}</Text>
            )}
            <Text style={styles.tokenValue} selectable testID={`omp-native-stats-${key}`}>
              {number.format(value)}
            </Text>
          </View>
        ))}
        <Tooltip enabledOnDesktop enabledOnMobile>
          <TooltipTrigger
            style={styles.tokenCell}
            accessibilityRole="button"
            accessibilityLabel={`${t("providerUsage.nativeStats.cacheHitRate")}: ${hitRate}`}
          >
            <Text style={styles.note}>{t("providerUsage.nativeStats.cacheHitRate")}</Text>
            <Text style={styles.tokenValue} testID="omp-native-stats-cacheHitRate">
              {hitRate}
            </Text>
          </TooltipTrigger>
          <TooltipContent side="top">
            <Text style={styles.tooltipNote}>
              {t(
                promptTokens > 0
                  ? "providerUsage.nativeStats.cacheHitRateNotice"
                  : "providerUsage.nativeStats.noInputTokens",
              )}
            </Text>
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

function OmpStatsMetricValue({
  metric,
  value,
  displayValue,
}: {
  metric: string;
  value: string;
  displayValue?: string;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t(`providerUsage.nativeStats.metrics.${metric}`)}: ${value}`}
        >
          <Text style={styles.metricValue} testID={`omp-native-stats-${metric}`}>
            {displayValue ?? value}
          </Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text style={styles.value} selectable testID={`omp-native-stats-${metric}-exact`}>
          {value}
        </Text>
      </TooltipContent>
    </Tooltip>
  );
}

function formatCost(metrics: OmpStatsMetrics, currency: Intl.NumberFormat, unpriced: string) {
  return metrics.unpricedRequests > 0 && metrics.unpricedRequests === metrics.totalRequests
    ? unpriced
    : currency.format(metrics.totalCostUsd);
}

function OmpStatsBreakdown({
  snapshot,
  number,
  currency,
}: {
  snapshot: OmpStatsSnapshot;
  number: Intl.NumberFormat;
  currency: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<Breakdown>("byProvider");
  const [compact, setCompact] = useState(false);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setCompact(event.nativeEvent.layout.width < 560);
  }, []);
  const options = useMemo(
    () =>
      BREAKDOWNS.map((value) => ({
        value,
        label: t(`providerUsage.nativeStats.${value}`),
        testID: `omp-native-stats-tab-${value}`,
      })),
    [t],
  );
  const rows = useMemo<BreakdownRow[]>(() => {
    switch (group) {
      case "byProvider":
        return snapshot.byProvider.map((row) => ({
          id: row.provider,
          label: row.provider,
          metrics: row,
        }));
      case "byModel":
        return snapshot.byModel.map((row) => ({
          id: JSON.stringify([row.provider, row.model]),
          label: row.model,
          provider: row.provider,
          metrics: row,
        }));
      case "byAgentType":
        return snapshot.byAgentType.map((row) => ({
          id: row.agentType,
          label: t(`providerUsage.nativeStats.agentTypes.${row.agentType}`),
          metrics: row,
        }));
    }
  }, [group, snapshot.byProvider, snapshot.byModel, snapshot.byAgentType, t]);
  return (
    <View style={settingsStyles.card} onLayout={onLayout}>
      <View style={styles.breakdownHeader}>
        <Text style={styles.heading}>{t("providerUsage.nativeStats.details")}</Text>
        <SegmentedControl options={options} value={group} onValueChange={setGroup} size="sm" />
      </View>
      <View testID={`omp-native-stats-${group}`}>
        {!compact ? (
          <View style={styles.tableHeader}>
            <Text style={[styles.caption, styles.nameCell]}>
              {t("providerUsage.nativeStats.requestDistribution")}
            </Text>
            <View style={styles.columns}>
              <Text style={[styles.caption, styles.requestColumn]}>
                {t("providerUsage.nativeStats.metrics.requests")}
              </Text>
              <Text style={[styles.caption, styles.tokenColumn]}>
                {t("providerUsage.nativeStats.metrics.totalTokens")}
              </Text>
              <Text style={[styles.caption, styles.costColumn]}>
                {t("providerUsage.nativeStats.costColumn")}
              </Text>
            </View>
          </View>
        ) : null}
        {rows.length === 0 ? (
          <Text style={[styles.note, styles.card]}>{t("providerUsage.nativeStats.empty")}</Text>
        ) : null}
        {rows.map(({ id, label, provider, metrics }) => (
          <OmpStatsBreakdownRow
            key={id}
            label={label}
            provider={provider}
            metrics={metrics}
            totalRequests={snapshot.overall.totalRequests}
            compact={compact}
            group={group}
            number={number}
            currency={currency}
          />
        ))}
      </View>
    </View>
  );
}

function OmpStatsBreakdownRow({
  label,
  provider,
  metrics,
  totalRequests,
  compact,
  group,
  number,
  currency,
}: {
  label: string;
  provider?: string;
  metrics: OmpStatsMetrics;
  totalRequests: number;
  compact: boolean;
  group: Breakdown;
  number: Intl.NumberFormat;
  currency: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const shareStyle = useMemo(
    () => ({
      width:
        `${totalRequests > 0 ? Math.min(100, (metrics.totalRequests / totalRequests) * 100) : 0}%` as `${number}%`,
    }),
    [metrics.totalRequests, totalRequests],
  );
  return (
    <View
      style={[styles.tableRow, compact && styles.compactRow]}
      testID={`omp-native-stats-${group}-row`}
    >
      <View style={styles.nameCell}>
        <Text style={styles.label} selectable testID="omp-native-stats-breakdown-label">
          {label}
        </Text>
        {provider ? (
          <Text style={styles.caption} testID="omp-native-stats-breakdown-provider">
            {provider}
          </Text>
        ) : null}
        <View style={styles.shareTrack} aria-hidden>
          <View style={[styles.shareFill, shareStyle]} />
        </View>
      </View>
      <View style={[styles.columns, compact && styles.compactColumns]}>
        <View style={compact ? styles.compactCell : styles.requestColumn}>
          {compact ? (
            <Text style={styles.caption}>{t("providerUsage.nativeStats.metrics.requests")}</Text>
          ) : null}
          <Text style={styles.value} selectable testID="omp-native-stats-breakdown-requests">
            {number.format(metrics.totalRequests)}
          </Text>
        </View>
        <View style={compact ? styles.compactCell : styles.tokenColumn}>
          {compact ? (
            <Text style={styles.caption}>{t("providerUsage.nativeStats.metrics.totalTokens")}</Text>
          ) : null}
          <Text style={styles.value} selectable testID="omp-native-stats-breakdown-tokens">
            {number.format(metrics.totalTokens)}
          </Text>
        </View>
        <View style={compact ? styles.compactCell : styles.costColumn}>
          {compact ? (
            <Text style={styles.caption}>{t("providerUsage.nativeStats.costColumn")}</Text>
          ) : null}
          <Text style={styles.value} selectable testID="omp-native-stats-breakdown-cost">
            {formatCost(metrics, currency, t("providerUsage.nativeStats.unpricedCost"))}
          </Text>
          {metrics.unpricedRequests > 0 ? (
            <Text
              style={[styles.caption, styles.warning]}
              testID="omp-native-stats-breakdown-unpriced"
            >
              {t("providerUsage.nativeStats.unpricedShort", { count: metrics.unpricedRequests })}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function OmpStatsDetails({ snapshot }: { snapshot: OmpStatsSnapshot }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const onToggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.details}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={expanded ? ChevronUp : ChevronDown}
        onPress={onToggle}
        accessibilityState={accessibilityState}
        aria-expanded={expanded}
        style={styles.detailsToggle}
        testID="omp-native-stats-details-toggle"
      >
        {t("providerUsage.nativeStats.about")}
      </Button>
      {expanded ? (
        <View style={[settingsStyles.card, styles.card]} testID="omp-native-stats-details">
          {["indexNotice", "tokenNotice", "transcriptNotice", "costNotice"].map((key) => (
            <Text key={key} style={styles.note}>
              {t(`providerUsage.nativeStats.${key}`)}
            </Text>
          ))}
          <View style={styles.indexDetails}>
            <Text style={styles.caption} testID="omp-native-stats-indexedThrough">
              {snapshot.indexedThrough === null
                ? t("providerUsage.nativeStats.noIndexedRequests")
                : t("providerUsage.nativeStats.indexedThrough", {
                    time: new Date(snapshot.indexedThrough).toLocaleString(i18n.language),
                  })}
            </Text>
            <Text style={styles.caption} testID="omp-native-stats-fetchedAt">
              {t("providerUsage.nativeStats.fetchedAt", {
                time: new Date(snapshot.fetchedAt).toLocaleString(i18n.language),
              })}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  ranges: {
    alignSelf: "flex-start",
    flexWrap: "wrap",
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
  },
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  summary: { gap: theme.spacing[3] },
  metaLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  metricCard: {
    flexGrow: 1,
    flexBasis: "22%",
    minWidth: 145,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  metricValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  tokenHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  cacheRate: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "flex-start",
  },
  tooltipNote: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    maxWidth: 280,
  },
  tokenGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  tokenCell: { flexGrow: 1, flexBasis: "16%", minWidth: 100, gap: theme.spacing[2] },
  tokenValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontVariant: ["tabular-nums"],
  },
  breakdownHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  compactRow: { flexDirection: "column", alignItems: "stretch", gap: theme.spacing[3] },
  nameCell: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  columns: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[4] },
  requestColumn: { width: 64, textAlign: "right", alignItems: "flex-end" },
  tokenColumn: { width: 104, textAlign: "right", alignItems: "flex-end" },
  costColumn: { width: 100, textAlign: "right", alignItems: "flex-end", gap: theme.spacing[1] },
  compactColumns: { justifyContent: "space-between" },
  compactCell: { flex: 1, gap: theme.spacing[1], alignItems: "flex-start" },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 18 },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning },
  shareTrack: {
    height: 3,
    maxWidth: 160,
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    marginTop: theme.spacing[1],
    overflow: "hidden",
  },
  shareFill: {
    height: "100%",
    backgroundColor: theme.colors.foregroundMuted,
    borderRadius: theme.borderRadius.full,
  },
  details: { gap: theme.spacing[2] },
  detailsToggle: { alignSelf: "flex-start" },
  indexDetails: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));
