import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  Download,
  Globe,
  Monitor,
  Pencil,
  Plus,
  RotateCw,
  SquareTerminal,
  Trash2,
} from "lucide-react-native";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import type { OmpInstallationStatus, TerminalProfile } from "@omp-desktop/protocol/messages";
import { resolveOmpProxyUrl } from "@omp-desktop/protocol/provider-config";
import {
  getTerminalProfileIcon,
  DEFAULT_TERMINAL_PROFILES,
} from "@omp-desktop/protocol/terminal-profiles";
import { AgentProfilesSection } from "@/agent-profiles";
import { OmpSubagentsSection } from "@/omp-subagents";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { RemoteSshHostModal } from "@/components/remote-ssh-host-modal";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Alert as InlineAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import {
  ProfileDraft,
  TerminalProfileEditModal,
} from "@/screens/settings/terminal-profile-edit-modal";
import { getIsElectron } from "@/constants/platform";
import {
  getDesktopDaemonStatus,
  restartDesktopDaemon,
  startDesktopDaemon,
  stopDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { LocalDaemonSection } from "@/desktop/components/desktop-updates-section";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { loadDesktopSettings, useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { getDesktopHost, type DesktopRemoteSshProfile } from "@/desktop/host";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useOmpProviderAccountQuota } from "@/hooks/use-omp-account-quota";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostMutations,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import {
  buildOmpAccountProviderUsage,
  createOmpAccountUsageCopy,
  mergeOmpAccountProviderUsage,
} from "@/provider-usage/omp-account";
import { ProviderUsageSettingsSection } from "@/provider-usage/settings-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { HostAppearanceSection } from "@/screens/settings/host-appearance-section";
import { SettingsSection } from "@/screens/settings/settings-section";
import { PairDeviceSection } from "@/screens/settings/pair-device-section";
import { ImageGenerationSettingsSection } from "@/screens/settings/image-generation-card";
import { OmpProviderConfigurationPanel } from "@/components/provider-diagnostic-sheet";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { formatConnectionStatus, getConnectionStatusTone } from "@/utils/daemons";
import { formatLatency } from "@/utils/latency";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { getProviderIcon } from "@/components/provider-icons";
import { PaseoToolsCard } from "./paseo-tools-card";
import { hasDaemonReconnectedAfter, type DaemonConnectionMarker } from "./daemon-reconnect";
import { restartDaemonFromSettings } from "./daemon-restart";
import { OmpAgentShellCard } from "./omp-agent-shell-card";
import { OmpBuiltinToolsCard } from "./omp-builtin-tools-card";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedProfilePencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedProfileSquareTerminal = withUnistyles(SquareTerminal);
const ThemedPlus = withUnistyles(Plus);

interface DynamicProviderIconProps {
  iconKey: string;
  size: number;
  color?: string;
}

function DynamicProviderIcon({ iconKey, size, color = "" }: DynamicProviderIconProps) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedDynamicProviderIcon = withUnistyles(DynamicProviderIcon);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editProfileIcon = <ThemedProfilePencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeProfileIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;
const addProfileIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

function formatHostConnectionLabel(connection: HostConnection, t: TFunction): string {
  if (connection.type === "relay") {
    return `${t("settings.host.badges.relay")} (${connection.relayEndpoint})`;
  }
  if (connection.type === "directSocket" || connection.type === "directPipe") {
    return `${t("settings.host.badges.local")} (${connection.path})`;
  }
  return `TCP (${connection.endpoint})`;
}

function formatActiveConnectionBadge(
  activeConnection: { type: HostConnection["type"]; display: string } | null,
  theme: ReturnType<typeof useUnistyles>["theme"],
  t: TFunction,
): { icon: React.ReactNode; text: string } | null {
  if (!activeConnection) return null;
  if (activeConnection.type === "relay") {
    return {
      icon: <Globe size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: t("settings.host.badges.relay"),
    };
  }
  if (activeConnection.type === "directSocket" || activeConnection.type === "directPipe") {
    return {
      icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
      text: t("settings.host.badges.local"),
    };
  }
  return {
    icon: <Monitor size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    text: activeConnection.display,
  };
}

function formatDaemonVersionBadge(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function useHostProfile(serverId: string): HostProfile | null {
  const daemons = useHosts();
  return daemons.find((entry) => entry.serverId === serverId) ?? null;
}

function HostNotFound() {
  const { t } = useTranslation();
  return (
    <View>
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.host.notFound")}</Text>
      </View>
    </View>
  );
}

function HostStatusBadges({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const snapshot = useHostRuntimeSnapshot(serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.version ?? null,
  );

  const connectionStatus = snapshot?.connectionStatus ?? "connecting";
  const activeConnection = snapshot?.activeConnection ?? null;
  const statusLabel = formatConnectionStatus(connectionStatus);
  const statusTone = getConnectionStatusTone(connectionStatus);
  let statusVariant: StatusBadgeVariant = "muted";
  let statusDotColor = theme.colors.foregroundMuted;
  if (statusTone === "success") {
    statusVariant = "success";
    statusDotColor = theme.colors.statusDotSuccess;
  } else if (statusTone === "warning") {
    statusVariant = "warning";
    statusDotColor = theme.colors.statusDotWarning;
  } else if (statusTone === "error") {
    statusVariant = "error";
    statusDotColor = theme.colors.statusDotDanger;
  }
  const connectionBadge = formatActiveConnectionBadge(activeConnection, theme, t);
  const versionBadgeText = formatDaemonVersionBadge(daemonVersion);

  const statusDotStyle = useMemo(
    () => [styles.statusDot, { backgroundColor: statusDotColor }],
    [statusDotColor],
  );
  const statusLeading = useMemo(() => <View style={statusDotStyle} />, [statusDotStyle]);

  return (
    <View style={styles.identityBadges} testID="host-page-identity">
      <StatusBadge label={statusLabel} variant={statusVariant} leading={statusLeading} />
      {connectionBadge ? (
        <View style={styles.badgePill}>
          {connectionBadge.icon}
          <Text style={styles.badgeText} numberOfLines={1}>
            {connectionBadge.text}
          </Text>
        </View>
      ) : null}
      {versionBadgeText ? (
        <View style={styles.badgePill}>
          <Text style={styles.badgeText} numberOfLines={1}>
            {versionBadgeText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function HostConnectionError({ serverId }: { serverId: string }) {
  const snapshot = useHostRuntimeSnapshot(serverId);
  const lastError = snapshot?.lastError ?? null;
  const connectionError =
    typeof lastError === "string" && lastError.trim().length > 0 ? lastError.trim() : null;
  if (!connectionError) return null;
  return <Text style={styles.errorText}>{connectionError}</Text>;
}

type OmpInstallationAction = "install" | "check" | "update";
type OmpInstallStrategy = "immediate" | "stop-agents" | "defer";

function resolveOmpInstallationStatusText(
  t: TFunction,
  status: OmpInstallationStatus | null,
  loading: boolean,
  checking: boolean,
): string {
  if (loading) return t("settings.providers.omp.install.detecting");
  if (checking) return t("settings.providers.omp.install.checking");
  if (!status) return t("settings.providers.omp.install.notInstalled");

  switch (status.updatePhase) {
    case "downloading":
      return t("settings.providers.omp.install.downloading", {
        progress: status.updateProgress ?? 0,
      });
    case "waiting-for-agents":
      return t("settings.providers.omp.install.waitingForAgents");
    case "pending-restart":
      return t("settings.providers.omp.install.pendingRestart");
    case "verifying":
      return t("settings.providers.omp.install.verifying");
    case "installing":
      return t("settings.providers.omp.install.applying");
    case "complete":
      return t("settings.providers.omp.install.updateComplete");
    case "canceled":
      return t("settings.providers.omp.install.updateCanceled");
  }

  if (!status.installed) return t("settings.providers.omp.install.notInstalled");
  let statusText = status.version ?? t("settings.providers.omp.install.installed");
  if (status.updateAvailable === true) {
    statusText += status.latestVersion
      ? ` · ${t("settings.providers.omp.install.versionAvailable", {
          version: status.latestVersion,
        })}`
      : ` · ${t("settings.providers.omp.install.updateAvailable")}`;
  } else if (status.updateAvailable === false) {
    statusText += ` · ${t("settings.providers.omp.install.upToDate")}`;
  }
  return statusText;
}

function resolveOmpRuntimeSourceText(t: TFunction, status: OmpInstallationStatus): string {
  switch (status.source) {
    case "bundled":
      return t("settings.providers.omp.install.sourceBundled");
    case "managed":
      return t("settings.providers.omp.install.sourceManaged");
    case "configured":
      return t("settings.providers.omp.install.sourceConfigured");
    case "path":
      return t("settings.providers.omp.install.sourcePath");
    default:
      return t("settings.providers.omp.install.sourceUnknown");
  }
}

function resolveOmpInstallationAction(
  t: TFunction,
  status: OmpInstallationStatus | null,
  checking: boolean,
  installing: boolean,
) {
  let action: OmpInstallationAction = "install";
  if (status?.installed) {
    action = status.updateAvailable === true ? "update" : "check";
  }
  let actionLabel = t("settings.providers.omp.install.install");
  if (action === "check") actionLabel = t("settings.providers.omp.install.check");
  if (action === "update") actionLabel = t("settings.providers.omp.install.update");
  if (checking) actionLabel = t("settings.providers.omp.install.checking");
  if (installing) actionLabel = t("settings.providers.omp.install.installing");
  return { action, actionLabel };
}

function resolveOmpInstallationPresentation(
  t: TFunction,
  status: OmpInstallationStatus | null,
  loading: boolean,
  checking: boolean,
  installing: boolean,
) {
  const statusText = resolveOmpInstallationStatusText(t, status, loading, checking);
  const { action, actionLabel } = resolveOmpInstallationAction(t, status, checking, installing);
  return {
    action,
    statusText,
    sourceText: status ? resolveOmpRuntimeSourceText(t, status) : null,
    detailText: status
      ? `${status.platform}/${status.arch} · ${status.installPath}`
      : t("settings.providers.omp.install.detectingPath"),
    actionLabel,
  };
}

function resolveOmpUpdateActionState(status: OmpInstallationStatus | null, installing: boolean) {
  return {
    showBusyUpdateActions:
      !installing &&
      status?.platform === "win32" &&
      status.updateAvailable === true &&
      (status.activeAgentCount ?? 0) > 0,
    showCancelDownload: installing && status?.updatePhase === "downloading",
    updateIsPending: status?.pendingUpdate === true && !installing,
  };
}

function OmpInstallationActions({
  status,
  loading,
  checking,
  installing,
  canceling,
  install,
  cancelDownload,
  onPrimaryAction,
}: {
  status: OmpInstallationStatus | null;
  loading: boolean;
  checking: boolean;
  installing: boolean;
  canceling: boolean;
  install: (strategy?: OmpInstallStrategy) => Promise<void>;
  cancelDownload: () => Promise<void>;
  onPrimaryAction: () => void;
}) {
  const { t } = useTranslation();
  const { action, actionLabel } = resolveOmpInstallationAction(t, status, checking, installing);
  let actionIcon: typeof Download | undefined = action === "check" ? RotateCw : Download;
  if (installing || checking) actionIcon = undefined;
  const { showBusyUpdateActions, showCancelDownload, updateIsPending } =
    resolveOmpUpdateActionState(status, installing);
  const handleStopAgents = useCallback(() => void install("stop-agents"), [install]);
  const handleDefer = useCallback(() => void install("defer"), [install]);
  const handleCancelDownload = useCallback(() => void cancelDownload(), [cancelDownload]);

  if (showBusyUpdateActions) {
    return (
      <>
        <Button
          variant="secondary"
          onPress={handleStopAgents}
          testID="host-page-omp-stop-agents-update-button"
        >
          {t("settings.providers.omp.install.stopAgentsAndUpdate")}
        </Button>
        <Button variant="outline" onPress={handleDefer} testID="host-page-omp-defer-update-button">
          {t("settings.providers.omp.install.updateAfterRestart")}
        </Button>
      </>
    );
  }
  if (showCancelDownload) {
    return (
      <Button
        variant="outline"
        loading={canceling}
        onPress={handleCancelDownload}
        testID="host-page-omp-cancel-download-button"
      >
        {t("settings.providers.omp.install.cancelDownload")}
      </Button>
    );
  }
  if (updateIsPending) return null;
  return (
    <Button
      variant={status?.installed ? "secondary" : "default"}
      leftIcon={actionIcon}
      onPress={onPrimaryAction}
      disabled={loading || checking || installing || status?.supported === false}
      testID="host-page-omp-install-button"
    >
      {actionLabel}
    </Button>
  );
}

function OmpInstallationCard({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.ompInstall === true,
  );
  const [status, setStatus] = useState<OmpInstallationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const OmpIcon = getProviderIcon("omp");

  const load = useCallback(async () => {
    if (!client || !supported) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.getOmpInstallationStatus());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, supported]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!client || !installing) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const next = await client.getOmpInstallationStatus();
        if (disposed) return;
        setStatus((current) => ({
          ...current,
          ...next,
          latestVersion: next.latestVersion ?? current?.latestVersion,
          updateAvailable: next.updateAvailable ?? current?.updateAvailable,
        }));
      } catch {
        // The install request owns the actionable error; polling is progress-only.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, installing]);

  const checkForUpdates = useCallback(async () => {
    if (!client) return;
    setChecking(true);
    setError(null);
    try {
      setStatus(await client.getOmpInstallationStatus({ checkForUpdates: true }));
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    } finally {
      setChecking(false);
    }
  }, [client]);

  const install = useCallback(
    async (strategy: OmpInstallStrategy = "immediate") => {
      if (!client || installing) return;
      setInstalling(true);
      setError(null);
      try {
        setStatus(await client.installOmp({ strategy }));
      } catch (installError) {
        setError(installError instanceof Error ? installError.message : String(installError));
      } finally {
        setInstalling(false);
      }
    },
    [client, installing],
  );

  const cancelDownload = useCallback(async () => {
    if (!client || canceling) return;
    setCanceling(true);
    setError(null);
    try {
      setStatus(await client.cancelOmpInstall());
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setCanceling(false);
    }
  }, [canceling, client]);

  const handleActionPress = useCallback(() => {
    if (status?.installed && status.updateAvailable !== true) {
      void checkForUpdates();
      return;
    }
    void install();
  }, [checkForUpdates, install, status?.installed, status?.updateAvailable]);

  if (!supported) return null;
  const { statusText, sourceText, detailText } = resolveOmpInstallationPresentation(
    t,
    status,
    loading,
    checking,
    installing,
  );

  return (
    <View style={settingsStyles.card} testID="host-page-omp-install-card">
      <View style={settingsStyles.row}>
        <OmpIcon size={ICON_SIZE.lg} color={theme.colors.foreground} />
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.providers.omp.install.runtimeTitle")}
          </Text>
          <Text style={settingsStyles.rowHint}>{statusText}</Text>
          {sourceText ? <Text style={settingsStyles.rowHint}>{sourceText}</Text> : null}
          <Text style={styles.ompInstallPath} selectable>
            {detailText}
          </Text>
          {error || status?.message ? (
            <Text style={styles.errorText}>{error ?? status?.message}</Text>
          ) : null}
        </View>
        <View style={styles.ompInstallActions}>
          <OmpInstallationActions
            status={status}
            loading={loading}
            checking={checking}
            installing={installing}
            canceling={canceling}
            install={install}
            cancelDownload={cancelDownload}
            onPrimaryAction={handleActionPress}
          />
        </View>
      </View>
    </View>
  );
}

export function HostAgentsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      {isConnected ? (
        <SettingsSection title={t("settings.hostSections.agents")}>
          <OmpInstallationCard serverId={serverId} />
          <OmpAgentShellCard serverId={serverId} />
          <OmpBuiltinToolsCard serverId={serverId} />
          <PaseoToolsCard serverId={serverId} />
          <AppendSystemPromptCard serverId={serverId} />
        </SettingsSection>
      ) : (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("settings.host.agents.unavailable")}</Text>
        </View>
      )}
      <AgentProfilesSection serverId={serverId} />
      <OmpSubagentsSection serverId={serverId} />
    </View>
  );
}

export function HostProxyPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  if (!isConnected) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.host.agents.unavailable")}</Text>
      </View>
    );
  }

  return (
    <SettingsSection title={t("settings.hostSections.proxy")}>
      <OmpProxyCard serverId={serverId} />
    </SettingsSection>
  );
}
export function HostProvidersPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <SettingsSection title={t("settings.providers.title")}>
      <OmpProviderConfigurationPanel serverId={serverId} />
    </SettingsSection>
  );
}

