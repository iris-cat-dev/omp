import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import type { LocalPluginSnapshot } from "@omp-desktop/protocol/desktop-local-plugins";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SearchField } from "@/components/ui/search-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { getDesktopHost } from "@/desktop/host";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useDaemonPluginCatalog, reloadDaemonPluginCatalog } from "@/plugins/catalog";
import { useLocalPluginCatalog, reloadLocalPluginCatalog } from "@/plugins/local-runtime";
import { usePluginClientSnapshot, usePluginContributions } from "@/plugins/hooks";
import { pluginInstanceKey } from "@/plugins/registry";
import { approvePluginClientTrust, revokePluginClientTrust } from "@/plugins/client-trust";
import { PluginView, usePluginHostProps } from "@/plugins/view";
import { PluginSettingsActions } from "@/plugins/menus";
import { getLocalPluginControl } from "@/plugins/local-control";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "./settings-section";
import { OmpPluginsPage } from "./omp-plugins-page";
import { pluginSelectionMemory } from "@/plugins/selection-memory";

type LocalInstallation = LocalPluginSnapshot["installations"][number];
type ManagedPlugin = { kind: "local"; entry: LocalInstallation; hostId: "desktop" } | { kind: "daemon"; entry: DesktopPluginCatalogEntry; hostId: string };

