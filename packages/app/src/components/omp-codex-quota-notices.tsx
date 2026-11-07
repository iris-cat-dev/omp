import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { formatOmpQuotaResetTime, isOmpQuotaStale } from "./omp-provider-quota";

export function OmpCodexQuotaNotices({ quota }: { quota?: OmpProviderAccountQuota }) {
  const { t, i18n } = useTranslation();
  if (!quota || quota.status === "available") return null;
  const query = quota.queryError;
  const reason = query
    ? t(`providerUsage.queryFailure.${query.kind}`, { status: query.httpStatus ?? "—" })
    : quota.error || t("providerUsage.usageUnknown");
  const observedAt = isOmpQuotaStale(quota)
    ? formatOmpQuotaResetTime(quota.lastSuccessfulAt, i18n.language)
    : null;
  const retryAt = formatOmpQuotaResetTime(query?.retryAt, i18n.language);
  return (
    <View style={styles.notices}>
      {observedAt ? (
        <Text style={styles.detail}>
          {t("providerUsage.lastSuccessfulObservation", { time: observedAt })}
        </Text>
      ) : null}
      <Text style={styles.error}>{t("providerUsage.refreshFailure", { reason })}</Text>
      {retryAt ? (
        <Text style={styles.detail}>{t("providerUsage.queryRetryAt", { time: retryAt })}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notices: { gap: theme.spacing[1] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
