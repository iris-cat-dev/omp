import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useOmpProviderAccountQuota } from "@/hooks/use-omp-account-quota";
import { selectOmpQuotaAccounts } from "@/components/omp-provider-accounts";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import {
  buildOmpAccountProviderUsage,
  createOmpAccountUsageCopy,
  mergeOmpAccountProviderUsage,
} from "@/provider-usage/omp-account";
import { formatSessionCost, formatTokenCount } from "./context-window-meter.utils";

interface OmpClaudeQuotaEntryProps {
  serverId?: string;
  accountCredentialId?: string | null;
  accountCredentialIds?: readonly string[];
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  onOpenPromptAnalysis?: () => void;
}

function ContextUsageDetails({ maxTokens, usedTokens, totalCostUsd }: OmpClaudeQuotaEntryProps) {
  const { t } = useTranslation();
  const cost = typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  const hasUsage =
    maxTokens !== null &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0 &&
    usedTokens !== null &&
    Number.isFinite(usedTokens) &&
    usedTokens >= 0;
  return (
    <>
      {hasUsage ? (
        <>
          <Text style={styles.title}>{t("contextWindow.title")}</Text>
          <Text style={styles.detail}>
            {t("contextWindow.used", { percentage: Math.round((usedTokens / maxTokens) * 100) })}
          </Text>
          <Text style={styles.detail}>
            {t("contextWindow.tokens", {
              used: formatTokenCount(usedTokens),
              max: formatTokenCount(maxTokens),
            })}
          </Text>
        </>
      ) : null}
      {cost ? <Text style={styles.detail}>{t("contextWindow.sessionCost", { cost })}</Text> : null}
    </>
  );
}

export function OmpClaudeQuotaEntry(props: OmpClaudeQuotaEntryProps) {
  const { serverId, accountCredentialId, accountCredentialIds, onOpenPromptAnalysis } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const accountQuota = useOmpProviderAccountQuota(serverId, "anthropic", open);
  const { refresh } = accountQuota;
  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);
  const openPromptAnalysis = useCallback(() => {
    setOpen(false);
    onOpenPromptAnalysis?.();
  }, [onOpenPromptAnalysis]);
  const refreshQuota = useCallback(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const header = useMemo(() => ({ title: t("providerUsage.claudeEntry") }), [t]);
  useEffect(() => {
    if (open) refreshQuota();
  }, [open, refreshQuota]);
  const view = useMemo(() => {
    let accounts = accountQuota.accounts;
    if (accountCredentialId) {
      accounts = selectOmpQuotaAccounts(
        accounts,
        Number(accountCredentialId),
        accountCredentialIds,
      );
    } else if (accountCredentialIds) {
      accounts = accounts.filter((account) =>
        accountCredentialIds.includes(String(account.credentialId)),
      );
    }
    const usage = buildOmpAccountProviderUsage(
      {
        ...accountQuota,
        accounts,
      },
      createOmpAccountUsageCopy("anthropic", t),
    );
    return mergeOmpAccountProviderUsage(
      { kind: "loading" },
      usage,
      accountQuota.loading,
      accountQuota.updatedAt,
    );
  }, [accountQuota, accountCredentialId, accountCredentialIds, t]);
  return (
    <>
      <Pressable
        style={styles.entry}
        hitSlop={8}
        onPress={openSheet}
        accessibilityRole="button"
        accessibilityLabel={t("providerUsage.claudeEntry")}
        accessibilityState={accessibilityState}
        testID="claude-quota-entry"
      >
        <Text style={styles.entryLabel}>{t("providerUsage.claudeEntry")}</Text>
      </Pressable>
      <AdaptiveModalSheet
        visible={open}
        onClose={closeSheet}
        header={header}
        sizeContentToCurrentSnapPoint
      >
        <View style={styles.content}>
          <Button size="sm" variant="ghost" disabled={accountQuota.loading} onPress={refreshQuota}>
            {t(accountQuota.loading ? "providerUsage.refreshing" : "providerUsage.refresh")}
          </Button>
          {!accountCredentialId && accountQuota.accounts.length > 1 ? (
            <Text style={styles.detail}>{t("providerUsage.accountNotSelected")}</Text>
          ) : null}
          {!accountQuota.loading && !accountQuota.provider ? (
            <Text style={styles.detail}>
              {accountQuota.error || t("providerUsage.status.unavailable")}
            </Text>
          ) : (
            <ProviderUsageTooltipSection view={view} activeProviderId="anthropic" />
          )}
          <ContextUsageDetails {...props} />
          {props.onOpenPromptAnalysis ? (
            <Button
              size="sm"
              variant="outline"
              onPress={openPromptAnalysis}
              testID="context-window-prompt-analysis"
            >
              {t("promptAnalysis.title")}
            </Button>
          ) : null}
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  entry: {
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  entryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  content: { gap: theme.spacing[3] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