export function HostImageGenerationPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return <ImageGenerationSettingsSection serverId={serverId} />;
}

export function HostUsagePage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const host = useHostProfile(serverId);
  const { view: baseUsageView, refresh: refreshProviderUsage } = useProviderUsage(serverId);
  const codex = useOmpProviderAccountQuota(serverId, "openai-codex");
  const claude = useOmpProviderAccountQuota(serverId, "anthropic");
  const accountUsage = useMemo(
    () => [
      ...buildOmpAccountProviderUsage(codex, createOmpAccountUsageCopy("openai-codex", t)),
      ...buildOmpAccountProviderUsage(claude, createOmpAccountUsageCopy("anthropic", t)),
    ],
    [claude, codex, t],
  );
  const usageView = useMemo(
    () =>
      mergeOmpAccountProviderUsage(
        baseUsageView,
        accountUsage,
        codex.loading || claude.loading,
        codex.updatedAt ?? claude.updatedAt,
      ),
    [accountUsage, baseUsageView, claude.loading, claude.updatedAt, codex.loading, codex.updatedAt],
  );
  const refreshAccountUsage = codex.refresh;
  const handleRefresh = useCallback(() => {
    void Promise.all([refreshProviderUsage(), refreshAccountUsage()]);
  }, [refreshAccountUsage, refreshProviderUsage]);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <ProviderUsageSettingsSection view={usageView} onRefresh={handleRefresh} />
    </View>
  );
}

