import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FolderOpen, Package, Plus, Settings2 } from "lucide-react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import type { LocalPluginSnapshot } from "@omp-desktop/protocol/desktop-local-plugins";
import type { LocalPluginDirectoryInspection } from "@omp-desktop/protocol/desktop-local-plugins";
import type {
  OmpPluginInfo,
  OmpPluginMarketplaceCatalogEntry,
} from "@omp-desktop/protocol/messages";
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
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SelectField } from "@/components/ui/select-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ExternalLink } from "@/components/ui/external-link";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getPluginRowId, isOmpMarketplaceSpec, useOmpPlugins } from "./use-omp-plugins";
import { NativePluginDetails } from "./native-plugin-details";
import { getMarketplacePluginState } from "./marketplace-plugin-state";
import { PluginDirectoryPicker } from "./plugin-directory-picker";
import { inspectPluginDirectorySource } from "./plugin-directory-source";
import { pluginSelectionMemory } from "@/plugins/selection-memory";

type LocalInstallation = LocalPluginSnapshot["installations"][number];
type ManagedPlugin =
  | { kind: "local"; entry: LocalInstallation; hostId: "desktop" }
  | { kind: "daemon"; entry: DesktopPluginCatalogEntry; hostId: string };

function PluginStorageSettings({
  plugin,
  onChanged,
}: {
  plugin: ManagedPlugin;
  onChanged: () => Promise<void>;
}) {
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
      if (plugin.kind === "daemon" && (!client || !connected))
        throw new Error(t("plugins.hostOffline"));
      const snapshot =
        plugin.kind === "local"
          ? await getLocalPluginControl().getSnapshot()
          : await client!.getPluginStorage(plugin.entry.id, plugin.entry.generation);
      const localRecord =
        "installations" in snapshot
          ? snapshot.installations.find(({ id }) => id === plugin.entry.id)
          : null;
      if ("installations" in snapshot && !localRecord) throw new Error(t("plugins.unavailable"));
      const currentRevision =
        "installations" in snapshot ? localRecord!.revision : snapshot.revision;
      const values = "installations" in snapshot ? localRecord!.config : snapshot.values;
      if (sequence === epoch.current) {
        edited.current = false;
        setRevision(currentRevision);
        setDraft(JSON.stringify(values, null, 2));
        setDraftVersion((value) => value + 1);
        setDirty(false);
      }
    } catch (failure) {
      if (sequence === epoch.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (sequence === epoch.current) setBusy(false);
    }
  }, [client, connected, plugin.kind, plugin.hostId, plugin.entry.id, plugin.entry.generation, t]);
  useEffect(() => {
    if (!edited.current) void load();
    else setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [load]);
  const save = async () => {
    if (revision === null || busy) return;
    const sequence = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const patch = z.record(z.string(), z.json()).parse(JSON.parse(draft));
      if (plugin.kind === "daemon" && (!client || !connected))
        throw new Error(t("plugins.hostOffline"));
      if (plugin.kind === "local")
        await getLocalPluginControl().patch({
          installationId: plugin.entry.id,
          expectedRevision: revision,
          patch: { config: patch },
        });
      else
        await client!.patchPluginStorage(plugin.entry.id, patch, revision, plugin.entry.generation);
      await onChanged();
      if (sequence === epoch.current) await load();
    } catch (failure) {
      if (sequence === epoch.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (sequence === epoch.current) setBusy(false);
    }
  };
  return (
    <View style={{ gap: 12 }}>
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      <Field label={t("plugins.configurationPatch")} hint={t("plugins.configurationPatchHint")}>
        <FormTextInput
          initialValue={draft}
          resetKey={draftVersion}
          multiline
          editable={!busy && revision !== null}
          onChangeText={(value) => {
            edited.current = true;
            setDraft(value);
            setDirty(true);
          }}
          testID="plugin-configuration-patch"
        />
      </Field>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          disabled={busy || !dirty || revision === null || (plugin.kind === "daemon" && !connected)}
          onPress={() => void save()}
        >
          {t("plugins.saveConfiguration")}
        </Button>
        <Button variant="outline" disabled={busy} onPress={() => void load()}>
          {t("plugins.loadConfiguration")}
        </Button>
      </View>
    </View>
  );
}

function ManagedPluginSettings({
  plugin,
  onChanged,
}: {
  plugin: ManagedPlugin;
  onChanged: () => Promise<void>;
}) {
  const pages = usePluginContributions("settings", plugin.hostId, plugin.entry.owner);
  const host = usePluginHostProps(plugin.hostId, plugin.entry.owner);
  const matches = pages.filter(({ instance }) => instance.installation.id === plugin.entry.id);
  return (
    <View style={{ gap: 16 }}>
      <PluginSettingsActions
        hostId={plugin.hostId}
        owner={plugin.entry.owner}
        installationId={plugin.entry.id}
      />
      {matches.length ? (
        matches.map(({ key, instance, contribution }) => (
          <PluginView key={key} instance={instance}>
            <contribution.Component
              {...host}
              installation={instance.installation}
              mode={instance.mode}
            />
          </PluginView>
        ))
      ) : (
        <PluginStorageSettings
          key={JSON.stringify([
            plugin.entry.owner,
            plugin.hostId,
            plugin.entry.id,
            plugin.entry.generation,
          ])}
          plugin={plugin}
          onChanged={onChanged}
        />
      )}
    </View>
  );
}

type NativePlugin = { kind: "native"; entry: OmpPluginInfo; hostId: string };
type InstalledPlugin = ManagedPlugin | NativePlugin;
type CatalogPlugin = {
  kind: "catalog";
  entry: OmpPluginMarketplaceCatalogEntry;
  marketplace: string;
};
type PreparedDirectory =
  | { kind: "native"; id: string; directory: string }
  | {
      kind: "local" | "daemon";
      inspection: Pick<LocalPluginDirectoryInspection, "id" | "version" | "capabilities">;
      directory: string;
    };

