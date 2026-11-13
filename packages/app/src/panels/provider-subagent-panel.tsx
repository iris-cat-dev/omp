import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useShallow } from "zustand/react/shallow";
import { AgentStreamView } from "@/agent-stream/view";
import { getProviderIcon } from "@/components/provider-icons";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import {
  providerSubagentKey,
  providerSubagentParentKey,
  providerSubagentLifecycleStatus,
  refreshProviderSubagents,
  refreshProviderSubagentTimeline,
  useProviderSubagentStore,
} from "@/subagents/provider-store";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import { ProviderSubagentMetadata } from "./provider-subagent-metadata";

const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];

function formatProviderLabel(provider: string): string {
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useProviderSubagentDescriptor(
  target: { kind: "provider_subagent"; parentAgentId: string; subagentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const listStatus = useProviderSubagentStore((state) =>
    state.listSync.get(providerSubagentParentKey(context.serverId, target.parentAgentId)),
  );
  const descriptor = useProviderSubagentStore((state) =>
    state.descriptors.get(
      providerSubagentKey(context.serverId, target.parentAgentId, target.subagentId),
    ),
  );
  const parentProvider = useSessionStore(
    (state) => state.sessions[context.serverId]?.agents.get(target.parentAgentId)?.provider,
  );
  const provider = descriptor?.provider ?? parentProvider ?? "agent";
  // The task names the tab; the subagent type is supporting detail beside the provider.
  const subagentType = descriptor?.title?.trim();
  const label =
    descriptor?.description?.trim() ||
    subagentType ||
    (listStatus === "ready" ? t("agentPanel.states.notFound") : "Subagent");
  const providerLabel = `${formatProviderLabel(provider)} subagent`;
  return {
    label,
    subtitle:
      subagentType && subagentType !== label ? `${subagentType} · ${providerLabel}` : providerLabel,
    tooltip: label,
    titleState: descriptor || (listStatus && listStatus !== "loading") ? "ready" : "loading",
    icon: getProviderIcon(provider),
    statusBucket: descriptor
      ? deriveSidebarStateBucket({
          status: providerSubagentLifecycleStatus(descriptor.status),
          requiresAttention: descriptor.status === "failed",
        })
      : null,
  };
}

function ProviderSubagentPanel() {
  const { t } = useTranslation();
  const { serverId, target, openFileInWorkspace } = usePaneContext();
  invariant(target.kind === "provider_subagent", "ProviderSubagentPanel requires provider target");
  const isActive = useRetainedPanelActive();
  const key = providerSubagentKey(serverId, target.parentAgentId, target.subagentId);
  const streamId = `provider:${encodeURIComponent(target.parentAgentId)}:${encodeURIComponent(target.subagentId)}`;
  const { descriptor, timeline, listStatus, timelineStatus } = useProviderSubagentStore(
    useShallow((state) => ({
      descriptor: state.descriptors.get(key) ?? null,
      timeline: state.timelines.get(key) ?? null,
      listStatus: state.listSync.get(providerSubagentParentKey(serverId, target.parentAgentId)),
      timelineStatus: state.timelineSync.get(key),
    })),
  );
  const parent = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(target.parentAgentId) ??
      state.sessions[serverId]?.agentDetails.get(target.parentAgentId) ??
      null,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // COMPAT(providerSubagents): added in v0.2.11, remove after 2027-01-12.
  const supported = serverInfo?.features?.providerSubagents === true;
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  useEffect(() => {
    if (!client || !supported || !isActive) return;
    const controller = new AbortController();
    let disposed = false;
    let release: (() => void) | undefined;
    void client
      .acquireProviderSubagentSubscription(target.parentAgentId, target.subagentId, {
        signal: controller.signal,
      })
      .then((lease) => {
        if (disposed) {
          lease();
          return;
        }
        release = lease;
        return Promise.all([
          refreshProviderSubagents(client, serverId, target.parentAgentId),
          refreshProviderSubagentTimeline(
            client,
            serverId,
            target.parentAgentId,
            target.subagentId,
          ),
        ]);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      controller.abort();
      release?.();
    };
  }, [client, isActive, serverId, supported, target.parentAgentId, target.subagentId]);

  const loadOlder = useCallback((): boolean => {
    if (!client || !supported || isLoadingOlder || !timeline?.hasOlder || !timeline.epoch) {
      return false;
    }
    const firstSeq = timeline.rows.size ? Math.min(...timeline.rows.keys()) : null;
    if (firstSeq === null) return false;
    setIsLoadingOlder(true);
    void refreshProviderSubagentTimeline(
      client,
      serverId,
      target.parentAgentId,
      target.subagentId,
      {
        direction: "before",
        cursor: { epoch: timeline.epoch, seq: firstSeq },
        limit: TIMELINE_FETCH_PAGE_SIZE,
      },
    )
      .catch(() => undefined)
      .finally(() => setIsLoadingOlder(false));
    return true;
  }, [
    client,
    isLoadingOlder,
    serverId,
    supported,
    target.parentAgentId,
    target.subagentId,
    timeline,
  ]);
  const firstTimelineSeq = timeline?.rows.size ? Math.min(...timeline.rows.keys()) : null;
  const progressKey =
    timeline?.epoch && firstTimelineSeq !== null ? `${timeline.epoch}:${firstTimelineSeq}` : null;

  const streamContext = useMemo<AgentScreenAgent>(
    () => ({
      serverId,
      id: streamId,
      provider: descriptor?.provider ?? parent?.provider,
      status: descriptor ? providerSubagentLifecycleStatus(descriptor.status) : "initializing",
      cwd: descriptor?.cwd ?? parent?.cwd ?? "",
      workspaceId: parent?.workspaceId,
      projectPlacement: parent?.projectPlacement,
    }),
    [descriptor, parent, serverId, streamId],
  );
  const historyPagination = useMemo(
    () => ({
      hasOlder: timeline?.hasOlder === true,
      isLoadingOlder,
      progressKey,
      onLoadOlder: loadOlder,
    }),
    [isLoadingOlder, loadOlder, progressKey, timeline?.hasOlder],
  );
  const turnPresentation = useMemo<TurnPresentation>(
    () => ({
      isActive: descriptor?.status === "running",
      isCancelling: false,
      startedAt: null,
      turnId: null,
    }),
    [descriptor?.status],
  );

  const retrySync = useCallback(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, serverId, target.parentAgentId).catch(() => undefined);
    void refreshProviderSubagentTimeline(
      client,
      serverId,
      target.parentAgentId,
      target.subagentId,
    ).catch(() => undefined);
  }, [client, serverId, supported, target.parentAgentId, target.subagentId]);

  if (serverInfo && !supported) {
    return (
      <View style={styles.unsupported} testID="provider-subagent-panel-unsupported">
        <Text style={styles.unsupportedText}>{t("message.actions.forkUnavailable")}</Text>
      </View>
    );
  }

  if (
    !descriptor &&
    (listStatus === "ready" ||
      timelineStatus === "missing" ||
      listStatus === "error" ||
      timelineStatus === "error")
  ) {
    const failed = listStatus === "error" || timelineStatus === "error";
    return (
      <View style={styles.unsupported} testID="provider-subagent-panel-unavailable">
        <Text style={styles.unsupportedText}>
          {t(failed ? "agentPanel.states.failedToLoad" : "agentPanel.states.notFound")}
        </Text>
        <Pressable accessibilityRole="button" onPress={retrySync}>
          <Text style={styles.unsupportedText}>{t("common.actions.retry")}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="provider-subagent-panel">
      <ProviderSubagentMetadata model={descriptor?.model} subtitle={descriptor?.subtitle} />
      {timelineStatus === "error" ? (
        <Pressable accessibilityRole="button" onPress={retrySync} style={styles.syncError}>
          <Text style={styles.unsupportedText}>
            {t("agentPanel.states.timelineSyncFailed")} {t("common.actions.retry")}
          </Text>
        </Pressable>
      ) : null}
      <AgentStreamView
        agentId={streamId}
        serverId={serverId}
        context={streamContext}
        streamItems={timeline?.tail ?? EMPTY_STREAM_ITEMS}
        streamHead={timeline?.head ?? EMPTY_STREAM_ITEMS}
        turnPresentation={turnPresentation}
        pendingPermissions={EMPTY_PERMISSIONS}
        isAuthoritativeHistoryReady={timeline !== null || timelineStatus === "ready"}
        onOpenWorkspaceFile={openFileInWorkspace}
        readOnly
        historyPagination={historyPagination}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  unsupported: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
  syncError: { padding: 12 },
}));

export const providerSubagentPanelRegistration: PanelRegistration<"provider_subagent"> = {
  kind: "provider_subagent",
  resourceKey: (target) => `${target.parentAgentId}:${target.subagentId}`,
  component: ProviderSubagentPanel,
  useDescriptor: useProviderSubagentDescriptor,
};
