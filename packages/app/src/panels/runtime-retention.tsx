import type { AgentRuntimeRetention } from "@omp-desktop/protocol/runtime-resources";
import { RUNTIME_KEEP_LABEL } from "@omp-desktop/protocol/runtime-resources";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { RuntimeResourceList } from "./runtime-resource-list";

interface RuntimeRetentionProps {
  serverId: string;
  agentId: string;
}

export function RuntimeRetention({ serverId, agentId }: RuntimeRetentionProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const active = useRetainedPanelActive();
  const retention = useSessionStore(state => state.sessions[serverId]?.agents.get(agentId)?.runtimeRetention
    ?? state.sessions[serverId]?.agentDetails.get(agentId)?.runtimeRetention);
  const keep = useSessionStore(state => (state.sessions[serverId]?.agents.get(agentId)?.labels
    ?? state.sessions[serverId]?.agentDetails.get(agentId)?.labels)?.[RUNTIME_KEEP_LABEL] === "true");
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<AgentRuntimeRetention | undefined>();
  const current = override ?? retention;

  useEffect(() => setOverride(undefined), [retention, agentId, serverId]);

  async function runAction(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }


  if (!current) return null;
  const title = current.state === "unloaded"
    ? t(current.recoverable ? "runtimeRetention.unloaded" : "runtimeRetention.historyOnly")
    : current.state === "unloading"
      ? t("runtimeRetention.unloading")
      : t(current.canUnload ? "runtimeRetention.recoverable" : "runtimeRetention.retained");

  return (
    <View style={styles.container} testID="agent-runtime-retention">
      <Button size="sm" variant="ghost" onPress={() => setExpanded(!expanded)}>
        {title}
      </Button>
      {expanded ? (
        <View style={styles.details}>
          <Text style={styles.text}>{t(current.state === "unloaded"
            ? "runtimeRetention.historyHint"
            : "runtimeRetention.idleHint")}</Text>
          {current.reasons.map((reason, index) => (
            <Text key={`${reason.code}:${reason.resourceId ?? index}`} style={styles.text}>
              {t(`runtimeRetention.reasons.${reason.code}`)}{reason.detail ? ` · ${reason.detail}` : ""}
            </Text>
          ))}
          <RuntimeResourceList serverId={serverId} agentId={agentId} active={expanded && active && current.state === "resident"} />
          {current.state === "resident" ? (
            <View style={styles.actions}>
              <Button size="sm" variant="secondary" disabled={pending || !client}
                onPress={() => void runAction(async () => {
                  await client!.updateAgent(agentId, { labels: { [RUNTIME_KEEP_LABEL]: keep ? "false" : "true" } });
                })}>
                {t(keep ? "runtimeRetention.stopKeeping" : "runtimeRetention.keep")}
              </Button>
              <Button size="sm" variant="secondary" disabled={pending || !client || !current.canUnload}
                testID="agent-runtime-unload"
                onPress={() => void runAction(async () => {
                  const result = await client!.unloadAgentRuntime(agentId);
                  setOverride(result.runtimeRetention);
                })}>
                {t("runtimeRetention.unload")}
              </Button>
            </View>
          ) : null}
          {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[1] },
  details: { gap: theme.spacing[2], padding: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));
