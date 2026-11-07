import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useOmpQuotaClock } from "@/hooks/use-omp-account-quota";
import { formatOmpQuotaCountdown, formatOmpQuotaResetTime } from "@/components/omp-provider-quota";
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
): string {
  if (reached && !stale) return t("providerUsage.limitReached");
  if (percentage !== null) return formatPct(percentage);
  return showRemaining ? t("providerUsage.usageUnknown") : "—";
}

export function ProviderUsageWindowBar({
  window,
  showReset = true,
  stale = false,
}: {
  window: ProviderUsageWindow;
  showReset?: boolean;
  stale?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const now = useOmpQuotaClock(showReset && Boolean(window.resetsAt));
  const usedPct = resolveUsedPct(window);
  const remainingPct = resolveRemainingPct(window);
  const showRemaining = window.percentageDisplay === "remaining";
  const displayedPct = showRemaining ? remainingPct : usedPct;
  const tone = stale
    ? "default"
    : (window.tone ?? (showRemaining ? deriveRemainingTone(remainingPct) : deriveTone(usedPct)));

  const fillWidth = clampPct(displayedPct ?? 0);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, fillToneStyle(tone), { width: `${fillWidth}%` }],
    [fillWidth, tone],
  );

  const isAtRisk = window.runsOutAt != null && window.shortfallPct != null;
  let trailing: string | null = null;
  if (isAtRisk) {
    trailing = formatRunsOutLabel(window.runsOutAt, t);
  } else if (showReset) {
    trailing =
      showRemaining && formatOmpQuotaCountdown(window.resetsAt, now) === ""
        ? t("providerUsage.awaitingVerification")
        : formatResetLabel(window.resetsAt, t);
  }
  const resetTime =
    showReset && showRemaining ? formatOmpQuotaResetTime(window.resetsAt, i18n.language) : null;

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {formatProviderUsageLabel(window.id, window.label, t)}
        </Text>
        <Text style={styles.value}>
          {formatWindowValue(window.limitReached === true, displayedPct, showRemaining, t, stale)}
          {trailing ? (
            <Text style={isAtRisk ? styles.atRisk : styles.reset}>{` · ${trailing}`}</Text>
          ) : null}
        </Text>
      </View>
      {displayedPct != null ? (
        <View style={styles.track}>
          <View style={fillStyle} />
        </View>
      ) : null}
      {resetTime ? (
        <Text style={styles.label}>
          {t("settings.providers.omp.multiAccount.quotaResetsAt", { time: resetTime })}
        </Text>
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
