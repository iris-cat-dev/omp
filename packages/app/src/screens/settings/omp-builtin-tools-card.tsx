import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getOmpBuiltinToolNames } from "@omp-desktop/protocol/omp-builtin-tools";
import type { OmpInstallationStatus } from "@omp-desktop/protocol/messages";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;

const linkedTools = ["checkpoint", "rewind"] as const;
const emptyTools: readonly string[] = [];

export function OmpBuiltinToolsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.ompBuiltinToolSettings === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { status, loading, statusError, refresh } = useOmpInstallationStatus(
    serverId,
    isConnected,
    supported,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // React state updates are asynchronous: the ref also prevents two clicks in one render from
  // submitting overlapping full-list patches derived from the same config.
  const saveInFlight = useRef(false);

  const catalog = status?.installed ? getOmpBuiltinToolNames(status.version) : null;
  const rawDisabledTools = config?.providers.omp?.params?.disabledBuiltInTools;
  const disabledTools = useMemo(
    () =>
      Array.isArray(rawDisabledTools)
        ? rawDisabledTools.filter((name): name is string => typeof name === "string")
        : emptyTools,
    [rawDisabledTools],
  );
  const disabledSet = useMemo(() => new Set(disabledTools), [disabledTools]);
  const canEdit =
    isConnected && supported && catalog !== null && config !== null && !loading && !saving;

  const save = useCallback(
    async (next: string[]) => {
      if (!canEdit || saveInFlight.current) return;
      saveInFlight.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const result = await patchConfig({
          providers: { omp: { params: { disabledBuiltInTools: next } } },
        });
        if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
        // patchConfig updates the daemon config query with the returned config; switches are
        // rendered from that acknowledged value rather than assuming the patch was accepted.
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        saveInFlight.current = false;
        setSaving(false);
      }
    },
    [canEdit, patchConfig, t],
  );

  const changeTool = useCallback(
    (tool: string, enabled: boolean) => {
      if (!catalog || !canEdit || saveInFlight.current) return;
      const next = new Set(disabledTools);
      const names = tool === "checkpoint" ? linkedTools : [tool];
      for (const name of names) {
        if (enabled) next.delete(name);
        else next.add(name);
      }
      void save([...next]);
    },
    [catalog, canEdit, disabledTools, save],
  );

  if (!isConnected) return null;
  return (
    <OmpBuiltinToolsView
      supported={supported}
      catalog={catalog}
      status={status}
      loading={loading}
      statusError={statusError}
      saveError={saveError}
      saving={saving}
      configLoaded={config !== null}
      disabledTools={disabledTools}
      disabledSet={disabledSet}
      canEdit={canEdit}
      refresh={refresh}
      changeTool={changeTool}
      save={save}
    />
  );
}

