import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import { selectProviderUsages } from "./login-usage";
import type { ProviderUsageView } from "./types";

// Renders the active agent's provider usage inside the context-meter tooltip.
// Returns nothing when the active provider has no usage entry, so the meter's
// own context section stays the whole tooltip.
export function ProviderUsageTooltipSection({
  view,
  activeProviderId,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (view.kind !== "ready") {
    return (
      <View style={styles.section}>
        {view.kind === "loading" ? (
          <Text style={styles.detail}>{t("providerUsage.tooltipLoading")}</Text>
        ) : (
          <Text style={styles.error}>{view.message}</Text>
        )}
      </View>
    );
  }

  const usages = selectProviderUsages(view.payload.providers, activeProviderId);
  if (usages.length === 0) return null;

  return (
    <>
      {usages.map((usage) => (
        <View key={usage.providerId} style={styles.section}>
          <ProviderUsageCard usage={usage} compact showAccountLabel={usages.length > 1} />
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
    paddingTop: theme.spacing[2],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
