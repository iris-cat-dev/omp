import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { OmpClaudeLimitResetDetails } from "@/components/omp-claude-limit-reset-details";
import { OmpCodexQuotaDetails, OmpQuotaServerContext } from "@/components/omp-codex-quota-details";
import { DesktopLocalMonitorSection } from "@/desktop/components/local-monitor-section";
import { useOmpProviderAccountQuota } from "@/hooks/use-omp-account-quota";
import {
  buildOmpAccountProviderUsage,
  createOmpAccountUsageCopy,
  mergeOmpAccountProviderUsage,
} from "@/provider-usage/omp-account";
import { ProviderUsageSettingsSection } from "@/provider-usage/settings-section";
import { OmpStatsSettingsSection } from "@/provider-usage/omp-stats-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

export function HostUsagePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { view: baseUsageView, refresh: refreshProviderUsage } = useProviderUsage(serverId);
  const codex = useOmpProviderAccountQuota(serverId, "openai-codex");
  const claude = useOmpProviderAccountQuota(serverId, "anthropic");
  const { accountUsage, accountDetails } = useMemo(() => {
    const codexUsage = buildOmpAccountProviderUsage(
      codex,
      createOmpAccountUsageCopy("openai-codex", t),
    );
    const claudeUsage = buildOmpAccountProviderUsage(
      claude,
      createOmpAccountUsageCopy("anthropic", t),
    );
    const details = new Map<string, ReactNode>();
    codex.accounts.forEach((account, index) => {
      details.set(
        `openai-codex:${account.credentialId}`,
        <OmpCodexQuotaDetails
          account={account}
          accountLabel={codexUsage[index]?.displayName ?? "OpenAI Codex"}
          showCreditBalance={false}
        />,
      );
    });
    claude.accounts.forEach((account, index) => {
      details.set(
        `anthropic:${account.credentialId}`,
        <OmpClaudeLimitResetDetails
          account={account}
          accountLabel={claudeUsage[index]?.displayName ?? "Claude"}
        />,
      );
    });
    return { accountUsage: [...codexUsage, ...claudeUsage], accountDetails: details };
  }, [codex, claude, t]);
  const usageView = useMemo(
    () =>
      mergeOmpAccountProviderUsage(
        baseUsageView,
        accountUsage,
        codex.loading || claude.loading,
        codex.updatedAt ?? claude.updatedAt,
      ),
    [accountUsage, baseUsageView, claude.loading, claude.updatedAt, codex.loading, codex.updatedAt],
  );
  const refreshAccountUsage = codex.refresh;
  const handleRefresh = useCallback(() => {
    void Promise.all([refreshProviderUsage(), refreshAccountUsage()]);
  }, [refreshAccountUsage, refreshProviderUsage]);

  if (!hosts.some((host) => host.serverId === serverId)) {
    return (
      <View style={settingsStyles.card}>
        <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
      </View>
    );
  }

  return (
    <OmpQuotaServerContext.Provider value={serverId}>
      <OmpStatsSettingsSection serverId={serverId} />
      <DesktopLocalMonitorSection serverId={serverId} />
      <ProviderUsageSettingsSection
        view={usageView}
        onRefresh={handleRefresh}
        accountDetails={accountDetails}
      />
    </OmpQuotaServerContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
