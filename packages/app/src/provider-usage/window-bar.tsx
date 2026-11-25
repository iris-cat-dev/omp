import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useOmpQuotaClock } from "@/hooks/use-omp-account-quota";
import { formatOmpQuotaCountdown, formatOmpQuotaResetTime } from "@/components/omp-provider-quota";
import { CompactMetricRow } from "./compact-metric-row";
import {
  clampPct,
  formatPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatRunsOutLabel,
} from "./format";
import { deriveRemainingTone, deriveTone } from "./tone";
import type { ProviderUsageTone, ProviderUsageWindow } from "./types";

function resolveUsedPct(window: ProviderUsageWindow): number | null {
  if (window.usedPct != null) return window.usedPct;
  if (window.remainingPct != null) return 100 - window.remainingPct;
  return null;
}

function resolveRemainingPct(window: ProviderUsageWindow): number | null {
  if (window.remainingPct != null) return window.remainingPct;
  if (window.usedPct != null) return 100 - window.usedPct;
  return null;
}

function windowTone(window: ProviderUsageWindow) {
  return (
    window.tone ??
    (window.percentageDisplay === "remaining"
      ? deriveRemainingTone(resolveRemainingPct(window))
      : deriveTone(resolveUsedPct(window)))
  );
}

function awaitsVerification(window: ProviderUsageWindow, now: number): boolean {
  return (
    window.percentageDisplay === "remaining" &&
    formatOmpQuotaCountdown(window.resetsAt, now) === ""
  );
}

export function windowNeedsAttention(
  window: ProviderUsageWindow,
  now: number,
  stale: boolean,
): boolean {
  if (awaitsVerification(window, now) || (window.runsOutAt != null && window.shortfallPct != null)) {
    return true;
  }
  const tone = windowTone(window);
  return !stale && (window.limitReached === true || tone === "warning" || tone === "danger");
}

function fillToneStyle(tone: ProviderUsageTone) {
  switch (tone) {
    case "ok":
      return styles.fillOk;
    case "warning":
      return styles.fillWarning;
    case "danger":
      return styles.fillDanger;
    default:
      return styles.fillDefault;
  }
}

function formatWindowValue(
  reached: boolean,
  percentage: number | null,
  showRemaining: boolean,
  t: TFunction,
  stale: boolean,
  compact: boolean,
): string {
  if (reached && !stale) return t("providerUsage.limitReached");
  if (percentage !== null) {
    const amount = formatPct(percentage);
    if (!compact) return amount;
    return t(showRemaining ? "providerUsage.amountLeft" : "providerUsage.amountUsed", { amount });
  }
  return showRemaining ? t("providerUsage.usageUnknown") : "—";
}

export function ProviderUsageWindowBar({
  window,
  showReset = true,
  compact = false,
  stale = false,
  observationTime,
}: {
  window: ProviderUsageWindow;
  showReset?: boolean;
  compact?: boolean;
  stale?: boolean;
  observationTime?: number;
}) {
  const { t, i18n } = useTranslation();
  const clock = useOmpQuotaClock(
    observationTime === undefined && showReset && Boolean(window.resetsAt),
  );
  const now = observationTime ?? clock;
  const usedPct = resolveUsedPct(window);
  const remainingPct = resolveRemainingPct(window);
  const showRemaining = window.percentageDisplay === "remaining";
  const displayedPct = showRemaining ? remainingPct : usedPct;
  const tone = stale ? "default" : windowTone(window);

  const fillWidth = clampPct(displayedPct ?? 0);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, fillToneStyle(tone), { width: `${fillWidth}%` }],
    [fillWidth, tone],
  );

  const isAtRisk = window.runsOutAt != null && window.shortfallPct != null;
  const awaitingVerification = (showReset || compact) && awaitsVerification(window, now);
  let trailing: string | null = null;
  if (isAtRisk) {
    trailing = formatRunsOutLabel(window.runsOutAt, t);
  } else if (awaitingVerification) {
    trailing = t("providerUsage.awaitingVerification");
  } else if (showReset) {
    trailing = formatResetLabel(window.resetsAt, t, compact);
  }
  const resetTime =
    showReset && (showRemaining || compact)
      ? formatOmpQuotaResetTime(window.resetsAt, i18n.language)
      : null;
  const label = formatProviderUsageLabel(window.id, window.label, t);
  const value = formatWindowValue(
    window.limitReached === true,
    displayedPct,
    showRemaining,
    t,
    stale,
    compact,
  );
  // A normal countdown identifies the adjacent timestamp as a reset. Risk and
  // verification notices describe different events, so label the reset explicitly.
  const resetCaption =
    compact && trailing && !isAtRisk && !awaitingVerification
      ? resetTime
      : resetTime && t("settings.providers.omp.multiAccount.quotaResetsAt", { time: resetTime });

  return (
    <View style={styles.container}>
      {compact ? (
        <CompactMetricRow label={label} value={value} />
      ) : (
        <View style={styles.labelRow}>
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.value}>
            {value}
            {trailing ? (
              <Text style={isAtRisk ? styles.atRisk : styles.reset}>{` · ${trailing}`}</Text>
            ) : null}
          </Text>
        </View>
      )}
      {displayedPct != null ? (
        <View
          style={styles.track}
          accessibilityRole={compact ? "progressbar" : undefined}
          accessibilityLabel={compact ? label : undefined}
          aria-valuemin={compact ? 0 : undefined}
          aria-valuemax={compact ? 100 : undefined}
          aria-valuenow={compact ? fillWidth : undefined}
          aria-valuetext={compact ? value : undefined}
        >
          <View style={fillStyle} />
        </View>
      ) : null}
      {compact && trailing ? (
        <Text style={styles.label}>
          <Text style={isAtRisk ? styles.atRisk : styles.reset}>{trailing}</Text>
          {resetCaption ? ` · ${resetCaption}` : null}
        </Text>
      ) : resetCaption ? (
        <Text style={styles.label}>{resetCaption}</Text>
      ) : null}
      {compact && isAtRisk && awaitingVerification ? (
        <Text style={styles.atRisk}>{t("providerUsage.awaitingVerification")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 3,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  reset: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  atRisk: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.normal,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
  fillDefault: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillOk: {
    backgroundColor: theme.colors.palette.green[500],
  },
  fillWarning: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  fillDanger: {
    backgroundColor: theme.colors.destructive,
  },
}));
