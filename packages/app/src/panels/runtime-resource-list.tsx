import type { RuntimeResource } from "@omp-desktop/protocol/runtime-resources";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useRuntimeResourceSheetStore, type RuntimeResourceSheetRequest } from "@/stores/runtime-resource-sheet-store";


export function RuntimeResourceList({ serverId, agentId, active }: RuntimeResourceSheetRequest & { active: boolean }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [resources, setResources] = useState<RuntimeResource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setResources([]);
    setLoaded(false);
    setError(null);
    if (!active || !client) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await client.getAgentRuntimeResources(agentId);
        if (!cancelled) { setResources(result.resources); setError(null); setLoaded(true); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, client, serverId, agentId, revision]);

  async function release(resource: RuntimeResource) {
    if (!client || pending || !resource.releasable) return;
    const confirmed = await confirmDialog({
      title: t("runtimeRetention.releaseTitle"),
      message: t("runtimeRetention.releaseWarning"),
      confirmLabel: t("runtimeRetention.release"),
      destructive: true,
    });
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.releaseAgentRuntimeResource(agentId, resource.id);
      if (!result.released) throw new Error(t("runtimeResources.releaseFailed"));
      setRevision(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  }

  if (!active) return null;
  return <View style={styles.list} testID="agent-runtime-resources">
    <Text style={styles.text}>{t("runtimeRetention.releaseWarning")}</Text>
    {loaded && resources.length === 0 ? <Text style={styles.text}>{t("runtimeResources.empty")}</Text> : null}
    {resources.map(resource => <View key={resource.id} style={styles.resource}>
      <Text style={styles.title}>{t(`runtimeResources.kinds.${resource.kind}`)} · {resource.state}</Text>
      <Text style={styles.text} selectable>{resource.id}{resource.pid ? ` · PID ${resource.pid}` : ""}</Text>
      <Text style={styles.text} selectable>{t("runtimeResources.owner", { session: resource.ownerSessionId, agent: resource.ownerAgentId ?? agentId })}</Text>
      <Text style={styles.text}>{resource.liveHandles} {t("runtimeRetention.handles")}</Text>
      {resource.retentionReasons.map(reason => <Text key={reason} style={styles.text}>
        {t(`runtimeResources.reasons.${reason}`, { defaultValue: reason })}
      </Text>)}
      <Button size="sm" variant="secondary" disabled={pending || !resource.releasable || !client}
        testID={`runtime-resource-release-${resource.id}`} onPress={() => void release(resource)}>
        {t("runtimeRetention.release")}
      </Button>
    </View>)}
    {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    <Button size="sm" variant="ghost" disabled={pending || !client} onPress={() => setRevision(value => value + 1)}>
      {t("runtimeResources.refresh")}
    </Button>
  </View>;
}

export function RuntimeResourceSheet({ serverId, active }: { serverId: string; active: boolean }) {
  const { t } = useTranslation();
  const request = useRuntimeResourceSheetStore(state => state.request);
  const visible = active && request?.serverId === serverId;
  return <AdaptiveModalSheet visible={visible} header={{ title: t("runtimeResources.title") }}
    onClose={() => useRuntimeResourceSheetStore.setState({ request: null })}>
    {visible && request ? <RuntimeResourceList {...request} active /> : null}
  </AdaptiveModalSheet>;
}

const styles = StyleSheet.create(theme => ({
  list: { gap: theme.spacing[3], padding: theme.spacing[3] },
  resource: { gap: theme.spacing[1], padding: theme.spacing[2], borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.borderRadius.md },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