function PluginStorageSettings({ plugin, onChanged }: { plugin: ManagedPlugin; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(plugin.kind === "daemon" ? plugin.hostId : "");
  const connected = useHostRuntimeIsConnected(plugin.kind === "daemon" ? plugin.hostId : "");
  const [revision, setRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [draftVersion, setDraftVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const edited = useRef(false);
  const load = useCallback(async () => {
    const sequence = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (plugin.kind === "daemon" && (!client || !connected)) throw new Error(t("plugins.hostOffline"));
      const snapshot = plugin.kind === "local" ? await getLocalPluginControl().getSnapshot() : await client!.getPluginStorage(plugin.entry.id, plugin.entry.generation);
      const localRecord = "installations" in snapshot ? snapshot.installations.find(({ id }) => id === plugin.entry.id) : null;
      if ("installations" in snapshot && !localRecord) throw new Error(t("plugins.unavailable"));
      const currentRevision = "installations" in snapshot ? localRecord!.revision : snapshot.revision;
      const values = "installations" in snapshot ? localRecord!.config : snapshot.values;
      if (sequence === epoch.current) { edited.current = false; setRevision(currentRevision); setDraft(JSON.stringify(values, null, 2)); setDraftVersion((value) => value + 1); setDirty(false); }
    } catch (failure) {
      if (sequence === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (sequence === epoch.current) setBusy(false); }
  }, [client, connected, plugin.kind, plugin.hostId, plugin.entry.id, plugin.entry.generation, t]);
  useEffect(() => { if (!edited.current) void load(); else setBusy(false); return () => { epoch.current++; }; }, [load]);
  const save = async () => {
    if (revision === null || busy) return;
    const sequence = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const patch = z.record(z.string(), z.json()).parse(JSON.parse(draft));
      if (plugin.kind === "daemon" && (!client || !connected)) throw new Error(t("plugins.hostOffline"));
      if (plugin.kind === "local") await getLocalPluginControl().patch({ installationId: plugin.entry.id, expectedRevision: revision, patch: { config: patch } });
      else await client!.patchPluginStorage(plugin.entry.id, patch, revision, plugin.entry.generation);
      await onChanged();
      if (sequence === epoch.current) await load();
    } catch (failure) {
      if (sequence === epoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (sequence === epoch.current) setBusy(false); }
  };
  return <View style={{ gap: 12 }}>
    {error ? <Text accessibilityRole="alert" style={settingsStyles.rowError}>{error}</Text> : null}
    <Field label={t("plugins.configurationPatch")} hint={t("plugins.configurationPatchHint")}><FormTextInput initialValue={draft} resetKey={draftVersion} multiline editable={!busy && revision !== null} onChangeText={(value) => { edited.current = true; setDraft(value); setDirty(true); }} testID="plugin-configuration-patch" /></Field>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button disabled={busy || !dirty || revision === null || (plugin.kind === "daemon" && !connected)} onPress={() => void save()}>{t("plugins.saveConfiguration")}</Button>
      <Button variant="outline" disabled={busy} onPress={() => void load()}>{t("plugins.loadConfiguration")}</Button>
    </View>
  </View>;
}

function ManagedPluginSettings({ plugin, onChanged }: { plugin: ManagedPlugin; onChanged: () => Promise<void> }) {
  const pages = usePluginContributions("settings", plugin.hostId, plugin.entry.owner);
  const host = usePluginHostProps(plugin.hostId, plugin.entry.owner);
  const matches = pages.filter(({ instance }) => instance.installation.id === plugin.entry.id);
  return <View style={{ gap: 16 }}>
    <PluginSettingsActions hostId={plugin.hostId} owner={plugin.entry.owner} installationId={plugin.entry.id} />
    {matches.length ? matches.map(({ key, instance, contribution }) => <PluginView key={key} instance={instance}><contribution.Component {...host} installation={instance.installation} mode={instance.mode} /></PluginView>) : <PluginStorageSettings key={JSON.stringify([plugin.entry.owner, plugin.hostId, plugin.entry.id, plugin.entry.generation])} plugin={plugin} onChanged={onChanged} />}
  </View>;
}

export function PluginsPage({ serverId }: { serverId?: string }) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ plugin?: string; owner?: string }>();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(serverId);
  useEffect(() => { setSelectedHost(serverId); }, [serverId]);
  const hostId = selectedHost ?? "";
  const client = useHostRuntimeClient(hostId);
  const connected = useHostRuntimeIsConnected(hostId);
  const { config, patchConfig } = useDaemonConfig(selectedHost ?? null);
  const daemon = useDaemonPluginCatalog(selectedHost);
  const local = useLocalPluginCatalog();
  const registry = usePluginClientSnapshot();
  const selectionMemory = useSyncExternalStore(pluginSelectionMemory.subscribe, pluginSelectionMemory.getSnapshot, pluginSelectionMemory.getSnapshot);
  const [view, setView] = useState<"installed" | "discover">("installed");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ kind: ManagedPlugin["kind"]; id: string } | null>(() => typeof params.plugin === "string" ? { kind: params.owner === "desktop" || (!params.owner && !serverId) ? "local" : "daemon", id: params.plugin } : null);
  const [detailTab, setDetailTab] = useState<"configuration" | "permissions" | "logs">("configuration");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [directory, setDirectory] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [installTarget, setInstallTarget] = useState<"desktop" | "daemon">(() => getDesktopHost()?.plugins ? "desktop" : "daemon");
  const actionEpoch = useRef({ hostId, routeServerId: serverId, locked: false });
  if (actionEpoch.current.hostId !== hostId || actionEpoch.current.routeServerId !== serverId) actionEpoch.current = { hostId, routeServerId: serverId, locked: false };
  const invalidateActions = useCallback(() => { actionEpoch.current = { ...actionEpoch.current, locked: false }; setBusy(null); setError(null); setLogs(null); }, []);
  useEffect(() => () => { actionEpoch.current = { ...actionEpoch.current, locked: false }; }, []);
  useEffect(() => {
    if (typeof params.plugin !== "string") return;
    invalidateActions();
    setSelected({ kind: params.owner === "desktop" || (!params.owner && !serverId) ? "local" : "daemon", id: params.plugin });
  }, [params.plugin, params.owner, serverId, invalidateActions]);

  const plugins = useMemo<ManagedPlugin[]>(() => [
    ...(local.snapshot?.installations ?? []).filter((entry) => view === "discover" ? entry.source.type === "builtin" || !entry.installed : entry.installed).map((entry) => ({ kind: "local" as const, hostId: "desktop" as const, entry })),
    ...(daemon.plugins).filter((entry) => view === "discover" ? entry.bundled : entry.installed !== false).map((entry) => ({ kind: "daemon" as const, hostId, entry })),
  ], [local.snapshot, daemon.plugins, view, hostId]);
  const visible = plugins.filter((plugin) => `${plugin.entry.id} ${plugin.entry.packageId} ${plugin.kind === "local" ? plugin.entry.source.identity : plugin.entry.source.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  const detail = selected ? plugins.find((plugin) => plugin.kind === selected.kind && plugin.entry.id === selected.id) : undefined;

  const perform = useCallback(async (key: string, operation: (isCurrent: () => boolean) => Promise<void>) => {
    const operationEpoch = actionEpoch.current;
    if (operationEpoch.locked) return;
    operationEpoch.locked = true;
    const isCurrent = () => actionEpoch.current === operationEpoch;
    setBusy(key);
    setError(null);
    try { await operation(isCurrent); }
    catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { operationEpoch.locked = false; if (isCurrent()) setBusy(null); }
  }, []);
  const refresh = useCallback(async (plugin: ManagedPlugin) => {
    if (plugin.kind === "local") await reloadLocalPluginCatalog();
    else await reloadDaemonPluginCatalog(plugin.hostId);
  }, []);
  const toggle = (plugin: ManagedPlugin, enabled: boolean) => void perform(`${plugin.kind}:${plugin.entry.id}`, async () => {
    if (plugin.kind === "local") await getLocalPluginControl().patch({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision, patch: { enabled } });
    else {
      if (!client || !connected) throw new Error(t("plugins.hostOffline"));
      if (enabled) await client.enablePlugin(plugin.entry.id); else await client.disablePlugin(plugin.entry.id);
    }
    await refresh(plugin);
  });
  const approve = (plugin: ManagedPlugin) => void perform(`approve:${plugin.entry.id}`, async (isCurrent) => {
    const trusted = await confirmDialog({ title: t("plugins.trustTitle"), message: t("plugins.trustMessage", { source: plugin.kind === "local" ? plugin.entry.source.identity : plugin.entry.source.path, version: plugin.entry.version, capabilities: plugin.entry.declaredCapabilities.join(", ") || "—" }), confirmLabel: t("plugins.trust"), destructive: false });
    if (!trusted || !isCurrent()) return;
    if (plugin.kind === "local") await getLocalPluginControl().patch({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision, patch: { trusted: true, grantedCapabilities: [...plugin.entry.declaredCapabilities] } });
    else {
      if (!client) throw new Error(t("plugins.hostOffline"));
      const approved = await client.approvePlugin(plugin.entry.id, { trusted: true, version: plugin.entry.version, capabilities: [...plugin.entry.declaredCapabilities] }, { sourcePath: plugin.entry.source.path, packageId: plugin.entry.packageId, generation: plugin.entry.generation });
      if (approved.clientBundle) await approvePluginClientTrust(plugin.hostId, approved);
    }
    await refresh(plugin);
  });
  const remove = (plugin: ManagedPlugin) => void perform(`remove:${plugin.entry.id}`, async (isCurrent) => {
    if (!await confirmDialog({ title: t("plugins.removeTitle", { id: plugin.entry.id }), message: t("plugins.removeMessage"), confirmLabel: t("plugins.remove"), destructive: true }) || !isCurrent()) return;
    if (plugin.kind === "local") await getLocalPluginControl().remove({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision });
    else { if (!client) throw new Error(t("plugins.hostOffline")); await client.removePlugin(plugin.entry.id); }
    await refresh(plugin);
    if (isCurrent()) setSelected(null);
  });
  const restart = (plugin: ManagedPlugin) => void perform(`reload:${plugin.entry.id}`, async () => {
    if (plugin.kind === "local") await getLocalPluginControl().reload({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision });
    else { if (!client) throw new Error(t("plugins.hostOffline")); await client.reloadPlugin(plugin.entry.id); }
    await refresh(plugin);
  });
  const clearData = (plugin: ManagedPlugin) => void perform(`clear:${plugin.entry.id}`, async (isCurrent) => {
    if (!await confirmDialog({ title: t("plugins.clearTitle", { id: plugin.entry.id }), message: t("plugins.clearMessage"), confirmLabel: t("plugins.clearData"), destructive: true }) || !isCurrent()) return;
    if (plugin.kind === "local") await getLocalPluginControl().clearData({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision });
    else { if (!client) throw new Error(t("plugins.hostOffline")); await client.clearPluginData(plugin.entry.id); }
    await refresh(plugin);
  });
  const readLogs = (plugin: ManagedPlugin) => void perform(`logs:${plugin.entry.id}`, async (isCurrent) => {
    const entries = plugin.kind === "local" ? await getLocalPluginControl().getLogs({ installationId: plugin.entry.id }) : await client!.getPluginLogs(plugin.entry.id);
    if (isCurrent()) setLogs(entries.map((entry) => `${entry.timestamp} ${entry.stream}: ${entry.message}`).join("\n") || t("plugins.emptyLogs"));
  });
  const install = () => void perform("install", async (isCurrent) => {
    if (!directory.trim()) return;
    const inspection = installTarget === "desktop" ? await getDesktopHost()!.plugins!.inspectDirectory({ directory: directory.trim() }) : await client!.inspectDirectoryPlugin(directory.trim());
    if (!inspection.version || !inspection.capabilities) throw new Error("Plugin inspection did not return version and capabilities");
    if (!isCurrent() || !await confirmDialog({ title: t("plugins.trustTitle"), message: t("plugins.trustMessage", { source: directory.trim(), version: inspection.version, capabilities: inspection.capabilities.join(", ") || "—" }), confirmLabel: t("plugins.install"), destructive: false }) || !isCurrent()) return;
    if (installTarget === "desktop") {
      const snapshot = await getDesktopHost()!.plugins!.getSnapshot();
      await getDesktopHost()!.plugins!.installDirectory({ directory: directory.trim(), installationId: installationId.trim() || undefined, expectedRevision: snapshot.revision, approval: { trusted: true, version: inspection.version, capabilities: inspection.capabilities } });
      await reloadLocalPluginCatalog();
    } else {
      if (!client || !connected) throw new Error(t("plugins.hostOffline"));
      const installed = await client.installDirectoryPlugin(directory.trim(), installationId.trim() || undefined, { enabled: false, approval: { trusted: true, version: inspection.version, capabilities: inspection.capabilities } });
      const entry = (await client.getPluginCatalog()).find((entry) => entry.id === installed.id);
      if (entry?.clientBundle) await approvePluginClientTrust(hostId, entry);
      await reloadDaemonPluginCatalog(hostId);
    }
    if (isCurrent()) setView("installed");
  });
  const restore = (plugin: ManagedPlugin) => void perform(`restore:${plugin.entry.id}`, async (isCurrent) => {
    if (plugin.kind === "local") { await getLocalPluginControl().reinstall({ installationId: plugin.entry.id, expectedRevision: plugin.entry.revision }); await refresh(plugin); return; }
    if (!client || !connected) throw new Error(t("plugins.hostOffline"));
    const inspection = await client.inspectDirectoryPlugin(plugin.entry.source.path);
    if (!inspection.version || !inspection.capabilities) throw new Error("Plugin inspection did not return version and capabilities");
    if (!isCurrent() || !await confirmDialog({ title: t("plugins.trustTitle"), message: t("plugins.trustMessage", { source: plugin.entry.source.path, version: inspection.version, capabilities: inspection.capabilities.join(", ") || "—" }), confirmLabel: t("plugins.install"), destructive: false }) || !isCurrent()) return;
    await client.installDirectoryPlugin(plugin.entry.source.path, plugin.entry.id, { enabled: false, approval: { trusted: true, version: inspection.version, capabilities: inspection.capabilities } });
    const restored = (await client.getPluginCatalog()).find(({ id }) => id === plugin.entry.id);
    if (restored?.clientBundle) await approvePluginClientTrust(plugin.hostId, restored);
    await refresh(plugin);
  });


  return <View style={{ gap: 20 }} testID="plugins-manager">
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button variant={view === "installed" ? "default" : "outline"} onPress={() => setView("installed")}>{t("plugins.installed")}</Button>
        <Button variant={view === "discover" ? "default" : "outline"} onPress={() => setView("discover")}>{t("plugins.discover")}</Button>
      </View>
      <SearchField value={query} onChangeText={setQuery} placeholder={t("plugins.search")} clearAccessibilityLabel={t("plugins.clearSearch")} testID="plugins-search" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Text style={settingsStyles.rowHint}>{t(`plugins.environment.${getLocalPluginControl().environment}`)}</Text>
        {hosts.map((host) => <Button key={host.serverId} size="sm" variant={hostId === host.serverId ? "default" : "outline"} onPress={() => { invalidateActions(); setSelectedHost(host.serverId); setSelected(null); }}>{host.label ? `${host.label} · ${host.serverId}` : host.serverId}</Button>)}
      </View>
    </View>
    {error ? <Text accessibilityRole="alert" style={settingsStyles.rowError}>{error}</Text> : null}
    {selectionMemory.error ? <Text accessibilityRole="alert" style={settingsStyles.rowError}>{selectionMemory.error}</Text> : null}
    {local.error ? <Text accessibilityRole="alert" style={settingsStyles.rowError}>{local.error}</Text> : null}
    {daemon.error ? <Text accessibilityRole="alert" style={settingsStyles.rowError}>{daemon.error}</Text> : null}
    {selectedHost && !connected ? <Text style={settingsStyles.rowHint}>{t("plugins.hostOfflineLocalAvailable")}</Text> : null}
    {selectedHost && client ? <SettingsSection title={t("plugins.daemonExecution")}>
      <View style={[settingsStyles.card, settingsStyles.row]}>
        <View style={settingsStyles.rowContent}><Text style={settingsStyles.rowTitle}>{t("plugins.allowHostPlugins")}</Text><Text style={settingsStyles.rowHint}>{t("plugins.daemonExecutionHint")}</Text></View>
        <Switch value={config?.pluginsEnabled ?? daemon.pluginsEnabled} disabled={!connected || !!busy} onValueChange={(enabled) => void perform("global", async () => { await patchConfig({ pluginsEnabled: enabled }); await reloadDaemonPluginCatalog(hostId); })} accessibilityLabel={t("plugins.allowHostPlugins")} />
      </View>
    </SettingsSection> : null}
    <SettingsSection title={t(view === "installed" ? "plugins.desktopInstalled" : "plugins.bundledCatalog")}>
      <View style={settingsStyles.card}>
        {visible.map((plugin) => {
          const entry = plugin.entry;
          const key = `${plugin.kind}:${entry.id}`;
          const rowError = registry.errors.get(pluginInstanceKey(plugin.hostId, entry.id, entry.owner));
          const installed = entry.installed !== false;
          const paused = plugin.kind === "daemon" && entry.enabled && entry.status === "disabled" && !(config?.pluginsEnabled ?? daemon.pluginsEnabled);
          return <View key={key} style={[settingsStyles.row, { gap: 12, flexWrap: "wrap" }]} testID={`plugin-row-${key}`}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t(`plugins.names.${entry.packageId}`, { defaultValue: entry.packageId })} · {entry.version}</Text>
              <Text style={settingsStyles.rowHint}>{entry.id} · {plugin.kind === "local" ? t(`plugins.environment.${getLocalPluginControl().environment}`) : `${t("plugins.daemon")} ${plugin.hostId}`}</Text>
              <Text style={settingsStyles.rowHint}>{plugin.kind === "local" ? plugin.entry.source.identity : plugin.entry.source.path}</Text>
              {(plugin.kind === "local" ? plugin.entry.source.type === "local" : !plugin.entry.bundled) ? <Text style={settingsStyles.rowHint}>{t("plugins.linked")}</Text> : null}
              <View style={{ alignSelf: "flex-start" }}><StatusBadge label={t(`plugins.status.${paused ? "paused" : entry.status}`, { defaultValue: entry.status })} variant={entry.status === "failed" ? "error" : entry.status === "running" || entry.status === "active" ? "success" : entry.status === "waiting" ? "warning" : "muted"} /></View>
              {entry.error || rowError ? <Text style={settingsStyles.rowError}>{entry.error || rowError}</Text> : null}
            </View>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {installed ? <><Switch value={entry.enabled} disabled={!!busy || (plugin.kind === "daemon" && !connected)} onValueChange={(enabled) => toggle(plugin, enabled)} accessibilityLabel={t("plugins.toggle", { id: entry.id })} />
                <Button size="sm" variant="outline" onPress={() => { invalidateActions(); setSelected({ kind: plugin.kind, id: entry.id }); setDetailTab("configuration"); }}>{t("plugins.configure")}</Button></> : <Button size="sm" disabled={!!busy || (plugin.kind === "daemon" && !connected)} onPress={() => restore(plugin)}>{t("plugins.install")}</Button>}
            </View>
          </View>;
        })}
        {!visible.length ? <View style={settingsStyles.row}><Text style={settingsStyles.rowHint}>{t("plugins.noMatches")}</Text></View> : null}
      </View>
    </SettingsSection>
    {detail ? <SettingsSection title={`${detail.entry.packageId} · ${detail.entry.id}`}>
      <View style={[settingsStyles.card, { padding: 16, gap: 16 }]}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(["configuration", "permissions", "logs"] as const).map((tab) => <Button key={tab} size="sm" variant={detailTab === tab ? "default" : "outline"} onPress={() => { invalidateActions(); setDetailTab(tab); if (tab === "logs") readLogs(detail); }}>{t(`plugins.detail.${tab}`)}</Button>)}</View>
        {detailTab === "configuration" ? <ManagedPluginSettings plugin={detail} onChanged={() => refresh(detail)} /> : null}
        {detailTab === "permissions" ? <View style={{ gap: 12 }}>
          <Text style={settingsStyles.rowHint}>{t("plugins.trustWarning")}</Text>
          <Text style={settingsStyles.rowTitle}>{t(detail.entry.trusted ? "plugins.trustedState" : "plugins.untrustedState")}</Text>
          <Text style={settingsStyles.rowTitle}>{t("plugins.declaredCapabilities")}</Text>
          <Text style={settingsStyles.rowHint}>{detail.entry.declaredCapabilities.join("\n") || t("plugins.noCapabilities")}</Text>
          <Text style={settingsStyles.rowTitle}>{t("plugins.grantedCapabilities")}</Text>
          <Text style={settingsStyles.rowHint}>{detail.entry.grantedCapabilities.join("\n") || t("plugins.noCapabilities")}</Text>
          <Button disabled={!!busy || (detail.kind === "daemon" && !connected)} onPress={() => approve(detail)}>{t("plugins.trust")}</Button>
          <Button variant="outline" disabled={!!busy} onPress={() => void perform("revoke", async () => {
            if (detail.kind === "local") await getLocalPluginControl().patch({ installationId: detail.entry.id, expectedRevision: detail.entry.revision, patch: { trusted: false, grantedCapabilities: [] } });
            else { await revokePluginClientTrust(detail.hostId, detail.entry.id); if (!client) throw new Error(t("plugins.hostOffline")); await client.revokePluginTrust(detail.entry.id); }
            await refresh(detail);
          })}>{t("plugins.revoke")}</Button>
        </View> : null}
        {detailTab === "logs" ? <Text selectable style={settingsStyles.rowHint}>{logs ?? t("plugins.loadingLogs")}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button size="sm" variant="outline" disabled={!!busy} onPress={() => restart(detail)}>{t("plugins.restart")}</Button>
          <Button size="sm" variant="destructive" disabled={!!busy} onPress={() => remove(detail)}>{t("plugins.remove")}</Button>
          <Button size="sm" variant="outline" disabled={!!busy} onPress={() => clearData(detail)}>{t("plugins.clearData")}</Button>
        </View>
      </View>
    </SettingsSection> : null}
    {view === "discover" ? <SettingsSection title={t("plugins.installDirectory")}>
      <View style={[settingsStyles.card, { padding: 16, gap: 12 }]}>
        <View style={{ flexDirection: "row", gap: 8 }}><Button size="sm" variant={installTarget === "desktop" ? "default" : "outline"} disabled={!getDesktopHost()?.plugins} onPress={() => setInstallTarget("desktop")}>{t("plugins.localProfile")}</Button><Button size="sm" variant={installTarget === "daemon" ? "default" : "outline"} disabled={!connected} onPress={() => setInstallTarget("daemon")}>{t("plugins.daemon")}</Button></View>
        <Field label={t("plugins.directory")}><FormTextInput initialValue={directory} onChangeText={setDirectory} placeholder={t("plugins.directoryPlaceholder")} /></Field>
        <Field label={t("plugins.installationId")} hint={t("plugins.installationIdHint")}><FormTextInput initialValue={installationId} onChangeText={setInstallationId} /></Field>
        <Button disabled={!!busy || !directory.trim() || (installTarget === "daemon" && !connected)} onPress={install}>{t("plugins.inspectAndInstall")}</Button>
      </View>
    </SettingsSection> : null}
    {selectedHost ? <OmpPluginsPage serverId={selectedHost} view={view} query={query} /> : <Text style={settingsStyles.rowHint}>{t("plugins.selectHostNative")}</Text>}
  </View>;
}
