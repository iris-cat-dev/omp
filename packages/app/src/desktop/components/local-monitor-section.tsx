import { useCallback, useState } from "react";
import { Activity } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

export function DesktopLocalMonitorSection({ serverId }: { serverId: string }) {
  return getDesktopHost()?.monitor?.open ? <LocalMonitorSection serverId={serverId} /> : null;
}

function LocalMonitorSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isLocal = useIsLocalDaemon(serverId);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const openMonitor = getDesktopHost()?.monitor?.open;
  const onOpen = useCallback(async () => {
    if (!openMonitor || opening) return;
    setOpening(true);
    setFailed(false);
    try {
      await openMonitor();
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }, [openMonitor, opening]);

  if (!isLocal) return null;
  return (
    <SettingsSection title={t("providerUsage.localMonitor.title")}>
      <View style={settingsStyles.card} testID="omp-local-monitor-section">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>
              {t("providerUsage.localMonitor.description")}
            </Text>
          </View>
          <Button
            size="sm"
            variant="outline"
            leftIcon={Activity}
            loading={opening}
            onPress={onOpen}
            testID="omp-local-monitor-open"
          >
            {t("providerUsage.localMonitor.open")}
          </Button>
        </View>
        {failed ? (
          <Alert variant="error" description={t("providerUsage.localMonitor.openFailed")} />
        ) : null}
      </View>
    </SettingsSection>
  );
}
