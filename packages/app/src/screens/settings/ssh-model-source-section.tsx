import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { setSshModelSource, useLocalModelBridgeStatus } from "@/runtime/local-model-bridge-runtime";
import { settingsStyles } from "@/styles/settings";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { SettingsSection } from "./settings-section";

export function SshModelSourceSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const bridge = useLocalModelBridgeStatus(serverId);
  const localServerId = useLocalDaemonServerId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleSourceChange = useCallback(
    (enabled: boolean) => {
      if (!bridge) return;
      setSaving(true);
      setError(null);
      void setSshModelSource(bridge.profile, enabled ? "local" : "remote")
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false));
    },
    [bridge],
  );
  const handleOpenLocalSettings = useCallback(() => {
    if (localServerId) router.push(buildSettingsHostSectionRoute(localServerId, "providers"));
  }, [localServerId]);
  if (!bridge) return null;
  const local = bridge.profile.modelSource !== "remote";
  return (
    <SettingsSection title={t("settings.host.modelSource.title")}>
      <View style={[settingsStyles.card, styles.content]} testID="ssh-model-source-settings">
        <Text style={settingsStyles.rowTitle}>{t("settings.host.modelSource.useLocal")}</Text>
        <Switch
          value={local}
          disabled={saving}
          onValueChange={handleSourceChange}
          testID="ssh-local-model-source-switch"
        />
        <Text style={settingsStyles.rowHint}>
          {t(
            local ? "settings.host.modelSource.localHint" : "settings.host.modelSource.remoteHint",
          )}
        </Text>
        <Text style={settingsStyles.rowHint} testID="ssh-model-source-status">
          {t(`settings.host.modelSource.status.${bridge.status}`, { count: bridge.modelCount })}
        </Text>
        {error || bridge.error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error ?? bridge.error}
          </Text>
        ) : null}
        {local ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!localServerId}
            onPress={handleOpenLocalSettings}
            testID="ssh-local-model-settings-link"
          >
            {t("settings.host.modelSource.openLocalSettings")}
          </Button>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
}));