function OmpBuiltinToolsView({
  supported,
  catalog,
  status,
  loading,
  statusError,
  saveError,
  saving,
  configLoaded,
  disabledTools,
  disabledSet,
  canEdit,
  refresh,
  changeTool,
  save,
}: {
  supported: boolean;
  catalog: readonly string[] | null;
  status: OmpInstallationStatus | null;
  loading: boolean;
  statusError: string | null;
  saveError: string | null;
  saving: boolean;
  configLoaded: boolean;
  disabledTools: readonly string[];
  disabledSet: ReadonlySet<string>;
  canEdit: boolean;
  refresh: () => void;
  changeTool: (name: string, enabled: boolean) => void;
  save: (names: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const toolRows = useMemo(
    () => catalog?.filter((name) => name !== "rewind") ?? emptyTools,
    [catalog],
  );
  const allDisabled = catalog?.every((name) => disabledSet.has(name)) ?? false;
  const turnAllOff = useCallback(() => {
    if (catalog) void save([...new Set([...disabledTools, ...catalog])]);
  }, [catalog, disabledTools, save]);
  const reset = useCallback(() => {
    void save([]);
  }, [save]);

  return (
    <View style={settingsStyles.card} testID="host-page-omp-builtin-tools-card">
      <View style={styles.header}>
        <Text style={settingsStyles.rowTitle}>{t("settings.host.ompBuiltinTools.title")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.host.ompBuiltinTools.description")}</Text>
        <Text style={settingsStyles.rowHint} testID="host-page-omp-builtin-tools-limitations">
          {t("settings.host.ompBuiltinTools.limitations")}
        </Text>
        {supported && status?.installed && catalog ? (
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.ompBuiltinTools.version", { version: status.version })}
          </Text>
        ) : null}
        <InstallationStatusMessage
          supported={supported}
          loading={loading}
          status={status}
          error={statusError}
          configLoaded={configLoaded}
        />
        {saveError ? (
          <Text style={settingsStyles.rowError} testID="host-page-omp-builtin-tools-error">
            {saveError}
          </Text>
        ) : null}
        {saving ? (
          <Text style={settingsStyles.rowHint}>{t("settings.host.ompBuiltinTools.saving")}</Text>
        ) : null}
        {supported && !loading ? (
          <Button
            size="sm"
            variant="ghost"
            style={styles.refresh}
            onPress={refresh}
            disabled={saving}
            testID="host-page-omp-builtin-tools-refresh"
          >
            {t("settings.host.ompBuiltinTools.refresh")}
          </Button>
        ) : null}
      </View>
      {supported && catalog && configLoaded ? (
        <>
          <Pressable
            style={[styles.detailsToggle, settingsStyles.rowBorder]}
            onPress={toggleExpanded}
            accessibilityRole="button"
            accessibilityState={
              expanded ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE
            }
            testID="host-page-omp-builtin-tools-toggle"
          >
            <Text style={styles.detailsToggleText}>
              {t(
                expanded
                  ? "settings.host.ompBuiltinTools.hideTools"
                  : "settings.host.ompBuiltinTools.showTools",
              )}
            </Text>
            {expanded ? (
              <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedIconMapping} />
            )}
          </Pressable>
          {expanded ? (
            <View testID="host-page-omp-builtin-tools-details">
              {toolRows.map((name) => (
                <OmpToolRow
                  key={name}
                  name={name}
                  disabledSet={disabledSet}
                  disabled={!canEdit}
                  onChange={changeTool}
                />
              ))}
              <View style={[styles.actions, settingsStyles.rowBorder]}>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={turnAllOff}
                  disabled={!canEdit || allDisabled}
                  testID="host-page-omp-builtin-tools-all-off"
                >
                  {t("settings.host.ompBuiltinTools.allOff")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={reset}
                  disabled={!canEdit || disabledTools.length === 0}
                  testID="host-page-omp-builtin-tools-reset"
                >
                  {t("settings.host.ompBuiltinTools.reset")}
                </Button>
              </View>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function useOmpInstallationStatus(serverId: string, isConnected: boolean, supported: boolean) {
  const client = useHostRuntimeClient(serverId);
  const [status, setStatus] = useState<OmpInstallationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!isConnected || !client || !supported) {
      setStatus(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    setStatus(null);
    setStatusError(null);
    setLoading(true);
    void (async () => {
      try {
        const next = await client.getOmpInstallationStatus();
        if (!disposed) setStatus(next);
      } catch (error) {
        if (!disposed) setStatusError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [client, isConnected, reloadKey, supported]);

  return { status, loading, statusError, refresh };
}

function InstallationStatusMessage({
  supported,
  loading,
  status,
  error,
  configLoaded,
}: {
  supported: boolean;
  loading: boolean;
  status: OmpInstallationStatus | null;
  error: string | null;
  configLoaded: boolean;
}) {
  const { t } = useTranslation();
  if (!supported) {
    return (
      <Text style={settingsStyles.rowHint} testID="host-page-omp-builtin-tools-unsupported">
        {t("settings.host.ompBuiltinTools.upgradeHost")}
      </Text>
    );
  }
  if (loading) return <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>;
  if (error) return <Text style={settingsStyles.rowError}>{error}</Text>;
  if (!status?.installed) {
    return (
      <Text style={settingsStyles.rowHint}>{t("settings.host.ompBuiltinTools.installOmp")}</Text>
    );
  }
  if (!configLoaded) return <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>;
  return null;
}

function OmpToolRow({
  name,
  disabledSet,
  disabled,
  onChange,
}: {
  name: string;
  disabledSet: ReadonlySet<string>;
  disabled: boolean;
  onChange: (name: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const linked = name === "checkpoint";
  const enabled = linked
    ? !disabledSet.has("checkpoint") && !disabledSet.has("rewind")
    : !disabledSet.has(name);
  const onValueChange = useCallback((next: boolean) => onChange(name, next), [name, onChange]);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{linked ? "checkpoint / rewind" : name}</Text>
        {linked ? (
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.ompBuiltinTools.linkedTools")}
          </Text>
        ) : null}
      </View>
      <Switch
        value={enabled}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={linked ? "checkpoint / rewind" : name}
        testID={`host-page-omp-builtin-tool-${name}-switch`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    padding: theme.spacing[4],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
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
  refresh: {
    alignSelf: "flex-start",
    marginTop: theme.spacing[2],
  },
}));
