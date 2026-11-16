import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { openExternalUrl } from "@/utils/open-external-url";
import type { ProviderUsage } from "./types";

function openOpenAiBilling(): void {
  void openExternalUrl("https://platform.openai.com/settings/organization/billing/overview");
}

function openOpenAiUsage(): void {
  void openExternalUrl("https://platform.openai.com/usage");
}

export function ProviderUsageUnsupportedNotice({ usage }: { usage: ProviderUsage }) {
  const { t } = useTranslation();
  if (usage.unsupportedReason !== "openai_balance_credentials") return null;
  return (
    <View testID="provider-usage-unsupported-notice" style={styles.notice}>
      <Text style={styles.text}>{t("providerUsage.openaiBalance.explanation")}</Text>
      <View style={styles.links}>
        <Pressable accessibilityRole="link" onPress={openOpenAiBilling}>
          <Text style={styles.link}>{t("providerUsage.openaiBalance.billing")}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" onPress={openOpenAiUsage}>
          <Text style={styles.link}>{t("providerUsage.openaiBalance.usage")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: { gap: theme.spacing[2] },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  links: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  link: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "underline",
  },
}));
