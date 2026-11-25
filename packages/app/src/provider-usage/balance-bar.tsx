import { useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CompactMetricRow } from "./compact-metric-row";
import { formatOmpQuotaResetTime } from "@/components/omp-provider-quota";
import {
  clampPct,
  formatAmount,
  formatProviderUsageLabel,
  formatResetLabel,
} from "./format";
import type { ProviderUsageBalance, ProviderUsageTone } from "./types";

interface ResolvedBalance {
  amountText: string;
  usedPct: number | null;
  summaryText: string;
}

export function resolveBalance(
  balance: ProviderUsageBalance,
  t: TFunction,
  locale: string,
  compact: boolean,
): ResolvedBalance {
  const { used, remaining, limit, unit } = balance;
  const amount = (value: number) => compact
    ? value.toLocaleString(locale, {
        ...(unit === "usd" ? { style: "currency", currency: "USD" } : {}),
        maximumFractionDigits: 20,
      })
    : formatAmount(value, unit, locale);
  if (limit != null && limit > 0) {
    const usedAmount = used ?? (remaining != null ? limit - remaining : null);
    const usedPct = usedAmount != null ? (usedAmount / limit) * 100 : null;
    const reading = `${usedAmount != null ? amount(usedAmount) : "—"} / ${amount(limit)}`;
    const amountText = compact ? t("providerUsage.amountUsed", { amount: reading }) : reading;
    const summaryText = compact && usedPct != null
      ? t("providerUsage.amountUsed", { amount: (usedPct / 100).toLocaleString(locale, { style: "percent" }) })
      : amountText;
    return { amountText, summaryText, usedPct };
  }
  const reading = remaining ?? used;
  if (reading == null) return { amountText: "—", summaryText: "—", usedPct: null };
  const exact = amount(reading);
  const abbreviated = compact && exact.length > 10
    ? `≈${reading.toLocaleString(locale, {
        notation: "compact",
        maximumSignificantDigits: 3,
        ...(unit === "usd" ? { style: "currency", currency: "USD" } : {}),
      })}`
    : exact;
  const label = remaining != null ? "providerUsage.amountLeft" : "providerUsage.amountUsed";
  const amountText = remaining != null || compact ? t(label, { amount: exact }) : exact;
  return {
    amountText,
    summaryText: abbreviated === exact ? amountText : t(label, { amount: abbreviated }),
    usedPct: null,
  };
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

export function ProviderUsageBalanceBar({
  balance,
  showReset = true,
  compact = false,
  resolved,
}: {
  balance: ProviderUsageBalance;
  showReset?: boolean;
  compact?: boolean;
  resolved?: ResolvedBalance;
}) {
  const { t, i18n } = useTranslation();
  const { amountText, summaryText, usedPct } =
    resolved ?? resolveBalance(balance, t, i18n.language, compact);
  const label = formatProviderUsageLabel(balance.id, balance.label, t);
  const tone = balance.tone ?? "default";
  const resetLabel = showReset ? formatResetLabel(balance.resetsAt, t, compact) : null;
  const resetTime =
    compact && showReset ? formatOmpQuotaResetTime(balance.resetsAt, i18n.language) : null;

  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, fillToneStyle(tone), { width: `${clampPct(usedPct ?? 0)}%` }],
    [usedPct, tone],
  );

  return (
    <View style={styles.container}>
      {compact ? (
        <CompactMetricRow label={label} value={showReset ? amountText : summaryText} />
      ) : (
        <View style={styles.labelRow}>
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.value}>
            {amountText}
            {resetLabel ? <Text style={styles.reset}>{` · ${resetLabel}`}</Text> : null}
          </Text>
        </View>
      )}
      {usedPct != null ? (
        <View
          style={styles.track}
          accessibilityRole={compact ? "progressbar" : undefined}
          accessibilityLabel={compact ? label : undefined}
          aria-valuemin={compact ? 0 : undefined}
          aria-valuemax={compact ? 100 : undefined}
          aria-valuenow={compact ? clampPct(usedPct) : undefined}
          aria-valuetext={compact ? summaryText : undefined}
        >
          <View style={fillStyle} />
        </View>
      ) : null}
      {compact && resetLabel ? (
        <Text style={styles.reset}>{resetTime ? `${resetLabel} · ${resetTime}` : resetLabel}</Text>
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
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