function installationKey(plugin: InstalledPlugin): string {
  return plugin.kind === "native"
    ? `native:${getPluginRowId(plugin.entry)}`
    : `${plugin.kind}:${plugin.entry.id}`;
}

function pluginName(plugin: InstalledPlugin | CatalogPlugin): string {
  return plugin.kind === "native" || plugin.kind === "catalog"
    ? plugin.entry.name
    : plugin.entry.id;
}

function PluginListRow({
  name,
  version,
  subtitle,
  description,
  status,
  error,
  actions,
  testID,
}: {
  name: string;
  version?: string;
  subtitle: string;
  description?: string;
  status?: ReactNode;
  error?: string | null;
  actions: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.pluginRow} testID={testID}>
      <View style={styles.pluginContent}>
        <View style={styles.titleLine}>
          <Text style={settingsStyles.rowTitle}>{name}</Text>
          {version ? <Text style={styles.version}>{version}</Text> : null}
        </View>
        {description ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <View style={styles.subtitleLine}>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {status}
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

export function PluginsPage({ serverId }: { serverId?: string }) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ plugin?: string; owner?: string }>();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const [selectedHost, setSelectedHost] = useState(serverId);
  useEffect(() => {
    setSelectedHost(serverId);
  }, [serverId]);
  const hostId = selectedHost ?? localServerId ?? hosts[0]?.serverId ?? "";
  const hostLabel = hosts.find((host) => host.serverId === hostId)?.label || hostId;
  const client = useHostRuntimeClient(hostId);
  const connected = useHostRuntimeIsConnected(hostId);
  const isLocalHost = useIsLocalDaemon(hostId);
  const desktopAvailable = !!getDesktopHost()?.plugins;
  const { config, patchConfig } = useDaemonConfig(hostId || null);
  const daemon = useDaemonPluginCatalog(hostId || undefined);
  const local = useLocalPluginCatalog();
  const registry = usePluginClientSnapshot();
  const selectionMemory = useSyncExternalStore(
    pluginSelectionMemory.subscribe,
    pluginSelectionMemory.getSnapshot,
    pluginSelectionMemory.getSnapshot,
  );
  const [context, setContext] = useState<{ hostId: string; directory: string } | null>(null);
  const cwd = context?.hostId === hostId ? context.directory : undefined;
  const native = useOmpPlugins(hostId, cwd);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"configuration" | "permissions" | "logs">(
    "configuration",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"catalog" | "folder" | "source">("catalog");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [directory, setDirectory] = useState("");
  const [prepared, setPrepared] = useState<PreparedDirectory | null>(null);
  const [folderLocation, setFolderLocation] = useState<"host" | "desktop">("host");
  const [installationId, setInstallationId] = useState("");
  const [advancedInstall, setAdvancedInstall] = useState(false);
  const [installSpec, setInstallSpec] = useState("");
  const [installScope, setInstallScope] = useState<"user" | "project">("user");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const actionBusy = !!busy || native.operation !== null;
  const actionEpoch = useRef({ hostId, routeServerId: serverId, locked: false });
  if (actionEpoch.current.hostId !== hostId || actionEpoch.current.routeServerId !== serverId)
    actionEpoch.current = { hostId, routeServerId: serverId, locked: false };
  useEffect(
    () => () => {
      actionEpoch.current = { ...actionEpoch.current, locked: false };
    },
    [],
  );
  useEffect(() => {
    setBusy(null);
    setError(null);
    setLogs(null);
    setPrepared(null);
    setDirectory("");
    setInstallScope("user");
    setSelectedKey(null);
  }, [hostId]);
  useEffect(() => {
    if (typeof params.plugin === "string")
      setSelectedKey(
        `${params.owner === "desktop" || (!params.owner && !serverId) ? "local" : "daemon"}:${params.plugin}`,
      );
  }, [params.plugin, params.owner, serverId, hostId]);

  const managed = useMemo<ManagedPlugin[]>(
    () => [
      ...(local.snapshot?.installations ?? []).map((entry) => ({
        kind: "local" as const,
        hostId: "desktop" as const,
        entry,
      })),
      ...daemon.plugins.map((entry) => ({ kind: "daemon" as const, hostId, entry })),
    ],
    [local.snapshot, daemon.plugins, hostId],
  );
  const installed = useMemo<InstalledPlugin[]>(
    () =>
      [
        ...managed.filter(({ entry }) => entry.installed !== false),
        ...native.plugins.map((entry) => ({ kind: "native" as const, hostId, entry })),
      ].sort((a, b) => pluginName(a).localeCompare(pluginName(b))),
    [managed, native.plugins, hostId],
  );
  const visible = installed.filter((plugin) =>
    `${pluginName(plugin)} ${plugin.entry.id ?? ""} ${plugin.kind === "native" ? (plugin.entry.description ?? "") : ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const available = useMemo<(ManagedPlugin | CatalogPlugin)[]>(
    () =>
      [
        ...managed.filter(({ entry }) => entry.installed === false),
        ...native.marketplaces.flatMap((marketplace) =>
          (marketplace.plugins ?? []).map((entry) => ({
            kind: "catalog" as const,
            entry,
            marketplace: marketplace.name,
          })),
        ),
      ].sort((a, b) => pluginName(a).localeCompare(pluginName(b))),
    [managed, native.marketplaces],
  );
  const catalog = available.filter((plugin) =>
    `${pluginName(plugin)} ${plugin.kind === "catalog" ? (plugin.entry.description ?? "") : ""}`
      .toLowerCase()
      .includes(catalogQuery.trim().toLowerCase()),
  );
  const detail = installed.find((plugin) => installationKey(plugin) === selectedKey);
  const hostEnabled = config?.pluginsEnabled ?? daemon.pluginsEnabled;
  const perform = useCallback(
    async (key: string, operation: (isCurrent: () => boolean) => Promise<void>) => {
      const epoch = actionEpoch.current;
      if (epoch.locked) return;
      epoch.locked = true;
      const isCurrent = () => actionEpoch.current === epoch;
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        await operation(isCurrent);
      } catch (failure) {
        if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        epoch.locked = false;
        if (isCurrent()) setBusy(null);
      }
    },
    [],
  );
  const refresh = useCallback(async (plugin: ManagedPlugin) => {
    if (plugin.kind === "local") await reloadLocalPluginCatalog();
    else await reloadDaemonPluginCatalog(plugin.hostId);
  }, []);
  const toggle = (plugin: ManagedPlugin, enabled: boolean) =>
    void perform(installationKey(plugin), async () => {
      if (plugin.kind === "local")
        await getLocalPluginControl().patch({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
          patch: { enabled },
        });
      else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        if (enabled) await client.enablePlugin(plugin.entry.id);
        else await client.disablePlugin(plugin.entry.id);
      }
      await refresh(plugin);
    });
  const approve = (plugin: ManagedPlugin) =>
    void perform(`approve:${plugin.entry.id}`, async (isCurrent) => {
      const trusted = await confirmDialog({
        title: t("plugins.trustTitle"),
        message: t("plugins.trustMessage", {
          source: plugin.kind === "local" ? plugin.entry.source.identity : plugin.entry.source.path,
          version: plugin.entry.version,
          capabilities: plugin.entry.declaredCapabilities.join(", ") || "—",
        }),
        confirmLabel: t("plugins.trust"),
        cancelLabel: t("common.actions.cancel"),
        destructive: false,
      });
      if (!trusted || !isCurrent()) return;
      if (plugin.kind === "local")
        await getLocalPluginControl().patch({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
          patch: { trusted: true, grantedCapabilities: [...plugin.entry.declaredCapabilities] },
        });
      else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        const approved = await client.approvePlugin(
          plugin.entry.id,
          {
            trusted: true,
            version: plugin.entry.version,
            capabilities: [...plugin.entry.declaredCapabilities],
          },
          {
            sourcePath: plugin.entry.source.path,
            packageId: plugin.entry.packageId,
            generation: plugin.entry.generation,
          },
        );
        if (approved.clientBundle) await approvePluginClientTrust(plugin.hostId, approved);
      }
      await refresh(plugin);
    });
  const remove = (plugin: ManagedPlugin) =>
    void perform(`remove:${plugin.entry.id}`, async (isCurrent) => {
      if (
        !(await confirmDialog({
          title: t("plugins.removeTitle", { id: plugin.entry.id }),
          message: t("plugins.removeMessage"),
          confirmLabel: t("plugins.remove"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        })) ||
        !isCurrent()
      )
        return;
      if (plugin.kind === "local")
        await getLocalPluginControl().remove({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
        });
      else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        await client.removePlugin(plugin.entry.id);
      }
      await refresh(plugin);
      if (isCurrent()) setSelectedKey(null);
    });
  const restart = (plugin: ManagedPlugin) =>
    void perform(`reload:${plugin.entry.id}`, async () => {
      if (plugin.kind === "local")
        await getLocalPluginControl().reload({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
        });
      else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        await client.reloadPlugin(plugin.entry.id);
      }
      await refresh(plugin);
    });
  const clearData = (plugin: ManagedPlugin) =>
    void perform(`clear:${plugin.entry.id}`, async (isCurrent) => {
      if (
        !(await confirmDialog({
          title: t("plugins.clearTitle", { id: plugin.entry.id }),
          message: t("plugins.clearMessage"),
          confirmLabel: t("plugins.clearData"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        })) ||
        !isCurrent()
      )
        return;
      if (plugin.kind === "local")
        await getLocalPluginControl().clearData({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
        });
      else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        await client.clearPluginData(plugin.entry.id);
      }
      await refresh(plugin);
    });
  const readLogs = (plugin: ManagedPlugin) =>
    void perform(`logs:${plugin.entry.id}`, async (isCurrent) => {
      if (plugin.kind === "daemon" && (!client || !connected))
        throw new Error(t("plugins.hostOffline"));
      const entries =
        plugin.kind === "local"
          ? await getLocalPluginControl().getLogs({ installationId: plugin.entry.id })
          : await client!.getPluginLogs(plugin.entry.id);
      if (isCurrent())
        setLogs(
          entries
            .map((entry) => `${entry.timestamp} ${entry.stream}: ${entry.message}`)
            .join("\n") || t("plugins.emptyLogs"),
        );
    });
  const openInstaller = (mode: typeof addMode = "catalog") => {
    setError(null);
    setNotice(null);
    setAddMode(mode);
    setAddOpen(true);
    setPrepared(null);
    setDirectory("");
    setInstallationId("");
    setAdvancedInstall(false);
    setFolderLocation(connected ? "host" : "desktop");
  };
  const prepareDirectory = (path: string) => {
    setDirectory(path);
    setPrepared(null);
    void perform("inspect-directory", async (isCurrent) => {
      if (folderLocation === "desktop") {
        const inspection = await getDesktopHost()!.plugins!.inspectDirectory({ directory: path });
        if (isCurrent()) setPrepared({ kind: "local", inspection, directory: path });
        return;
      }
      if (!client || !connected) throw new Error(t("plugins.hostOffline"));
      const source = await inspectPluginDirectorySource(path, client);
      if (!isCurrent()) return;
      if (source.kind === "native") {
        setPrepared({ kind: "native", id: source.id, directory: path });
        return;
      }
      if (source.owner === "desktop" && (!desktopAvailable || !isLocalHost))
        throw new Error(t("plugins.remoteDesktopFolder"));
      const inspection =
        source.owner === "desktop"
          ? await getDesktopHost()!.plugins!.inspectDirectory({ directory: path })
          : await client.inspectDirectoryPlugin(path);
      if (!inspection.version || !inspection.capabilities)
        throw new Error(t("plugins.invalidInspection"));
      if (isCurrent())
        setPrepared({
          kind: source.owner === "desktop" ? "local" : "daemon",
          inspection: {
            id: inspection.id,
            version: inspection.version,
            capabilities: inspection.capabilities,
          },
          directory: path,
        });
    });
  };
  const installPrepared = () => {
    if (!prepared) return;
    if (prepared.kind === "native") {
      void native.install(prepared.directory).then((ok) => {
        if (ok) setAddOpen(false);
      });
      return;
    }
    void perform("install", async (isCurrent) => {
      const { inspection, directory: path } = prepared;
      if (
        !(await confirmDialog({
          title: t("plugins.trustTitle"),
          message: t("plugins.trustMessage", {
            source: path,
            version: inspection.version,
            capabilities: inspection.capabilities.join(", ") || "—",
          }),
          confirmLabel: t("plugins.trustInstall"),
          cancelLabel: t("common.actions.cancel"),
          destructive: false,
        })) ||
        !isCurrent()
      )
        return;
      const approval = {
        trusted: true as const,
        version: inspection.version,
        capabilities: inspection.capabilities,
      };
      if (prepared.kind === "local") {
        const control = getDesktopHost()!.plugins!;
        const snapshot = await control.getSnapshot();
        if (!isCurrent()) return;
        await control.installDirectory({
          directory: path,
          installationId: installationId.trim() || undefined,
          expectedRevision: snapshot.revision,
          approval,
        });
        await reloadLocalPluginCatalog();
      } else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        const result = await client.installDirectoryPlugin(
          path,
          installationId.trim() || undefined,
          { enabled: false, approval },
        );
        const entry = (await client.getPluginCatalog()).find(({ id }) => id === result.id);
        if (entry?.clientBundle) await approvePluginClientTrust(hostId, entry);
        await reloadDaemonPluginCatalog(hostId);
      }
      if (isCurrent()) {
        setAddOpen(false);
        setNotice(t("plugins.installedDisabled"));
      }
    });
  };
  const restore = (plugin: ManagedPlugin) =>
    void perform(`restore:${plugin.entry.id}`, async (isCurrent) => {
      if (plugin.kind === "local") {
        await getLocalPluginControl().reinstall({
          installationId: plugin.entry.id,
          expectedRevision: plugin.entry.revision,
        });
        await refresh(plugin);
      } else {
        if (!client || !connected) throw new Error(t("plugins.hostOffline"));
        const inspection = await client.inspectDirectoryPlugin(plugin.entry.source.path);
        if (!inspection.version || !inspection.capabilities)
          throw new Error(t("plugins.invalidInspection"));
        if (
          !isCurrent() ||
          !(await confirmDialog({
            title: t("plugins.trustTitle"),
            message: t("plugins.trustMessage", {
              source: plugin.entry.source.path,
              version: inspection.version,
              capabilities: inspection.capabilities.join(", ") || "—",
            }),
            confirmLabel: t("plugins.trustInstall"),
            cancelLabel: t("common.actions.cancel"),
            destructive: false,
          })) ||
          !isCurrent()
        )
          return;
        await client.installDirectoryPlugin(plugin.entry.source.path, plugin.entry.id, {
          enabled: false,
          approval: {
            trusted: true,
            version: inspection.version,
            capabilities: inspection.capabilities,
          },
        });
        const restored = (await client.getPluginCatalog()).find(({ id }) => id === plugin.entry.id);
        if (restored?.clientBundle) await approvePluginClientTrust(plugin.hostId, restored);
        await refresh(plugin);
      }
      if (isCurrent()) {
        setAddOpen(false);
        setNotice(t("plugins.installedDisabled"));
      }
    });
  const subtitle = (plugin: InstalledPlugin | CatalogPlugin) => {
    if (plugin.kind === "catalog") return `OMP · ${plugin.marketplace}`;
    if (plugin.kind === "native")
      return `OMP · ${t(plugin.entry.scope === "project" ? "plugins.projectScope" : "plugins.userScope")}${plugin.entry.shadowedBy === "project" ? ` · ${t("plugins.shadowed")}` : ""}`;
    return `Desktop · ${plugin.kind === "local" ? t("plugins.thisDevice") : hostLabel}`;
  };
  const scopeControl = cwd ? (
    <SegmentedControl
      value={installScope}
      onValueChange={setInstallScope}
      size="sm"
      options={[
        { value: "user", label: t("plugins.userScope"), disabled: actionBusy },
        { value: "project", label: t("plugins.projectScope"), disabled: actionBusy },
      ]}
    />
  ) : null;
  const showError = (value: string | null | undefined) =>
    value ? (
      <Text accessibilityRole="alert" style={settingsStyles.rowError}>
        {value}
      </Text>
    ) : null;

  return (
    <View style={styles.container} testID="plugins-manager">
      <View style={styles.toolbar}>
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("plugins.search")}
            clearAccessibilityLabel={t("plugins.clearSearch")}
            testID="plugins-search"
          />
        </View>
        <Button
          variant="default"
          leftIcon={Plus}
          onPress={() => openInstaller()}
          disabled={actionBusy}
          testID="plugins-add"
        >
          {t("plugins.add")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Settings2}
          accessibilityLabel={t("plugins.managementSettings")}
          onPress={() => setSettingsOpen(true)}
          disabled={actionBusy}
          testID="plugins-settings"
        />
      </View>
      {hosts.length > 1 ? (
        <View style={styles.hostSelector}>
          <SelectField
            field={false}
            size="sm"
            label={t("plugins.host")}
            value={hostId}
            selectedDisplay={{ label: hostLabel }}
            options={hosts.map((host) => ({
              id: host.serverId,
              value: host.serverId,
              label: host.label || host.serverId,
            }))}
            onChange={setSelectedHost}
            placeholder={t("plugins.host")}
            emptyText={t("plugins.hostOffline")}
            disabled={actionBusy}
            testID="plugins-host"
          />
        </View>
      ) : null}
      {cwd ? (
        <Text style={settingsStyles.rowHint}>{t("plugins.projectContext", { cwd })}</Text>
      ) : null}
      {showError(!addOpen && !settingsOpen ? error : null)}
      {showError(selectionMemory.error)}
      {showError(local.error)}
      {showError(daemon.error)}
      {showError(!addOpen && !settingsOpen ? native.error : null)}
      {native.pageState === "error" && !addOpen && !settingsOpen ? (
        <Button size="sm" variant="outline" onPress={() => void native.load()}>
          {t("settings.host.ompPlugins.states.retry")}
        </Button>
      ) : null}
      {notice || native.notice ? (
        <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
          {notice || t(`plugins.notices.${native.notice}`)}
        </Text>
      ) : null}
      {hostId && !connected ? (
        <Text style={settingsStyles.rowHint}>
          {t(desktopAvailable ? "plugins.hostOfflineLocalAvailable" : "plugins.hostOffline")}
        </Text>
      ) : null}
      <View style={settingsStyles.card} testID="plugins-unified-list">
        {visible.map((plugin) => {
          const key = installationKey(plugin);
          const isNative = plugin.kind === "native";
          const paused = plugin.kind === "daemon" && plugin.entry.enabled && !hostEnabled;
          const status = isNative
            ? plugin.entry.enabled
              ? "enabled"
              : "disabled"
            : paused
              ? "paused"
              : plugin.entry.status;
          const rowError = isNative
            ? null
            : plugin.entry.error ||
              registry.errors.get(
                pluginInstanceKey(plugin.hostId, plugin.entry.id, plugin.entry.owner),
              );
          const disabled =
            actionBusy ||
            (plugin.kind !== "local" && !connected) ||
            (isNative && native.controlsDisabled);
          return (
            <PluginListRow
              key={key}
              name={pluginName(plugin)}
              version={plugin.entry.version}
              subtitle={subtitle(plugin)}
              description={isNative ? plugin.entry.description : undefined}
              error={rowError}
              testID={`plugin-row-${key}`}
              status={
                <StatusBadge
                  label={t(`plugins.status.${status}`, { defaultValue: status })}
                  variant={
                    status === "failed"
                      ? "error"
                      : ["active", "running", "enabled"].includes(status)
                        ? "success"
                        : ["waiting", "paused"].includes(status)
                          ? "warning"
                          : "muted"
                  }
                />
              }
              actions={
                <>
                  <Switch
                    value={plugin.entry.enabled === true}
                    disabled={disabled}
                    onValueChange={(enabled) =>
                      isNative ? void native.toggle(plugin.entry, enabled) : toggle(plugin, enabled)
                    }
                    accessibilityLabel={t("plugins.toggle", { id: pluginName(plugin) })}
                    testID={`plugins-toggle-${key}`}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionBusy}
                    onPress={() => {
                      setError(null);
                      setLogs(null);
                      setSelectedKey(key);
                      setDetailTab("configuration");
                    }}
                    testID={`plugins-configure-${key}`}
                  >
                    {t("plugins.configure")}
                  </Button>
                </>
              }
            />
          );
        })}
        {!visible.length ? (
          <View style={styles.empty}>
            <Text style={settingsStyles.rowHint}>
              {t(
                query
                  ? "plugins.noMatches"
                  : native.pageState === "loading" ||
                      local.status === "loading" ||
                      daemon.status === "loading"
                    ? "plugins.loading"
                    : "plugins.empty",
              )}
            </Text>
            {!query ? (
              <Button variant="outline" size="sm" onPress={() => openInstaller()}>
                {t("plugins.add")}
              </Button>
            ) : null}
          </View>
        ) : null}
      </View>

      <AdaptiveModalSheet
        visible={!!detail}
        onClose={() => {
          if (!actionBusy) setSelectedKey(null);
        }}
        header={{
          title: detail ? pluginName(detail) : "",
          subtitle: detail ? subtitle(detail) : undefined,
        }}
        desktopMaxWidth={720}
        testID="plugins-details"
      >
        {detail ? (
          <View style={styles.panel}>
            {showError(error)}
            {showError(detail.kind === "native" ? native.error : null)}
            {detail.kind === "native" ? (
              <>
                {client ? (
                  <NativePluginDetails
                    key={installationKey(detail)}
                    client={client}
                    name={detail.entry.id ?? detail.entry.name}
                    scope={detail.entry.scope}
                    cwd={cwd}
                    onChanged={() => {
                      void native.load();
                    }}
                  />
                ) : null}
                <View style={styles.metadata}>
                  <Text selectable style={settingsStyles.rowHint}>
                    {detail.entry.id ?? detail.entry.name} · {detail.entry.version}
                  </Text>
                  {detail.entry.source || detail.entry.path ? (
                    <Text selectable style={settingsStyles.rowHint}>
                      {detail.entry.source || detail.entry.path}
                    </Text>
                  ) : null}
                  {detail.entry.path && detail.entry.path !== detail.entry.source ? (
                    <Text selectable style={settingsStyles.rowHint}>
                      {detail.entry.path}
                    </Text>
                  ) : null}
                  {detail.entry.linked ? (
                    <Text style={settingsStyles.rowHint}>{t("plugins.linked")}</Text>
                  ) : null}
                </View>
                <View style={styles.actions}>
                  {!detail.entry.linked ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={native.controlsDisabled || actionBusy}
                      onPress={() => void native.upgrade(detail.entry)}
                    >
                      {t("settings.host.ompPlugins.actions.upgrade")}
                    </Button>
                  ) : null}
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={native.controlsDisabled || actionBusy}
                    onPress={() => void native.remove(detail.entry)}
                  >
                    {t("plugins.remove")}
                  </Button>
                </View>
              </>
            ) : (
              <>
                <SegmentedControl
                  value={detailTab}
                  onValueChange={(tab) => {
                    setDetailTab(tab);
                    if (tab === "logs") readLogs(detail);
                  }}
                  size="sm"
                  options={(["configuration", "permissions", "logs"] as const).map((tab) => ({
                    value: tab,
                    label: t(`plugins.detail.${tab}`),
                    disabled: actionBusy,
                  }))}
                />
                {detailTab === "configuration" ? (
                  <ManagedPluginSettings
                    key={JSON.stringify([detail.hostId, detail.entry.id, detail.entry.generation])}
                    plugin={detail}
                    onChanged={() => refresh(detail)}
                  />
                ) : null}
                {detailTab === "permissions" ? (
                  <View style={styles.panel}>
                    <Text style={settingsStyles.rowHint}>{t("plugins.trustWarning")}</Text>
                    <Text style={settingsStyles.rowTitle}>
                      {t(detail.entry.trusted ? "plugins.trustedState" : "plugins.untrustedState")}
                    </Text>
                    <Text style={settingsStyles.rowTitle}>{t("plugins.declaredCapabilities")}</Text>
                    <Text style={settingsStyles.rowHint}>
                      {detail.entry.declaredCapabilities.join("\n") || t("plugins.noCapabilities")}
                    </Text>
                    <Text style={settingsStyles.rowTitle}>{t("plugins.grantedCapabilities")}</Text>
                    <Text style={settingsStyles.rowHint}>
                      {detail.entry.grantedCapabilities.join("\n") || t("plugins.noCapabilities")}
                    </Text>
                    <View style={styles.actions}>
                      <Button
                        disabled={actionBusy || (detail.kind === "daemon" && !connected)}
                        onPress={() => approve(detail)}
                      >
                        {t("plugins.trust")}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={actionBusy || (detail.kind === "daemon" && !connected)}
                        onPress={() =>
                          void perform("revoke", async () => {
                            if (detail.kind === "local")
                              await getLocalPluginControl().patch({
                                installationId: detail.entry.id,
                                expectedRevision: detail.entry.revision,
                                patch: { trusted: false, grantedCapabilities: [] },
                              });
                            else {
                              await revokePluginClientTrust(detail.hostId, detail.entry.id);
                              if (!client || !connected) throw new Error(t("plugins.hostOffline"));
                              await client.revokePluginTrust(detail.entry.id);
                            }
                            await refresh(detail);
                          })
                        }
                      >
                        {t("plugins.revoke")}
                      </Button>
                    </View>
                  </View>
                ) : null}
                {detailTab === "logs" ? (
                  <Text selectable style={settingsStyles.rowHint}>
                    {logs ?? t("plugins.loadingLogs")}
                  </Text>
                ) : null}
                <View style={styles.metadata}>
                  <Text selectable style={settingsStyles.rowHint}>
                    {detail.entry.id} · {detail.entry.version}
                  </Text>
                  <Text selectable style={settingsStyles.rowHint}>
                    {detail.kind === "local"
                      ? detail.entry.source.identity
                      : detail.entry.source.path}
                  </Text>
                  <Text style={settingsStyles.rowHint}>{t("plugins.linked")}</Text>
                </View>
                <View style={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionBusy || (detail.kind === "daemon" && !connected)}
                    onPress={() => restart(detail)}
                  >
                    {t("plugins.restart")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={actionBusy || (detail.kind === "daemon" && !connected)}
                    onPress={() => remove(detail)}
                  >
                    {t("plugins.remove")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={actionBusy || (detail.kind === "daemon" && !connected)}
                    onPress={() => clearData(detail)}
                  >
                    {t("plugins.clearData")}
                  </Button>
                </View>
              </>
            )}
          </View>
        ) : null}
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={addOpen}
        onClose={() => {
          if (!actionBusy) setAddOpen(false);
        }}
        header={{
          title: t(
            addMode === "folder"
              ? "plugins.installFolder"
              : addMode === "source"
                ? "plugins.installSource"
                : "plugins.add",
          ),
          back:
            addMode !== "catalog"
              ? {
                  onPress: () => {
                    if (!actionBusy) {
                      setAddMode("catalog");
                      setError(null);
                    }
                  },
                }
              : undefined,
        }}
        desktopMaxWidth={640}
        testID="plugins-installer"
      >
        <View style={styles.panel}>
          {showError(error)}
          {showError(native.error)}
          {addMode === "catalog" ? (
            <>
              {available.length ? (
                <>
                  <SearchField
                    value={catalogQuery}
                    onChangeText={setCatalogQuery}
                    placeholder={t("plugins.searchAvailable")}
                    clearAccessibilityLabel={t("plugins.clearSearch")}
                    testID="plugins-catalog-search"
                  />
                  {scopeControl}
                  <View style={styles.catalog}>
                    {catalog.map((plugin) => {
                      if (plugin.kind !== "catalog")
                        return (
                          <PluginListRow
                            key={installationKey(plugin)}
                            name={pluginName(plugin)}
                            version={plugin.entry.version}
                            subtitle={subtitle(plugin)}
                            actions={
                              <Button
                                variant="default"
                                size="sm"
                                disabled={actionBusy || (plugin.kind === "daemon" && !connected)}
                                loading={busy === `restore:${plugin.entry.id}`}
                                onPress={() => restore(plugin)}
                              >
                                {t("plugins.install")}
                              </Button>
                            }
                          />
                        );
                      const state = getMarketplacePluginState(
                        plugin.entry,
                        plugin.marketplace,
                        native.plugins,
                        installScope,
                      );
                      const spec = `${plugin.entry.name}@${plugin.marketplace}`;
                      return (
                        <PluginListRow
                          key={spec}
                          name={plugin.entry.name}
                          version={plugin.entry.version}
                          description={plugin.entry.description}
                          subtitle={subtitle(plugin)}
                          actions={
                            <Button
                              variant="default"
                              size="sm"
                              disabled={
                                native.controlsDisabled ||
                                actionBusy ||
                                (!!state.installed &&
                                  (!state.updateAvailable || !!state.installed.linked))
                              }
                              loading={
                                native.operation ===
                                (state.installed
                                  ? getPluginRowId(state.installed)
                                  : `${spec}:${installScope}`)
                              }
                              onPress={() =>
                                void native
                                  .installMarketplace(
                                    plugin.entry,
                                    plugin.marketplace,
                                    installScope,
                                  )
                                  .then((ok) => {
                                    if (ok) setAddOpen(false);
                                  })
                              }
                              testID={`plugins-catalog-install-${spec}`}
                            >
                              {t(
                                state.installed
                                  ? state.updateAvailable && !state.installed.linked
                                    ? "settings.host.ompPlugins.actions.upgrade"
                                    : "plugins.installed"
                                  : "plugins.install",
                              )}
                            </Button>
                          }
                        />
                      );
                    })}
                    {!catalog.length ? (
                      <View style={styles.empty}>
                        <Text style={settingsStyles.rowHint}>{t("plugins.noMatches")}</Text>
                      </View>
                    ) : null}
                  </View>
                </>
              ) : native.pageState === "loading" ? (
                <Text style={settingsStyles.rowHint}>{t("plugins.loading")}</Text>
              ) : null}
              {native.pageState === "error" ? (
                <Button size="sm" variant="outline" onPress={() => void native.load()}>
                  {t("settings.host.ompPlugins.states.retry")}
                </Button>
              ) : null}
              <View style={styles.installMethods}>
                <Button
                  variant={available.length ? "outline" : "default"}
                  leftIcon={FolderOpen}
                  onPress={() => setAddMode("folder")}
                  disabled={actionBusy}
                  testID="plugins-install-from-folder"
                >
                  {t("plugins.installFolder")}
                </Button>
                <Button
                  variant="outline"
                  leftIcon={Package}
                  onPress={() => setAddMode("source")}
                  disabled={actionBusy || !connected}
                >
                  {t("plugins.installSource")}
                </Button>
              </View>
            </>
          ) : addMode === "folder" ? (
            <>
              {desktopAvailable && (!isLocalHost || !connected) ? (
                <SegmentedControl
                  size="sm"
                  value={folderLocation}
                  onValueChange={(value) => {
                    setFolderLocation(value);
                    setPrepared(null);
                    setDirectory("");
                    setError(null);
                  }}
                  options={[
                    {
                      value: "host",
                      label: hostLabel || t("plugins.host"),
                      disabled: !connected || actionBusy,
                    },
                    { value: "desktop", label: t("plugins.thisDesktop"), disabled: actionBusy },
                  ]}
                />
              ) : null}
              <PluginDirectoryPicker
                serverId={hostId}
                value={directory}
                onSelect={prepareDirectory}
                label={t("plugins.chooseFolder")}
                local={folderLocation === "desktop" || isLocalHost}
                disabled={actionBusy || (folderLocation === "host" && !connected)}
                testID="plugins-folder-picker"
              />
              {prepared ? (
                <View style={styles.detected}>
                  <Text style={settingsStyles.rowTitle}>
                    {prepared.kind === "native" ? prepared.id : prepared.inspection.id}
                  </Text>
                  <Text style={settingsStyles.rowHint}>
                    {t(
                      prepared.kind === "native"
                        ? "plugins.detectedOmp"
                        : prepared.kind === "local"
                          ? "plugins.detectedDesktop"
                          : "plugins.detectedDaemon",
                    )}
                  </Text>
                </View>
              ) : (
                <Text style={settingsStyles.rowHint}>{t("plugins.autoDetectHint")}</Text>
              )}
              {prepared && prepared.kind !== "native" ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setAdvancedInstall(!advancedInstall)}
                    disabled={actionBusy}
                  >
                    {t("plugins.advancedInstall")}
                  </Button>
                  {advancedInstall ? (
                    <Field
                      label={t("plugins.installationId")}
                      hint={t("plugins.installationIdHint")}
                    >
                      <FormTextInput
                        initialValue={installationId}
                        onChangeText={setInstallationId}
                        testID="plugins-installation-id"
                      />
                    </Field>
                  ) : null}
                  <Text style={settingsStyles.rowHint}>{t("plugins.installDisabledHint")}</Text>
                </>
              ) : null}
              <Button
                variant="default"
                disabled={!prepared || actionBusy}
                loading={busy === "install" || !!native.operation}
                onPress={installPrepared}
                testID="plugins-folder-install"
              >
                {t("plugins.install")}
              </Button>
            </>
          ) : (
            <>
              <Field label={t("plugins.ompSource")} hint={t("plugins.ompSourceHint")}>
                <FormTextInput
                  initialValue={installSpec}
                  onChangeText={setInstallSpec}
                  placeholder={t("plugins.ompSourcePlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="plugins-source-input"
                />
              </Field>
              {isOmpMarketplaceSpec(installSpec, native.marketplaces) ? scopeControl : null}
              <Button
                variant="default"
                disabled={native.controlsDisabled || actionBusy || !installSpec.trim()}
                loading={native.operation === "install"}
                onPress={() =>
                  void native.install(installSpec.trim(), installScope).then((ok) => {
                    if (ok) {
                      setInstallSpec("");
                      setAddOpen(false);
                    }
                  })
                }
                testID="plugins-source-install"
              >
                {t("plugins.install")}
              </Button>
            </>
          )}
        </View>
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={settingsOpen}
        onClose={() => {
          if (!actionBusy) setSettingsOpen(false);
        }}
        header={{ title: t("plugins.managementSettings") }}
        desktopMaxWidth={640}
        testID="plugins-management-settings"
      >
        <View style={styles.panel}>
          {showError(error)}
          {showError(native.error)}
          {hostId ? (
            <>
              <View style={styles.settingRow}>
                <View style={styles.pluginContent}>
                  <Text style={settingsStyles.rowTitle}>{t("plugins.allowHostPlugins")}</Text>
                  <Text style={settingsStyles.rowHint}>{t("plugins.daemonExecutionHint")}</Text>
                </View>
                <Switch
                  value={hostEnabled}
                  disabled={!connected || actionBusy}
                  onValueChange={(enabled) =>
                    void perform("global", async () => {
                      await patchConfig({ pluginsEnabled: enabled });
                      await reloadDaemonPluginCatalog(hostId);
                    })
                  }
                  accessibilityLabel={t("plugins.allowHostPlugins")}
                />
              </View>
              <View style={styles.settingGroup}>
                <Text style={settingsStyles.rowTitle}>{t("plugins.projectSettings")}</Text>
                <Text style={settingsStyles.rowHint}>{t("plugins.projectSettingsHint")}</Text>
                <PluginDirectoryPicker
                  serverId={hostId}
                  value={cwd ?? ""}
                  onSelect={(directory) => setContext({ hostId, directory })}
                  label={t("plugins.chooseProject")}
                  local={isLocalHost}
                  disabled={!connected || actionBusy}
                  testID="plugins-project-picker"
                />
                {cwd ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setContext(null)}
                    disabled={actionBusy}
                  >
                    {t("plugins.userScope")}
                  </Button>
                ) : null}
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.runtimeHint")}
                </Text>
              </View>
              <View style={styles.settingGroup}>
                <Text style={settingsStyles.rowTitle}>{t("plugins.sources")}</Text>
                {native.marketplaces.map((marketplace) => (
                  <View key={marketplace.name} style={styles.settingRow}>
                    <Text style={settingsStyles.rowTitle}>{marketplace.name}</Text>
                    <View style={styles.actions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={native.controlsDisabled || actionBusy}
                        onPress={() => void native.refreshMarketplace(marketplace.name)}
                      >
                        {t("plugins.refresh")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={native.controlsDisabled || actionBusy}
                        onPress={() => void native.removeMarketplace(marketplace.name)}
                      >
                        {t("plugins.remove")}
                      </Button>
                    </View>
                  </View>
                ))}
                <Field label={t("plugins.addSource")}>
                  <FormTextInput
                    initialValue={marketplaceSource}
                    onChangeText={setMarketplaceSource}
                    placeholder="owner/repository"
                    testID="plugins-marketplace-source"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={native.controlsDisabled || actionBusy || !marketplaceSource.trim()}
                  onPress={() =>
                    void native.addMarketplace(marketplaceSource.trim()).then((ok) => {
                      if (ok) setMarketplaceSource("");
                    })
                  }
                >
                  {t("plugins.addSource")}
                </Button>
              </View>
              <View style={styles.settingGroup}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.host.ompPlugins.doctorTitle")}
                </Text>
                <Text style={settingsStyles.rowHint}>{t("plugins.doctorEffect")}</Text>
                <View style={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={native.controlsDisabled || actionBusy}
                    onPress={() => void native.doctor(false)}
                    testID="plugins-doctor"
                  >
                    {t("settings.host.ompPlugins.actions.doctor")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={native.controlsDisabled || actionBusy}
                    onPress={() => void native.doctor(true)}
                  >
                    {t("settings.host.ompPlugins.actions.doctorFix")}
                  </Button>
                </View>
                {native.doctorChecks?.map((check) => (
                  <View key={check.name} style={styles.settingRow}>
                    <StatusBadge
                      label={check.name}
                      variant={
                        check.status === "ok"
                          ? "success"
                          : check.status === "warning"
                            ? "warning"
                            : "error"
                      }
                    />
                    <Text style={settingsStyles.rowHint}>{check.message}</Text>
                  </View>
                ))}
                {native.output ? (
                  <Text selectable style={settingsStyles.rowHint}>
                    {native.output}
                  </Text>
                ) : null}
              </View>
            </>
          ) : null}
          <ExternalLink href="https://omp.sh/docs/plugins" label={t("plugins.guide")} />
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[4] },
  toolbar: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  search: { flex: 1, minWidth: 180 },
  hostSelector: { alignSelf: "flex-start", maxWidth: "100%" },
  pluginRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexWrap: "wrap",
  },
  pluginContent: { flex: 1, minWidth: 160, gap: theme.spacing[1] },
  titleLine: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  version: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  subtitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  empty: { alignItems: "center", padding: theme.spacing[6], gap: theme.spacing[3] },
  panel: { gap: theme.spacing[4] },
  catalog: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  installMethods: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  detected: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
  },
  metadata: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  settingGroup: {
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
  },
}));
