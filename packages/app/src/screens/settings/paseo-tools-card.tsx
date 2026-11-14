import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { OmpDesktopToolCapabilities } from "@omp-desktop/protocol/messages";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;
type CapabilityKey = keyof OmpDesktopToolCapabilities;

const capabilityKeys = [
  "workspace",
  "agents",
  "permissions",
  "terminals",
  "scripts",
  "providers",
  "optional",
] as const satisfies readonly CapabilityKey[];

interface CapabilityRowProps {
  capabilityKey: CapabilityKey;
  enabled: boolean;
  toolsEnabled: boolean;
  onValueChange: (key: CapabilityKey, next: boolean) => void;
}

function CapabilityRow({
  capabilityKey,
  enabled,
  toolsEnabled,
  onValueChange,
}: CapabilityRowProps) {
  const { t } = useTranslation();
  const titleKey =
    capabilityKey === "optional"
      ? "settings.host.orchestration.enableTools.optional.title"
      : `settings.host.orchestration.enableTools.capabilities.${capabilityKey}.title`;
  const bodyKey =
    capabilityKey === "optional"
      ? "settings.host.orchestration.enableTools.optional.body"
      : `settings.host.orchestration.enableTools.capabilities.${capabilityKey}.body`;
  const handleValueChange = useCallback(
    (next: boolean) => onValueChange(capabilityKey, next),
    [capabilityKey, onValueChange],
  );

  return (
    <View style={styles.capability}>
      <View style={styles.capabilityRow}>
        <View style={styles.capabilityContent}>
          <Text style={styles.capabilityTitle}>{t(titleKey)}</Text>
          <Text style={styles.capabilityBody}>{t(bodyKey)}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={handleValueChange}
          disabled={!toolsEnabled}
          accessibilityLabel={t(titleKey)}
          testID={`host-page-inject-mcp-capability-${capabilityKey}-switch`}
        />
      </View>
    </View>
  );
}

export function PaseoToolsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [expanded, setExpanded] = useState(false);

  const toolsEnabled = config?.mcp.injectIntoAgents !== false;
  const handleValueChange = useCallback(
    (next: boolean) => {
      void patchConfig({
        mcp: {
          injectIntoAgents: next,
        },
      });
    },
    [patchConfig],
  );
  const handleCapabilityValueChange = useCallback(
    (key: CapabilityKey, next: boolean) => {
      const toolCapabilities: Partial<OmpDesktopToolCapabilities> = { [key]: next };
      void patchConfig({ mcp: { toolCapabilities } });
    },
    [patchConfig],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-inject-mcp-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.orchestration.enableTools.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.orchestration.enableTools.hint")}
          </Text>
        </View>
        <Switch
          value={toolsEnabled}
          onValueChange={handleValueChange}
          accessibilityLabel={t("settings.host.orchestration.enableTools.accessibilityLabel")}
          testID="host-page-inject-mcp-switch"
        />
      </View>
      <Pressable
        style={[styles.detailsToggle, settingsStyles.rowBorder]}
        onPress={toggleExpanded}
        accessibilityRole="button"
        accessibilityState={expanded ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE}
        testID="host-page-inject-mcp-details-toggle"
      >
        <Text style={styles.detailsToggleText}>
          {t(
            expanded
              ? "settings.host.orchestration.enableTools.hideDetails"
              : "settings.host.orchestration.enableTools.showDetails",
          )}
        </Text>
        {expanded ? (
          <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View
          style={[styles.details, settingsStyles.rowBorder]}
          testID="host-page-inject-mcp-details"
        >
          {capabilityKeys.map((key) => (
            <CapabilityRow
              key={key}
              capabilityKey={key}
              enabled={config?.mcp.toolCapabilities?.[key] !== false}
              toolsEnabled={toolsEnabled}
              onValueChange={handleCapabilityValueChange}
            />
          ))}
          <Text style={styles.warning}>{t("settings.host.orchestration.enableTools.warning")}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  detailsToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  detailsToggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  details: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface2,
  },
  capability: {
    gap: theme.spacing[1],
  },
  capabilityRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  capabilityContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  capabilityTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  capabilityBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
  warning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
  },
}));