export function HostSettingsPage({
  serverId,
  onHostRemoved,
}: {
  serverId: string;
  onHostRemoved?: () => void;
}) {
  const host = useHostProfile(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <View style={styles.daemonHeader}>
        <Text style={styles.daemonHeaderLabel} numberOfLines={1}>
          {host.label}
        </Text>
      </View>

      <HostStatusBadges serverId={serverId} />
      <HostConnectionError serverId={serverId} />
      <ConnectionsSection host={host} />

      <HostAppearanceSection host={host} />
      <PairDeviceSection key={serverId} serverId={serverId} />

      {isLocalDaemon ? <LocalDaemonSection /> : null}

      {!isLocalDaemon ? <UpdateDaemonCard key={host.serverId} host={host} /> : null}

      <RemoveHostSection host={host} isLocalDaemon={isLocalDaemon} onRemoved={onHostRemoved} />
    </View>
  );
}

function ConnectionsSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { removeConnection } = useHostMutations();
  const snapshot = useHostRuntimeSnapshot(host.serverId);
  const probeByConnectionId = snapshot?.probeByConnectionId ?? new Map();
  const [pendingRemoveConnection, setPendingRemoveConnection] = useState<{
    connectionId: string;
    title: string;
  } | null>(null);
  const [isRemovingConnection, setIsRemovingConnection] = useState(false);
  const removeConnectionHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.connections.removeTitle") }),
    [t],
  );

  const handleRequestRemove = useCallback(
    (connection: HostConnection) => {
      setPendingRemoveConnection({
        connectionId: connection.id,
        title: formatHostConnectionLabel(connection, t),
      });
    },
    [t],
  );

  const handleCloseConfirm = useCallback(() => {
    if (isRemovingConnection) return;
    setPendingRemoveConnection(null);
  }, [isRemovingConnection]);

  const handleCancelConfirm = useCallback(() => {
    setPendingRemoveConnection(null);
  }, []);

  const handleConfirmRemove = useCallback(() => {
    if (!pendingRemoveConnection) return;
    const { connectionId } = pendingRemoveConnection;
    setIsRemovingConnection(true);
    void removeConnection(host.serverId, connectionId)
      .then(() => setPendingRemoveConnection(null))
      .catch((error) => {
        console.error("[HostPage] Failed to remove connection", error);
        Alert.alert(
          t("settings.host.connections.removeErrorTitle"),
          t("settings.host.connections.removeErrorMessage"),
        );
      })
      .finally(() => setIsRemovingConnection(false));
  }, [pendingRemoveConnection, removeConnection, host.serverId, t]);

  return (
    <SettingsSection title={t("settings.host.connections.title")}>
      <View style={settingsStyles.card} testID="host-page-connections-card">
        {host.connections.map((conn, index) => {
          const probe = probeByConnectionId.get(conn.id);
          return (
            <ConnectionRow
              key={conn.id}
              connection={conn}
              showBorder={index > 0}
              latencyMs={probe?.status === "available" ? probe.latencyMs : undefined}
              latencyLoading={!probe || probe.status === "pending"}
              latencyError={probe?.status === "unavailable"}
              onRemove={handleRequestRemove}
            />
          );
        })}
      </View>

      {pendingRemoveConnection ? (
        <AdaptiveModalSheet
          header={removeConnectionHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-connection-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {t("settings.host.connections.removeMessage", {
              name: pendingRemoveConnection.title,
            })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleCancelConfirm}
              disabled={isRemovingConnection}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemovingConnection}
              testID="remove-connection-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

function ConnectionRow({
  connection,
  showBorder,
  latencyMs,
  latencyLoading,
  latencyError,
  onRemove,
}: {
  connection: HostConnection;
  showBorder: boolean;
  latencyMs: number | null | undefined;
  latencyLoading: boolean;
  latencyError: boolean;
  onRemove: (connection: HostConnection) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const title = formatHostConnectionLabel(connection, t);

  const latencyText = (() => {
    if (latencyLoading) return "...";
    if (latencyError) return t("settings.host.connections.timeout");
    if (latencyMs != null) return formatLatency(latencyMs);
    return "—";
  })();
  const latencyColor = latencyError ? theme.colors.palette.red[300] : theme.colors.foregroundMuted;

  const handlePressRemove = useCallback(() => {
    onRemove(connection);
  }, [onRemove, connection]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );
  const latencyTextStyle = useMemo(
    () => [styles.connectionLatency, { color: latencyColor }],
    [latencyColor],
  );
  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text style={latencyTextStyle}>{latencyText}</Text>
      <Button
        variant="ghost"
        size="sm"
        textStyle={destructiveTextStyle}
        onPress={handlePressRemove}
      >
        {t("settings.host.connections.removeAction")}
      </Button>
    </View>
  );
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function RestartDaemonCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [isRestarting, setIsRestarting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) return false;
        if (predicate()) return true;
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const waitForDaemonRestart = useCallback(
    async (restartRequest: Promise<void>) => {
      const disconnectTimeoutMs = 30000;
      const reconnectTimeoutMs = 30000;
      const requestFailureDisconnectGraceMs = 2000;
      const disconnectedPromise = isHostConnected()
        ? waitForCondition(() => !isHostConnected(), disconnectTimeoutMs)
        : Promise.resolve(true);
      const restartResult = await restartRequest.then(
        () => ({ status: "accepted" as const }),
        async (error) => ({
          status: "rejected" as const,
          error,
          disconnectedAfterFailure: await waitForCondition(
            () => !isHostConnected(),
            requestFailureDisconnectGraceMs,
            100,
          ),
        }),
      );
      if (!isMountedRef.current) return;

      if (restartResult.status === "rejected" && !restartResult.disconnectedAfterFailure) {
        console.error(`[HostPage] Failed to restart daemon ${host.label}`, restartResult.error);
        setIsRestarting(false);
        Alert.alert(
          t("settings.host.daemon.restart.requestFailedTitle"),
          t("settings.host.daemon.restart.requestFailedMessage"),
        );
        return;
      }

      const disconnected =
        restartResult.status === "rejected"
          ? restartResult.disconnectedAfterFailure
          : await disconnectedPromise;
      const reconnected =
        disconnected && (await waitForCondition(() => isHostConnected(), reconnectTimeoutMs));
      if (isMountedRef.current) {
        setIsRestarting(false);
        if (!reconnected) {
          Alert.alert(
            t("settings.host.daemon.restart.unableToReconnectTitle"),
            t("settings.host.daemon.restart.unableToReconnectMessage", { name: host.label }),
          );
        }
      }
    },
    [host.label, isHostConnected, t, waitForCondition],
  );

  const handleRestart = useCallback(() => {
    if (!daemonClient) {
      Alert.alert(
        t("settings.host.daemon.restart.unavailableTitle"),
        t("settings.host.daemon.restart.unavailableMessage"),
      );
      return;
    }
    if (!isHostConnected()) {
      Alert.alert(
        t("settings.host.daemon.restart.offlineTitle"),
        t("settings.host.daemon.restart.offlineMessage"),
      );
      return;
    }

    void confirmDialog({
      title: t("settings.host.daemon.restart.confirmTitle", { name: host.label }),
      message: t("settings.host.daemon.restart.confirmMessage"),
      confirmLabel: t("settings.host.daemon.restart.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return;
        setIsRestarting(true);
        const restartRequest = restartDaemonFromSettings(
          host.serverId,
          `settings_daemon_restart_${host.serverId}`,
          {
            getIsElectron,
            getDesktopDaemonStatus,
            getDesktopSettings: loadDesktopSettings,
            restartDesktopDaemon,
            restartServer: (reason) => daemonClient.restartServer(reason),
          },
        );
        void waitForDaemonRestart(restartRequest);
        return;
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to open restart confirmation for ${host.label}`, error);
        Alert.alert(
          t("settings.host.daemon.restart.requestFailedTitle"),
          t("settings.host.daemon.restart.dialogFailedMessage"),
        );
      });
  }, [daemonClient, host.label, host.serverId, isHostConnected, t, waitForDaemonRestart]);

  const restartIcon = useMemo(
    () => <RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );

  return (
    <View style={settingsStyles.card} testID="host-page-restart-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.daemon.restart.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.daemon.restart.hint")}</Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={restartIcon}
          onPress={handleRestart}
          disabled={isRestarting || !daemonClient || !isConnected}
          testID="host-page-restart-button"
        >
          {isRestarting
            ? t("settings.host.daemon.restart.restarting")
            : t("settings.host.daemon.restart.confirm")}
        </Button>
      </View>
    </View>
  );
}

type DaemonUpdateState =
  | { status: "idle" }
  | { status: "updating"; phase: string }
  | { status: "failed"; title: string; message: string };

function UpdateDaemonCard({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const runtime = getHostRuntimeStore();
  const [updateState, setUpdateState] = useState<DaemonUpdateState>({ status: "idle" });
  const isMountedRef = useRef(true);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const supportsSelfUpdate = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.features?.daemonSelfUpdate === true,
  );
  const desktopManaged = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.desktopManaged === true,
  );
  const [sshProfile, setSshProfile] = useState<DesktopRemoteSshProfile | null>(null);
  const [sshUpdateVisible, setSshUpdateVisible] = useState(false);

  const appVersion = resolveAppVersion();
  const hasVersionMismatch = isVersionMismatch(appVersion, daemonVersion);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      unsubscribeRef.current?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const getProfile = getDesktopHost()?.remoteSsh?.getProfile;
    if (!getProfile) return () => undefined;
    void getProfile(host.serverId)
      .then((profile) => {
        if (active) setSshProfile(profile);
        return profile;
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to load SSH profile for ${host.label}`, error);
      });
    return () => {
      active = false;
    };
  }, [host.label, host.serverId]);

  const isHostConnected = useCallback(
    () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
    [host.serverId, runtime],
  );
  const hasReconnectedAfter = useCallback(
    (startMarker: DaemonConnectionMarker | null) =>
      hasDaemonReconnectedAfter(runtime.getSnapshot(host.serverId), startMarker),
    [host.serverId, runtime],
  );

  const waitForCondition = useCallback(
    async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isMountedRef.current) return false;
        if (predicate()) return true;
        await delay(intervalMs);
      }
      return predicate();
    },
    [],
  );

  const waitForDaemonRestart = useCallback(
    async (startMarker: DaemonConnectionMarker | null) => {
      const disconnectTimeoutMs = 15000;
      const reconnectTimeoutMs = 120000; // 2 minutes — npm update + restart can take a while
      if (!hasReconnectedAfter(startMarker) && isHostConnected()) {
        await waitForCondition(
          () => !isHostConnected() || hasReconnectedAfter(startMarker),
          disconnectTimeoutMs,
        );
      }
      const reconnected =
        hasReconnectedAfter(startMarker) ||
        (await waitForCondition(() => hasReconnectedAfter(startMarker), reconnectTimeoutMs));
      if (isMountedRef.current) {
        if (!reconnected) {
          setUpdateState({
            status: "failed",
            title: t("settings.host.daemon.update.unableToReconnectTitle"),
            message: t("settings.host.daemon.update.unableToReconnectMessage", {
              name: host.label,
            }),
          });
          return;
        }
        setUpdateState({ status: "idle" });
      }
    },
    [hasReconnectedAfter, host.label, isHostConnected, t, waitForCondition],
  );

  const handleUpdate = useCallback(() => {
    if (!daemonClient) {
      setUpdateState({
        status: "failed",
        title: t("settings.host.daemon.update.unavailableTitle"),
        message: t("settings.host.daemon.update.unavailableMessage"),
      });
      return;
    }
    if (!isHostConnected()) {
      setUpdateState({
        status: "failed",
        title: t("settings.host.daemon.update.offlineTitle"),
        message: t("settings.host.daemon.update.offlineMessage"),
      });
      return;
    }

    void confirmDialog({
      title: t("settings.host.daemon.update.confirmTitle", { name: host.label }),
      message: t("settings.host.daemon.update.confirmMessage"),
      confirmLabel: t("settings.host.daemon.update.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: false,
    })
      .then((confirmed) => {
        if (!confirmed || !isMountedRef.current) return;
        const startSnapshot = runtime.getSnapshot(host.serverId);
        const startMarker = startSnapshot
          ? {
              clientGeneration: startSnapshot.clientGeneration,
              lastOnlineAt: startSnapshot.lastOnlineAt,
            }
          : null;
        setUpdateState({
          status: "updating",
          phase: t("settings.host.daemon.update.phaseStarting"),
        });
        const requestId = `settings_daemon_update_${host.serverId}`;

        const unsubscribe = daemonClient.on("daemon.update.progress", (message) => {
          if (message.payload.requestId !== requestId) return;
          if (!isMountedRef.current) return;
          const { phase } = message.payload;
          if (phase === "starting")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseStarting"),
            });
          else if (phase === "downloading")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseDownloading"),
            });
          else if (phase === "installing")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseInstalling"),
            });
          else if (phase === "complete")
            setUpdateState({
              status: "updating",
              phase: t("settings.host.daemon.update.phaseComplete"),
            });
        });
        unsubscribeRef.current = unsubscribe;

        void daemonClient
          .updateDaemon(requestId)
          .then((response) => {
            unsubscribeRef.current = null;
            unsubscribe();
            if (!response.success) {
              if (!isMountedRef.current) return undefined;
              setUpdateState({
                status: "failed",
                title: t("settings.host.daemon.update.requestFailedTitle"),
                message: t("settings.host.daemon.update.requestFailedMessage", {
                  error: response.error ?? "Unknown error",
                }),
              });
              return undefined;
            }
            // Update succeeded — wait for daemon to restart and reconnect
            void waitForDaemonRestart(startMarker);
            return undefined;
          })
          .catch((error) => {
            unsubscribeRef.current = null;
            unsubscribe();
            console.error(`[HostPage] Failed to update daemon ${host.label}`, error);
            if (!isMountedRef.current) return;
            setUpdateState({
              status: "failed",
              title: t("settings.host.daemon.update.requestFailedTitle"),
              message: t("settings.host.daemon.update.requestFailedMessage", {
                error: error instanceof Error ? error.message : "Unknown error",
              }),
            });
          });
        return;
      })
      .catch((error) => {
        console.error(`[HostPage] Failed to open update confirmation for ${host.label}`, error);
        if (!isMountedRef.current) return;
        setUpdateState({
          status: "failed",
          title: t("settings.host.daemon.update.requestFailedTitle"),
          message: t("settings.host.daemon.update.dialogFailedMessage"),
        });
      });
  }, [daemonClient, host.label, host.serverId, isHostConnected, runtime, t, waitForDaemonRestart]);

  const updateIcon = useMemo(
    () => <ArrowUpToLine size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const handleOpenSshUpdate = useCallback(() => setSshUpdateVisible(true), []);
  const handleCloseSshUpdate = useCallback(() => setSshUpdateVisible(false), []);
  let updateHint = t("settings.host.daemon.update.hint");
  if (desktopManaged) updateHint = t("settings.host.daemon.update.desktopManagedHint");
  if (sshProfile) updateHint = t("settings.host.daemon.update.sshManagedHint");

  const shouldShowUpdate =
    hasVersionMismatch && (supportsSelfUpdate || desktopManaged || sshProfile !== null);
  if (!shouldShowUpdate) {
    return null;
  }

  const isUpdating = updateState.status === "updating";
  const buttonLabel = isUpdating ? updateState.phase : t("settings.host.daemon.update.confirm");

  return (
    <View style={settingsStyles.card} testID="host-page-update-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.daemon.update.title")}</Text>
          <Text style={settingsStyles.rowHint}>{updateHint}</Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={updateIcon}
          onPress={sshProfile ? handleOpenSshUpdate : handleUpdate}
          disabled={
            sshProfile ? isUpdating : desktopManaged || isUpdating || !daemonClient || !isConnected
          }
          testID="host-page-update-button"
        >
          {sshProfile ? t("pairing.ssh.update") : buttonLabel}
        </Button>
      </View>
      {updateState.status === "failed" ? (
        <View style={styles.updateFailure}>
          <InlineAlert
            variant="error"
            title={updateState.title}
            description={updateState.message}
            testID="host-page-update-error"
          />
        </View>
      ) : null}
      {sshProfile && sshUpdateVisible ? (
        <RemoteSshHostModal
          visible
          managedProfile={sshProfile}
          onClose={handleCloseSshUpdate}
          onSaved={handleCloseSshUpdate}
        />
      ) : null}
    </View>
  );
}

function OmpProxyCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const ompConfig = config?.providers.omp;
  const persistedProxy = ompConfig?.env?.PI_PROXY ?? "";
  const isProxyEnabled = resolveOmpProxyUrl(ompConfig) !== undefined;
  const [draft, setDraft] = useState(persistedProxy);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(persistedProxy);
  }, [persistedProxy]);

  const normalizedDraft = draft.trim();
  const hasChanges = normalizedDraft !== persistedProxy;
  const handleSave = useCallback(() => {
    setIsSaving(true);
    void patchConfig({
      providers: {
        omp: {
          env: {
            PI_PROXY: normalizedDraft,
          },
        },
      },
    })
      .catch((error) => {
        console.error("[HostPage] Failed to save OMP proxy", error);
        Alert.alert(
          t("settings.host.orchestration.proxy.saveError"),
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setIsSaving(false));
  }, [normalizedDraft, patchConfig, t]);

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      setIsSaving(true);
      void patchConfig({
        providers: {
          omp: {
            params: {
              proxyEnabled: enabled,
            },
          },
        },
      })
        .catch((error) => {
          console.error("[HostPage] Failed to toggle OMP proxy", error);
          Alert.alert(
            t("settings.host.orchestration.proxy.saveError"),
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => setIsSaving(false));
    },
    [patchConfig, t],
  );

  if (!isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-omp-proxy-card">
      <View style={styles.proxyHeader}>
        <View style={styles.proxyIcon}>
          <Globe size={theme.iconSize.md} color={theme.colors.accent} />
        </View>
        <View style={styles.proxyHeaderContent}>
          <Text style={styles.proxyTitle}>{t("settings.host.orchestration.proxy.title")}</Text>
          <Text style={styles.proxyHint}>{t("settings.host.orchestration.proxy.hint")}</Text>
        </View>
        <Switch
          value={isProxyEnabled}
          onValueChange={handleEnabledChange}
          disabled={!persistedProxy.trim() || hasChanges || isSaving}
          accessibilityLabel={t("settings.host.orchestration.proxy.title")}
          testID="host-page-omp-proxy-switch"
        />
      </View>
      <View style={styles.proxyForm}>
        <Field label="PI_PROXY" testID="host-page-omp-proxy-field">
          <View style={styles.proxyControlRow}>
            <View style={styles.proxyInput}>
              <FormTextInput
                initialValue={persistedProxy}
                resetKey={persistedProxy}
                onChangeText={setDraft}
                onSubmitEditing={handleSave}
                placeholder={t("settings.host.orchestration.proxy.placeholder")}
                accessibilityLabel={t("settings.host.orchestration.proxy.accessibilityLabel")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSaving}
                testID="host-page-omp-proxy-input"
              />
            </View>
            <Button
              variant="default"
              size="md"
              style={styles.proxySaveButton}
              onPress={handleSave}
              disabled={!hasChanges || isSaving}
              loading={isSaving}
              testID="host-page-omp-proxy-save"
            >
              {isSaving
                ? t("settings.host.orchestration.proxy.saving")
                : t("settings.host.orchestration.proxy.save")}
            </Button>
          </View>
        </Field>
      </View>
    </View>
  );
}

function AppendSystemPromptCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persistedPrompt = config?.appendSystemPrompt ?? "";
  const [draft, setDraft] = useState(persistedPrompt);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.orchestration.systemPrompt.sheetTitle") }),
    [t],
  );

  useEffect(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  const hasChanges = draft !== persistedPrompt;

  const handleOpen = useCallback(() => {
    setDraft(persistedPrompt);
    setIsEditing(true);
  }, [persistedPrompt]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setDraft(persistedPrompt);
    setIsEditing(false);
  }, [isSaving, persistedPrompt]);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    void patchConfig({ appendSystemPrompt: draft })
      .then(() => {
        setIsEditing(false);
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to save append system prompt", error);
      })
      .finally(() => setIsSaving(false));
  }, [draft, patchConfig]);

  const handleReset = useCallback(() => {
    setDraft(persistedPrompt);
  }, [persistedPrompt]);

  if (!isConnected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-append-system-prompt-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.systemPrompt.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.systemPrompt.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={handleOpen}
            testID="host-page-append-system-prompt-edit"
          >
            {t("settings.host.orchestration.systemPrompt.edit")}
          </Button>
        </View>
      </View>

      {isEditing ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="host-page-append-system-prompt-sheet"
          desktopMaxWidth={560}
        >
          <SettingsTextAreaCard
            testID="host-page-append-system-prompt-input"
            accessibilityLabel={t("settings.host.orchestration.systemPrompt.accessibilityLabel")}
            value={draft}
            onChangeText={setDraft}
            placeholder={t("settings.host.orchestration.systemPrompt.placeholder")}
          />
          <View style={styles.appendPromptActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleReset}
              disabled={!hasChanges || isSaving}
              testID="host-page-append-system-prompt-reset"
            >
              {t("settings.host.orchestration.systemPrompt.reset")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || isSaving}
              testID="host-page-append-system-prompt-save"
            >
              {isSaving
                ? t("settings.host.orchestration.systemPrompt.saving")
                : t("settings.host.orchestration.systemPrompt.save")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function RemoveHostSection({
  host,
  isLocalDaemon,
  onRemoved,
}: {
  host: HostProfile;
  isLocalDaemon: boolean;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { removeHost } = useHostMutations();
  const { updateSettings } = useDesktopSettings();
  const { data: daemonStatusData, setStatus } = useDaemonStatus();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const daemonStatus = daemonStatusData?.status ?? null;
  const removeHostHeader = useMemo<SheetHeader>(
    () => ({
      title: isLocalDaemon
        ? t("settings.host.daemon.remove.localConfirmTitle")
        : t("settings.host.daemon.remove.title"),
    }),
    [isLocalDaemon, t],
  );

  const destructiveTextStyle = useMemo(
    () => ({ color: theme.colors.destructive }),
    [theme.colors.destructive],
  );

  const handleOpenConfirm = useCallback(() => setIsConfirming(true), []);
  const handleCloseConfirm = useCallback(() => {
    if (isRemoving) return;
    setIsConfirming(false);
  }, [isRemoving]);
  const handleCancel = useCallback(() => setIsConfirming(false), []);
  const rollbackLocalhostRemoval = useCallback(
    async (shouldRestartDaemon: boolean) => {
      await updateSettings({ daemon: { manageBuiltInDaemon: true } });
      if (!shouldRestartDaemon) {
        return;
      }
      setStatus(await startDesktopDaemon());
    },
    [setStatus, updateSettings],
  );
  const handleConfirmRemove = useCallback(() => {
    setIsRemoving(true);
    const remove = async () => {
      let didDisableDaemonManagement = false;
      let didStopDaemon = false;
      if (isLocalDaemon) {
        try {
          await updateSettings({ daemon: { manageBuiltInDaemon: false } });
          didDisableDaemonManagement = true;
          if (daemonStatus?.status === "running" && daemonStatus.desktopManaged) {
            setStatus(await stopDesktopDaemon("host_remove"));
            didStopDaemon = true;
          }
          await removeHost(host.serverId);
        } catch (error) {
          if (didDisableDaemonManagement) {
            try {
              await rollbackLocalhostRemoval(didStopDaemon);
            } catch (rollbackError) {
              console.error("[HostPage] Failed to roll back localhost removal", rollbackError);
            }
          }
          throw error;
        }
        return;
      }
      await removeHost(host.serverId);
      await getDesktopHost()
        ?.remoteSsh?.removeProfile?.(host.serverId)
        .catch((error) => {
          console.error("[HostPage] Failed to remove SSH host profile", error);
        });
    };
    void remove()
      .then(() => {
        setIsConfirming(false);
        onRemoved?.();
        return;
      })
      .catch((error) => {
        console.error("[HostPage] Failed to remove host", error);
        Alert.alert(
          t("settings.host.daemon.remove.errorTitle"),
          isLocalDaemon
            ? t("settings.host.daemon.remove.localErrorMessage")
            : t("settings.host.daemon.remove.errorMessage"),
        );
      })
      .finally(() => setIsRemoving(false));
  }, [
    daemonStatus,
    host.serverId,
    isLocalDaemon,
    onRemoved,
    removeHost,
    rollbackLocalhostRemoval,
    setStatus,
    t,
    updateSettings,
  ]);

  const removeIcon = useMemo(
    () => <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />,
    [theme.iconSize.sm, theme.colors.destructive],
  );

  return (
    <SettingsSection
      title={t("settings.host.daemon.dangerZone")}
      testID="host-page-remove-host-card"
    >
      <RestartDaemonCard host={host} />

      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {isLocalDaemon
                ? t("settings.host.daemon.remove.localTitle")
                : t("settings.host.daemon.remove.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {isLocalDaemon
                ? t("settings.host.daemon.remove.localHint")
                : t("settings.host.daemon.remove.hint")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={removeIcon}
            textStyle={destructiveTextStyle}
            onPress={handleOpenConfirm}
            testID="host-page-remove-host-button"
          >
            {t("settings.host.connections.removeAction")}
          </Button>
        </View>
      </View>

      {isConfirming ? (
        <AdaptiveModalSheet
          header={removeHostHeader}
          visible
          onClose={handleCloseConfirm}
          testID="remove-host-confirm-modal"
        >
          <Text style={styles.confirmText}>
            {isLocalDaemon
              ? t("settings.host.daemon.remove.localConfirmMessage")
              : t("settings.host.daemon.remove.confirmMessage", { name: host.label })}
          </Text>
          <View style={styles.confirmActions}>
            <Button
              variant="secondary"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleCancel}
              disabled={isRemoving}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              style={FLEX_1_STYLE}
              onPress={handleConfirmRemove}
              disabled={isRemoving}
              testID="remove-host-confirm"
            >
              {t("settings.host.connections.removeAction")}
            </Button>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Terminal Profiles
// ---------------------------------------------------------------------------

function generateProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function parseArgsString(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMPTY_PROFILE_DRAFT: ProfileDraft = { name: "", command: "", args: "" };

interface TerminalProfileRowProps {
  profile: TerminalProfile;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}

function TerminalProfileRow({
  profile,
  isFirst,
  isLast,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: TerminalProfileRowProps) {
  const { t } = useTranslation();

  const handleEdit = useCallback(() => onEdit(profile.id), [onEdit, profile.id]);
  const handleRemove = useCallback(() => onRemove(profile.id), [onRemove, profile.id]);
  const handleMoveUp = useCallback(() => onMoveUp(profile.id), [onMoveUp, profile.id]);
  const handleMoveDown = useCallback(() => onMoveDown(profile.id), [onMoveDown, profile.id]);

  const commandText =
    profile.args && profile.args.length > 0
      ? `${profile.command} ${profile.args.join(" ")}`
      : profile.command;

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder, terminalProfileStyles.row],
    [isFirst],
  );

  const icon = getTerminalProfileIcon(profile);

  return (
    <View style={rowStyle} testID={`terminal-profile-row-${profile.id}`}>
      <View style={terminalProfileStyles.iconWrapper}>
        {icon ? (
          <ThemedDynamicProviderIcon
            iconKey={icon}
            size={ICON_SIZE.md}
            uniProps={mutedColorMapping}
          />
        ) : (
          <ThemedProfileSquareTerminal size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        )}
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {profile.name}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {commandText}
        </Text>
      </View>
      <View style={terminalProfileStyles.rowActions}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={t("settings.host.terminalProfiles.moveUp")}
          testID={`terminal-profile-move-up-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={t("settings.host.terminalProfiles.moveDown")}
          testID={`terminal-profile-move-down-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editProfileIcon}
          onPress={handleEdit}
          accessibilityLabel={t("settings.host.terminalProfiles.editProfile")}
          testID={`terminal-profile-edit-${profile.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeProfileIcon}
          onPress={handleRemove}
          accessibilityLabel={t("settings.host.terminalProfiles.remove")}
          testID={`terminal-profile-remove-${profile.id}`}
        />
      </View>
    </View>
  );
}

function TerminalProfilesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editingProfile, setEditingProfile] = useState<{
    id: string;
    draft: ProfileDraft;
  } | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Settings edits what is persisted, not the adopted view. Any save here
  // writes the whole list back, so resolving first would bake read-time prompt
  // adoption into the user's config the first time they reorder a row.
  const profiles = useMemo(
    () => (config ? (config.terminalProfiles ?? DEFAULT_TERMINAL_PROFILES) : null),
    [config],
  );

  const saveProfiles = useCallback(
    async (next: TerminalProfile[]) => {
      await patchConfig({ terminalProfiles: next });
    },
    [patchConfig],
  );

  const handleAddOpen = useCallback(() => setIsAdding(true), []);
  const handleAddClose = useCallback(() => setIsAdding(false), []);

  const handleAddSave = useCallback(
    async (draft: ProfileDraft) => {
      const current = profiles ? [...profiles] : [];
      const next: TerminalProfile[] = [
        ...current,
        {
          id: generateProfileId(),
          name: draft.name,
          command: draft.command,
          args: parseArgsString(draft.args),
        },
      ];
      await saveProfiles(next);
      setIsAdding(false);
    },
    [profiles, saveProfiles],
  );

  const handleEditOpen = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      setEditingProfile({
        id,
        draft: {
          name: profile.name,
          command: profile.command,
          args: profile.args ? profile.args.join(" ") : "",
        },
      });
    },
    [profiles],
  );

  const handleEditClose = useCallback(() => setEditingProfile(null), []);

  const handleEditSave = useCallback(
    async (draft: ProfileDraft) => {
      if (!editingProfile || !profiles) return;
      const next: TerminalProfile[] = profiles.map((p) =>
        p.id === editingProfile.id
          ? {
              ...p,
              name: draft.name,
              command: draft.command,
              args: parseArgsString(draft.args),
            }
          : p,
      );
      await saveProfiles(next);
      setEditingProfile(null);
    },
    [editingProfile, profiles, saveProfiles],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((p) => p.id === id);
      if (!profile) return;
      void confirmDialog({
        title: t("settings.host.terminalProfiles.removeConfirmTitle"),
        message: t("settings.host.terminalProfiles.removeConfirmMessage", {
          name: profile.name,
        }),
        confirmLabel: t("settings.host.terminalProfiles.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed || !profiles) return;
        try {
          await saveProfiles(profiles.filter((p) => p.id !== id));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      });
    },
    [profiles, saveProfiles, t],
  );

  const handleMoveUp = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index <= 0) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index - 1, 0, item);
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, saveProfiles, t],
  );

  const handleMoveDown = useCallback(
    async (id: string) => {
      if (!profiles) return;
      const index = profiles.findIndex((p) => p.id === id);
      if (index < 0 || index >= profiles.length - 1) return;
      const next = [...profiles];
      const [item] = next.splice(index, 1);
      next.splice(index + 1, 0, item);
      try {
        await saveProfiles(next);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [profiles, saveProfiles, t],
  );

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addProfileIcon}
        onPress={handleAddOpen}
        disabled={!isConnected || !profiles}
        testID="terminal-profiles-add-button"
      />
    ),
    [handleAddOpen, isConnected, profiles],
  );

  if (!isConnected) {
    return (
      <View style={settingsStyles.card} testID="terminal-profiles-unavailable">
        <View style={terminalProfileStyles.emptyCard}>
          <Text style={terminalProfileStyles.emptyText}>
            {t("settings.host.terminalProfiles.unavailable")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("settings.host.terminalProfiles.sectionTitle")}
        trailing={addButton}
        testID="terminal-profiles-section"
      >
        <View style={settingsStyles.card} testID="terminal-profiles-card">
          {profiles && profiles.length > 0 ? (
            profiles.map((profile, index) => (
              <TerminalProfileRow
                key={profile.id}
                profile={profile}
                isFirst={index === 0}
                isLast={index === profiles.length - 1}
                onEdit={handleEditOpen}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
              />
            ))
          ) : (
            <View style={terminalProfileStyles.emptyCard}>
              <Text style={terminalProfileStyles.emptyText}>
                {t("settings.host.terminalProfiles.emptyState")}
              </Text>
            </View>
          )}
        </View>
      </SettingsSection>

      <TerminalProfileEditModal
        visible={isAdding}
        title={t("settings.host.terminalProfiles.addProfileTitle")}
        initialDraft={EMPTY_PROFILE_DRAFT}
        onClose={handleAddClose}
        onSave={handleAddSave}
        testID="terminal-profile-edit-modal"
      />

      {editingProfile ? (
        <TerminalProfileEditModal
          visible
          title={t("settings.host.terminalProfiles.editProfileTitle")}
          initialDraft={editingProfile.draft}
          onClose={handleEditClose}
          onSave={handleEditSave}
        />
      ) : null}
    </>
  );
}

export function HostTerminalsPage({ serverId }: { serverId: string }) {
  const host = useHostProfile(serverId);

  if (!host) {
    return <HostNotFound />;
  }

  return (
    <View>
      <TerminalProfilesSection serverId={serverId} />
    </View>
  );
}

const terminalProfileStyles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    minHeight: 56,
  },
  iconWrapper: {
    width: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

const styles = StyleSheet.create((theme) => ({
  updateFailure: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[4],
  },
  daemonHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginBottom: theme.spacing[4],
  },
  daemonHeaderLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  identityBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    marginBottom: theme.spacing[6],
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  badgePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    maxWidth: 200,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  ompInstallActions: {
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  ompInstallPath: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  connectionLatency: {
    fontSize: theme.fontSize.base,
    marginRight: theme.spacing[2],
  },
  confirmText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  confirmActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  proxyHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  proxyIcon: {
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
  },
  proxyHeaderContent: {
    flex: 1,
    paddingTop: 1,
  },
  proxyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  proxyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.5),
    marginTop: theme.spacing[1],
  },
  proxyForm: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  proxyControlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  proxyInput: {
    flex: 1,
    minWidth: 0,
  },
  proxySaveButton: {
    minWidth: 88,
  },
  appendPromptActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const FLEX_1_STYLE = { flex: 1 };
