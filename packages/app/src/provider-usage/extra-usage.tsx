import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatOmpExtraUsageUsd, formatPct } from "./format";

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

function openClaudeUsage(): void {
  void Linking.openURL(CLAUDE_USAGE_URL);
}

export function OmpExtraUsageDetails({
  extraUsage,
}: {
  extraUsage: NonNullable<OmpProviderAccountQuota["extraUsage"]>;
}) {
  const { t, i18n } = useTranslation();
  const unknown = t("providerUsage.extraUsage.unknown");
  const percentage =
    typeof extraUsage.usedPct === "number" && Number.isFinite(extraUsage.usedPct)
      ? ` · ${formatPct(extraUsage.usedPct)}`
      : "";
  return (
    <View style={styles.details}>
      <Text style={styles.text}>
        {t("providerUsage.extraUsage.title")}
        {" · "}
        {t(
          extraUsage.enabled
            ? "providerUsage.extraUsage.enabled"
            : "providerUsage.extraUsage.disabled",
        )}
        {percentage}
      </Text>
      <Text style={styles.text}>
        {t("providerUsage.extraUsage.spent")}
        {": "}
        {formatOmpExtraUsageUsd(extraUsage.usedUsd, unknown, i18n.language)}
      </Text>
      <Text style={styles.text}>
        {t("providerUsage.extraUsage.limit")}
        {": "}
        {formatOmpExtraUsageUsd(extraUsage.monthlyLimitUsd, unknown, i18n.language)}
      </Text>
      <Pressable accessibilityRole="link" onPress={openClaudeUsage}>
        <Text style={styles.link}>{t("providerUsage.extraUsage.billingNote")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: { gap: theme.spacing[1] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  link: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "underline",
  },
}));
