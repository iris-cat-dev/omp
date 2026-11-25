import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Wallet } from "lucide-react-native";
import { UsageSectionHeading } from "@/components/usage-section-heading";
import { isOmpQuotaStale } from "@/components/omp-provider-quota";
import { isWeb } from "@/constants/platform";
import { useOmpQuotaClock } from "@/hooks/use-omp-account-quota";
import { ProviderUsageBalanceBar, resolveBalance } from "./balance-bar";
import { CompactMetricRow } from "./compact-metric-row";
import { OmpExtraUsageDetails } from "./extra-usage";
import { formatProviderUsageLabel } from "./format";
import type { ProviderUsage, ProviderUsageTone } from "./types";
import { ProviderUsageWindowBar, windowNeedsAttention } from "./window-bar";

function isWarning(tone?: ProviderUsageTone) {
  return tone === "warning" || tone === "danger";
}

export function CompactAccount({
  usage,
  showAccountLabel,
  notices,
  footer,
  children,
}: {
  usage: ProviderUsage;
  showAccountLabel: boolean;
  notices: ReactNode;
  footer: string | null;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { windows, accountQuota, extraUsage } = usage;
  const details = usage.details ?? [];
  const balances = useMemo(
    () =>
      (usage.balances ?? []).map((balance) => ({
        balance,
        resolved: resolveBalance(balance, t, i18n.language, true),
      })),
    [usage.balances, t, i18n.language],
  );
  const now = useOmpQuotaClock(
    windows.some((window) => Boolean(window.resetsAt || window.runsOutAt)),
  );
  const stale = isOmpQuotaStale(accountQuota);

  // Ignore unknown placeholder windows when the provider supplied an actual balance or credit.
  const knownWindow = windows.find(
    (window) => window.usedPct != null || window.remainingPct != null || (!stale && window.limitReached),
  );
  const knownBalance = balances.find(
    ({ balance }) => balance.remaining != null || balance.used != null || balance.limit != null,
  );
  const credit = accountQuota?.credits;
  const knownDetail = details.find(
    (detail) => detail.id !== "codex_credits" || credit?.unlimited ||
      credit?.balance != null || credit?.hasCredits === false,
  );
  const primaryWindow = knownWindow ?? (!knownBalance && !knownDetail ? windows[0] : undefined);
  const primaryBalance = primaryWindow ? undefined : knownBalance ?? (!knownDetail ? balances[0] : undefined);
  const primaryDetail = !primaryWindow && !primaryBalance ? knownDetail ?? details[0] : undefined;
  const visibleWindows = windows.filter(
    (window) => window === primaryWindow || windowNeedsAttention(window, now, stale),
  );
  const visibleBalances = balances.filter(
    (item) => item === primaryBalance || isWarning(item.balance.tone) ||
      (!stale && item.resolved.usedPct != null && item.resolved.usedPct >= 100),
  );
  const visibleDetails = details.filter(
    (detail) => detail === primaryDetail || isWarning(detail.tone),
  );
  const extraLimitReached = !stale && extraUsage?.enabled && extraUsage.usedPct === 100;

  const title = usage.accountLabel && usage.sourceLabel ? usage.sourceLabel : usage.displayName;
  const account = usage.accountLabel && usage.accountLabel !== title ? usage.accountLabel : undefined;
  const plan = usage.planLabel !== title && usage.planLabel !== account && usage.planLabel !== usage.displayName
    ? usage.planLabel : null;
  const metadata = [!showAccountLabel && account, plan].filter(Boolean).join(" · ");
  const rawCredit = !credit?.unlimited ? credit?.balance : null;
  // Approximate only the headline. Never parse the provider's decimal string for the exact reading.
  const creditNumber = Number(rawCredit);
  const shortCredit =
    rawCredit && rawCredit.length > 8 && Number.isFinite(creditNumber) && creditNumber !== 0
      ? `≈${creditNumber.toLocaleString(i18n.language, {
          notation: "compact",
          maximumSignificantDigits: 3,
        })}`
      : rawCredit;
  const hasDetails = Boolean(
    metadata || footer || extraUsage ||
    windows.length !== visibleWindows.length ||
    balances.length !== visibleBalances.length ||
    details.length !== visibleDetails.length ||
    visibleWindows.some((window) => window.resetsAt && Number.isFinite(Date.parse(window.resetsAt))) ||
    visibleBalances.some(({ balance, resolved }) =>
      resolved.amountText !== resolved.summaryText ||
      (balance.resetsAt && Number.isFinite(Date.parse(balance.resetsAt))),
    ) ||
    (shortCredit !== rawCredit && visibleDetails.some((detail) => detail.id === "codex_credits")),
  );
  const shownWindows = expanded ? windows : visibleWindows;
  const shownBalances = expanded ? balances : visibleBalances;
  const shownDetails = expanded ? details : visibleDetails;

  return (
    <View style={styles.account}>
      <UsageSectionHeading
        icon={Wallet}
        title={title}
        value={showAccountLabel ? account : undefined}
        onPress={hasDetails ? () => setExpanded((open) => !open) : undefined}
        expanded={hasDetails ? expanded : undefined}
        testID="provider-usage-heading"
      />
      {notices}
      {shownWindows.length || shownBalances.length || shownDetails.length || extraLimitReached || (expanded && hasDetails) ? (
        <View style={styles.readings}>
          {shownWindows.length || shownBalances.length ? (
            <View testID="provider-usage-metrics" style={styles.metrics}>
              {shownWindows.map((window) => (
                <ProviderUsageWindowBar
                  key={window.id}
                  window={window}
                  compact
                  showReset={expanded}
                  stale={stale}
                  observationTime={now}
                />
              ))}
              {shownBalances.map(({ balance, resolved }) => (
                <ProviderUsageBalanceBar
                  key={balance.id}
                  balance={balance}
                  resolved={resolved}
                  compact
                  showReset={expanded}
                />
              ))}
            </View>
          ) : null}
          {shownDetails.map((detail) => {
            if (detail.id === "codex_credits" && accountQuota) {
              const value = expanded ? rawCredit : shortCredit;
              return value != null ? (
                <CompactMetricRow key={detail.id} label={t("providerUsage.creditBalance")} value={value} />
              ) : (
                <Text key={detail.id} style={styles.meta}>{detail.value}</Text>
              );
            }
            return (
              <CompactMetricRow
                key={detail.id}
                label={formatProviderUsageLabel(detail.id, detail.label, t)}
                value={detail.value}
              />
            );
          })}
          {expanded && extraUsage ? (
            <OmpExtraUsageDetails extraUsage={extraUsage} />
          ) : extraLimitReached ? (
            <CompactMetricRow
              label={t("providerUsage.extraUsage.title")}
              value={t("providerUsage.amountUsed", { amount: "100%" })}
            />
          ) : null}
          {expanded && metadata ? <Text style={styles.meta}>{metadata}</Text> : null}
          {expanded && footer ? <Text style={styles.meta}>{footer}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  account: { minWidth: 0, gap: theme.spacing[1] },
  readings: { minWidth: 0, paddingStart: 36, gap: theme.spacing[2] },
  metrics: { gap: theme.spacing[2] },
  meta: {
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
