import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import type {
  OmpPluginDoctorCheck,
  OmpPluginInfo,
  OmpPluginMarketplaceInfo,
} from "@omp-desktop/protocol/messages";

import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SearchField } from "@/components/ui/search-field";
import { ExternalLink } from "@/components/ui/external-link";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { PluginPageState } from "@/screens/settings/plugins-page-state";
import { settingsStyles } from "@/styles/settings";
import { getMarketplacePluginState } from "./marketplace-plugin-state";
import { confirmDialog } from "@/utils/confirm-dialog";
import { NativePluginDetails } from "./native-plugin-details";

interface OmpPluginsPageProps {
  serverId: string;
  view?: "installed" | "discover";
  query?: string;
}

interface PluginRowProps {
  plugin: OmpPluginInfo;
  busy: boolean;
  disabled: boolean;
  onToggle: (plugin: OmpPluginInfo, enabled: boolean) => void;
  onRemove: (plugin: OmpPluginInfo) => void;
  onConfigure: (plugin: OmpPluginInfo) => void;
  onUpgrade: (plugin: OmpPluginInfo) => void;
  removeLabel: string;
  toggleLabel: string;
}

interface DoctorCheckRowProps {
  check: OmpPluginDoctorCheck;
}

function getDoctorStatusVariant(status: OmpPluginDoctorCheck["status"]): StatusBadgeVariant {
  if (status === "ok") return "success";
  if (status === "warning") return "warning";
  return "error";
}

type OmpMarketplaceCatalogEntry = NonNullable<OmpPluginMarketplaceInfo["plugins"]>[number];
type MarketplaceScope = "user" | "project";

function metadataText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function getPluginOperationId(plugin: OmpPluginInfo): string {
  return plugin.id ?? plugin.name;
}

function getPluginRowId(plugin: OmpPluginInfo): string {
  return `${getPluginOperationId(plugin)}:${plugin.scope ?? "default"}`;
}

function DoctorCheckRow({ check }: DoctorCheckRowProps) {
  return (
    <View style={styles.checkRow}>
      <View style={styles.checkBadge}>
        <StatusBadge label={check.name} variant={getDoctorStatusVariant(check.status)} />
      </View>
      <Text style={settingsStyles.rowHint}>{check.message}</Text>
    </View>
  );
}

interface MarketplaceCatalogRowProps {
  plugin: OmpMarketplaceCatalogEntry;
  marketplaceName: string;
  busy: boolean;
  disabled: boolean;
  scope: MarketplaceScope;
  installedPlugins: OmpPluginInfo[];
  upgradeLabel: string;
  installedLabel: string;
  onInstall: (plugin: OmpMarketplaceCatalogEntry, marketplaceName: string) => void;
  installLabel: string;
}

function MarketplaceCatalogRow({
  plugin,
  marketplaceName,
  busy,
  disabled,
  scope,
  onInstall,
  installLabel,
  installedPlugins,
  upgradeLabel,
  installedLabel,
}: MarketplaceCatalogRowProps) {
  const { t } = useTranslation();
  const { installed, updateAvailable } = getMarketplacePluginState(
    plugin,
    marketplaceName,
    installedPlugins,
    scope,
  );
  let actionLabel = installLabel;
  if (installed) actionLabel = updateAvailable ? upgradeLabel : installedLabel;
  const handleInstall = useCallback(
    () => onInstall(plugin, marketplaceName),
    [onInstall, plugin, marketplaceName],
  );
  return (
    <View style={styles.pluginRow}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {plugin.name}
          {plugin.version ? `  ${plugin.version}` : ""}
        </Text>
        {plugin.description ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {plugin.description}
          </Text>
        ) : null}
        <Text style={styles.pluginPath}>{`${plugin.name}@${marketplaceName}`}</Text>
        {(["source", "author", "repository", "homepage"] as const).map((field) => {
          const value = metadataText(plugin[field]);
          return value ? (
            <Text key={field} style={settingsStyles.rowHint}>
              {t(`settings.host.ompPlugins.metadata.${field}`)}: {value}
            </Text>
          ) : null;
        })}
      </View>
      <View style={styles.pluginActions}>
        <Button
          size="sm"
          loading={busy}
          disabled={disabled || (!!installed && !updateAvailable)}
          onPress={handleInstall}
          testID={`omp-plugins-catalog-install-${plugin.name}@${marketplaceName}`}
        >
          {actionLabel}
        </Button>
      </View>
    </View>
  );
}
interface MarketplaceEntryCardProps {
  marketplace: OmpPluginMarketplaceInfo;
  expanded: boolean;
  busy: boolean;
  disabled: boolean;
  scope: MarketplaceScope;
  onRefresh: (name: string) => void;
  busyCatalogName: string | null;
  hideLabel: string;
  browseLabel: string;
  removeLabel: string;
  installLabel: string;
  installedPlugins: OmpPluginInfo[];
  upgradeLabel: string;
  installedLabel: string;
  searchPlaceholder: string;
  searchClearLabel: string;
  onToggle: (name: string) => void;
  onRemove: (name: string) => void;
  onInstall: (plugin: OmpMarketplaceCatalogEntry, marketplaceName: string) => void;
}

function MarketplaceEntryCard({
  marketplace,
  expanded,
  busy,
  disabled,
  scope,
  onRefresh,
  busyCatalogName,
  hideLabel,
  browseLabel,
  removeLabel,
  installLabel,
  installedPlugins,
  upgradeLabel,
  installedLabel,
  searchPlaceholder,
  searchClearLabel,
  onToggle,
  onRemove,
  onInstall,
}: MarketplaceEntryCardProps) {
  const { t } = useTranslation();
  const handleRefresh = useCallback(
    () => onRefresh(marketplace.name),
    [onRefresh, marketplace.name],
  );
  const handleToggle = useCallback(() => onToggle(marketplace.name), [onToggle, marketplace.name]);
  const handleRemove = useCallback(() => onRemove(marketplace.name), [onRemove, marketplace.name]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const visiblePlugins = useMemo(() => {
    const all = marketplace.plugins ?? [];
    const q = catalogQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false),
    );
  }, [marketplace.plugins, catalogQuery]);
  return (
    <View style={styles.marketplaceEntry}>
      <View style={[settingsStyles.row, styles.pluginRow]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {marketplace.name}
          </Text>
          {marketplace.source ? (
            <Text style={styles.pluginPath} numberOfLines={1}>
              {marketplace.source}
            </Text>
          ) : null}
        </View>
        <View style={styles.pluginActions}>
          <Button size="sm" variant="outline" onPress={handleToggle}>
            {expanded ? hideLabel : browseLabel}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onPress={handleRefresh}
            testID={`omp-plugins-marketplace-refresh-${marketplace.name}`}
          >
            {t("settings.host.ompPlugins.marketplace.actions.refresh")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={disabled}
            loading={busy}
            onPress={handleRemove}
          >
            {removeLabel}
          </Button>
        </View>
      </View>
      {expanded ? (
        <View style={styles.catalogSearchRow}>
          <SearchField
            value={catalogQuery}
            onChangeText={setCatalogQuery}
            placeholder={searchPlaceholder}
            clearAccessibilityLabel={searchClearLabel}
            testID={`omp-plugins-marketplace-search-${marketplace.name}`}
            clearTestID={`omp-plugins-marketplace-search-clear-${marketplace.name}`}
          />
          {visiblePlugins.map((entry) => (
            <MarketplaceCatalogRow
              key={entry.name}
              plugin={entry}
              marketplaceName={marketplace.name}
              busy={busyCatalogName === `${entry.name}@${marketplace.name}`}
              disabled={disabled}
              scope={scope}
              onInstall={onInstall}
              installLabel={installLabel}
              installedPlugins={installedPlugins}
              upgradeLabel={upgradeLabel}
              installedLabel={installedLabel}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function OmpPluginRow({
  plugin,
  busy,
  disabled,
  onToggle,
  onRemove,
  onConfigure,
  onUpgrade,
  removeLabel,
  toggleLabel,
}: PluginRowProps) {
  const { t } = useTranslation();
  const handleToggle = useCallback((value: boolean) => onToggle(plugin, value), [onToggle, plugin]);
  const handleRemove = useCallback(() => onRemove(plugin), [onRemove, plugin]);
  const configure = useCallback(() => onConfigure(plugin), [onConfigure, plugin]);
  const upgrade = useCallback(() => onUpgrade(plugin), [onUpgrade, plugin]);
  let shadowedLabel = "";
  if (plugin.shadowedBy === "project") {
    shadowedLabel = ` · ${t("settings.host.ompPlugins.scope.shadowed")}`;
  } else if (plugin.scope === "project" && plugin.enabled === true) {
    shadowedLabel = ` · ${t("settings.host.ompPlugins.scope.effectiveProject")}`;
  }
  return (
    <View style={styles.pluginRow}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {plugin.name}
          {plugin.version ? `  ${plugin.version}` : ""}
        </Text>
        {plugin.description ? (
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {plugin.description}
          </Text>
        ) : null}
        <Text style={styles.pluginPath}>{getPluginOperationId(plugin)}</Text>
        <Text style={settingsStyles.rowHint}>
          {plugin.scope === "project"
            ? t("settings.host.ompPlugins.scope.project")
            : t("settings.host.ompPlugins.scope.user")}
          {shadowedLabel}
        </Text>
        {plugin.source ? <Text style={styles.pluginPath}>{plugin.source}</Text> : null}
        {plugin.linked ? <Text style={settingsStyles.rowHint}>{t("plugins.linked", { defaultValue: "链接来源，无法升级" })}</Text> : null}
        {plugin.path ? (
          <Text style={styles.pluginPath} numberOfLines={1}>
            {plugin.path}
          </Text>
        ) : null}
      </View>
      <View style={styles.pluginActions}>
        <Button size="sm" variant="outline" disabled={disabled} onPress={configure}>{t("plugins.configure", { defaultValue: "配置" })}</Button>
        {!plugin.linked ? <Button size="sm" variant="outline" disabled={disabled} onPress={upgrade}>{t("settings.host.ompPlugins.actions.upgrade")}</Button> : null}
        <Switch
          accessibilityLabel={toggleLabel}
          value={plugin.enabled === true}
          onValueChange={handleToggle}
          disabled={disabled}
          testID={`omp-plugins-toggle-${getPluginRowId(plugin)}`}
        />
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled}
          loading={busy}
          onPress={handleRemove}
          testID={`omp-plugins-remove-${getPluginRowId(plugin)}`}
        >
          {removeLabel}
        </Button>
      </View>
    </View>
  );
}

interface FieldControlRowProps {
  initialValue: string;
  onChangeText: (value: string) => void;
  onSubmitEditing: () => void;
  placeholder: string;
  editable: boolean;
  buttonLabel: string;
  buttonLoading: boolean;
  buttonDisabled: boolean;
  buttonTestID: string;
  inputTestID: string;
  onPress: () => void;
}

function FieldControlRow({
  initialValue,
  onChangeText,
  onSubmitEditing,
  placeholder,
  editable,
  buttonLabel,
  buttonLoading,
  buttonDisabled,
  buttonTestID,
  inputTestID,
  onPress,
}: FieldControlRowProps) {
  return (
    <View style={styles.installControlRow}>
      <View style={styles.installInput}>
        <FormTextInput
          initialValue={initialValue}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmitEditing}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          testID={inputTestID}
        />
      </View>
      <Button
        onPress={onPress}
        loading={buttonLoading}
        disabled={buttonDisabled}
        testID={buttonTestID}
      >
        {buttonLabel}
      </Button>
    </View>
  );
}

/** Native SDK management projected into the unified plugin manager. */
export function OmpPluginsPage({ serverId, view = "installed", query = "" }: OmpPluginsPageProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [directory, setDirectory] = useState("");
  const [cwd, setCwd] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const identity = useRef({ client, serverId, generation: 0 });
  if (identity.current.client !== client || identity.current.serverId !== serverId) {
    identity.current = { client, serverId, generation: identity.current.generation + 1 };
  }
  const applyContext = useCallback(() => {
    if (busy || !connected) return;
    const next = directory.trim() || undefined;
    if (next === cwd) return;
    setBusy(true);
    setCwd(next);
  }, [busy, connected, cwd, directory]);

  return (
    <View style={styles.container}>
      <SettingsSection title={t("settings.host.ompPlugins.context.title")}>
        <View style={settingsStyles.card} testID="omp-plugins-context">
          <View style={[settingsStyles.row, styles.installRow]}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.ompPlugins.trustWarning")}</Text>
            <ExternalLink
              href="https://omp.sh/docs/plugins"
              label={t("settings.host.ompPlugins.browsePackages")}
              testID="omp-plugins-docs-link"
            />
            <Field label={t("settings.host.ompPlugins.context.directory")}>
              <FieldControlRow
                initialValue={directory}
                onChangeText={setDirectory}
                onSubmitEditing={applyContext}
                placeholder={t("settings.host.ompPlugins.context.placeholder")}
                editable={!busy && connected}
                buttonLabel={t("settings.host.ompPlugins.context.apply")}
                buttonLoading={busy}
                buttonDisabled={busy || !connected || (directory.trim() || undefined) === cwd}
                buttonTestID="omp-plugins-context-apply"
                inputTestID="omp-plugins-context-directory"
                onPress={applyContext}
              />
            </Field>
            <Text style={settingsStyles.rowHint} testID="omp-plugins-applied-context">
              {cwd
                ? t("settings.host.ompPlugins.context.project", { cwd })
                : t("settings.host.ompPlugins.context.user")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("settings.host.ompPlugins.runtimeHint")}</Text>
          </View>
        </View>
      </SettingsSection>
      <OmpPluginsContextPage
        key={`${identity.current.generation}:${cwd ?? ""}:${connected}`}
        serverId={serverId}
        cwd={cwd}
        view={view}
        query={query}
        onBusyChange={setBusy}
      />
    </View>
  );
}

function OmpPluginsContextPage({
  serverId,
  cwd,
  onBusyChange,
  view = "installed",
  query = "",
}: OmpPluginsPageProps & {
  cwd?: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);

  const [plugins, setPlugins] = useState<OmpPluginInfo[]>([]);
  const [pageState, setPageState] = useState<PluginPageState>("loading");
  const [rawOutput, setRawOutput] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const operationLock = useRef(false);
  const [scope, setScope] = useState<MarketplaceScope>("user");
  const selectUserScope = useCallback(() => setScope("user"), []);
  const selectProjectScope = useCallback(() => setScope("project"), []);
  const [notice, setNotice] = useState<"applied" | "preview" | "catalogRefreshed" | null>(null);
  const [installSpec, setInstallSpec] = useState("");
  const [installDryRun, setInstallDryRun] = useState(false);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [doctorChecks, setDoctorChecks] = useState<OmpPluginDoctorCheck[] | null>(null);
  const [marketplaces, setMarketplaces] = useState<OmpPluginMarketplaceInfo[]>([]);
  const [expandedMarketplace, setExpandedMarketplace] = useState<string | null>(null);
  const [mktSource, setMktSource] = useState("");
  const [details, setDetails] = useState<OmpPluginInfo | null>(null);
  const filteredPlugins = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? plugins.filter((plugin) => `${getPluginOperationId(plugin)} ${plugin.name} ${plugin.description ?? ""}`.toLowerCase().includes(search)) : plugins;
  }, [plugins, query]);

  // Context/client changes remount this page. Old completions can never publish
  // into the new context; the guard also stops chained RPCs after unmount.
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const loadRef = useRef<Promise<void> | null>(null);
  const load = useCallback(async () => {
    if (!client || !connected) {
      setPageState("offline");
      return;
    }
    if (loadRef.current) return loadRef.current;
    const run = (async () => {
      setPageState("loading");
      try {
        const pluginResult = await client.listOmpPlugins(cwd);
        if (!active.current) return;
        const marketplaceResult = await client.listOmpPluginMarketplaces(cwd).catch(() => null);
        if (!active.current) return;
        setPlugins(pluginResult.plugins);
        setRawOutput(pluginResult.rawOutput ?? null);
        // Operation refreshes share this error channel; only standalone loads
        // dismiss the previous load failure, not feedback from an active action.
        if (!operationLock.current) setLoadError(null);
        setPageState(pluginResult.plugins.length === 0 ? "empty" : "ready");
        if (marketplaceResult) setMarketplaces(marketplaceResult.marketplaces);
      } catch (error) {
        if (!active.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setPageState("error");
      } finally {
        loadRef.current = null;
      }
    })();
    loadRef.current = run;
    await run;
  }, [client, connected, cwd]);

  useEffect(() => {
    void load();
  }, [load]);
  const controlsDisabled = !connected || !client || pageState === "loading" || operation !== null;
  useEffect(() => {
    onBusyChange(pageState === "loading" || operation !== null);
  }, [onBusyChange, pageState, operation]);

  const runOperation = useCallback(
    async (key: string, action: () => Promise<void>) => {
      if (!client || !connected || operationLock.current || loadRef.current || !active.current)
        return;
      operationLock.current = true;
      setOperation(key);
      setLoadError(null);
      setNotice(null);
      try {
        await action();
      } catch (error) {
        if (active.current) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        operationLock.current = false;
        if (active.current) setOperation(null);
      }
    },
    [client, connected],
  );

  const handleToggle = useCallback(
    (plugin: OmpPluginInfo, enabled: boolean) =>
      void runOperation(getPluginRowId(plugin), async () => {
        if (!client || (plugin.scope === "project" && !cwd)) return;
        const result = await client.setOmpPluginEnabled(
          getPluginOperationId(plugin),
          enabled,
          plugin.scope,
          cwd,
        );
        if (!active.current) return;
        if (!result.ok) {
          setLoadError(
            result.output ||
              t("settings.host.ompPlugins.feedback.toggleFailed", { id: plugin.name }),
          );
          return;
        }
        setNotice("applied");
        await load();
      }),
    [client, cwd, load, runOperation, t],
  );

  const handleRemove = useCallback(
    (plugin: OmpPluginInfo) =>
      void runOperation(getPluginRowId(plugin), async () => {
        if (!client || (plugin.scope === "project" && !cwd)) return;
        const confirmed = await confirmDialog({
          title: t("settings.host.ompPlugins.removeConfirmTitle", {
            id: getPluginOperationId(plugin),
          }),
          message: t("settings.host.ompPlugins.removeConfirmMessage", {
            scope:
              plugin.scope === "project"
                ? t("settings.host.ompPlugins.scope.project")
                : t("settings.host.ompPlugins.scope.user"),
            cwd: cwd ?? t("settings.host.ompPlugins.context.user"),
          }),
          confirmLabel: t("settings.host.ompPlugins.actions.remove"),
          destructive: true,
        });
        if (!confirmed || !active.current) return;
        const result = await client.removeOmpPlugin(
          getPluginOperationId(plugin),
          plugin.scope,
          cwd,
        );
        if (!active.current) return;
        if (!result.ok) {
          setLoadError(
            result.output ||
              t("settings.host.ompPlugins.feedback.removeFailed", { id: plugin.name }),
          );
          return;
        }
        setNotice("applied");
        await load();
      }),
    [client, cwd, load, runOperation, t],
  );
  const handleUpgrade = useCallback((plugin: OmpPluginInfo) => {
    if (plugin.linked) return;
    void runOperation(getPluginRowId(plugin), async () => {
      if (!client) return;
      const result = await client.upgradeOmpPlugin(getPluginOperationId(plugin), plugin.scope, cwd);
      if (!result.ok) throw new Error(result.output || t("settings.host.ompPlugins.feedback.upgradeFailed", { id: plugin.name }));
      if (active.current) { setNotice("applied"); await load(); }
    });
  }, [client, cwd, load, runOperation, t]);

  const handleInstall = useCallback(async () => {
    if (!client || !installSpec.trim()) return;
    await runOperation("install", async () => {
      setInstallOutput(null);
      const spec = installSpec.trim();
      const marketplaceSpec = /^[^@/:\s]+@[^@/:\s]+$/.test(spec);
      const result = await client.installOmpPlugin({
        spec,
        dryRun: installDryRun,
        cwd,
        ...(marketplaceSpec ? { scope } : {}),
      });
      if (!active.current) return;
      setInstallOutput(result.output ?? null);
      if (!result.ok) {
        setLoadError(
          result.output || t("settings.host.ompPlugins.feedback.installFailed", { id: spec }),
        );
        return;
      }
      if (installDryRun) {
        setNotice("preview");
        return;
      }
      setInstallSpec("");
      setNotice("applied");
      await load();
    });
  }, [client, cwd, installSpec, installDryRun, scope, load, runOperation, t]);

  const handleDoctor = useCallback(
    (fix: boolean) =>
      runOperation("doctor", async () => {
        if (!client) return;
        const result = await client.runOmpPluginDoctor(fix, cwd);
        if (!active.current) return;
        setDoctorChecks(result.checks.length > 0 ? result.checks : null);
        if (result.rawOutput) setInstallOutput(result.rawOutput);
        if (fix) await load();
      }),
    [client, cwd, load, runOperation],
  );

  const handleMarketplaceAdd = useCallback(async () => {
    if (!client || !mktSource.trim()) return;
    await runOperation("marketplace", async () => {
      const result = await client.addOmpPluginMarketplace(mktSource.trim(), cwd);
      if (!active.current) return;
      if (!result.ok) {
        setLoadError(result.output || t("settings.host.ompPlugins.marketplace.feedback.addFailed"));
        return;
      }
      setMktSource("");
      const refreshed = await client.listOmpPluginMarketplaces(cwd);
      if (!active.current) return;
      setMarketplaces(refreshed.marketplaces);
      if (result.marketplace) setExpandedMarketplace(result.marketplace.name);
    });
  }, [client, cwd, mktSource, runOperation, t]);

  const removeMarketplaceFromState = useCallback((name: string) => {
    setMarketplaces((prev) => prev.filter((entry) => entry.name !== name));
    setExpandedMarketplace((prev) => (prev === name ? null : prev));
  }, []);

  const handleMarketplaceRemove = useCallback(
    (name: string) =>
      runOperation("marketplace", async () => {
        if (!client) return;
        const result = await client.removeOmpPluginMarketplace(name, cwd);
        if (!active.current) return;
        if (result.ok) {
          removeMarketplaceFromState(name);
        } else {
          setLoadError(
            result.output ||
              t("settings.host.ompPlugins.marketplace.feedback.removeFailed", { id: name }),
          );
        }
      }),
    [client, cwd, removeMarketplaceFromState, runOperation, t],
  );

  const handleMarketplaceRefresh = useCallback(
    (name: string) =>
      void runOperation("marketplace", async () => {
        if (!client) return;
        const result = await client.updateOmpPluginMarketplace(name, cwd);
        if (!active.current) return;
        if (!result.ok) {
          setLoadError(
            result.output ||
              t("settings.host.ompPlugins.marketplace.feedback.refreshFailed", { id: name }),
          );
          return;
        }
        const refreshed = await client.listOmpPluginMarketplaces(cwd);
        if (!active.current) return;
        setMarketplaces(refreshed.marketplaces);
        setNotice("catalogRefreshed");
      }),
    [client, cwd, runOperation, t],
  );

  const handleMarketplaceInstall = useCallback(
    async (plugin: OmpMarketplaceCatalogEntry, marketplaceName: string) => {
      if (!client || (scope === "project" && !cwd)) return;
      const key = `${plugin.name}@${marketplaceName}`;
      const { installed, updateAvailable } = getMarketplacePluginState(
        plugin,
        marketplaceName,
        plugins,
        scope,
      );
      if (installed && !updateAvailable) return;
      await runOperation(key, async () => {
        const result = installed
          ? await client.upgradeOmpPlugin(key, scope, cwd)
          : await client.installOmpPlugin({ spec: key, scope, cwd });
        if (!active.current) return;
        if (result.ok) {
          setNotice("applied");
          await load();
        } else {
          setLoadError(
            result.output ||
              t(
                installed
                  ? "settings.host.ompPlugins.feedback.upgradeFailed"
                  : "settings.host.ompPlugins.feedback.installFailed",
                { id: key },
              ),
          );
        }
      });
    },
    [client, cwd, scope, plugins, load, runOperation, t],
  );

  const handleMarketplaceToggle = useCallback((name: string) => {
    setExpandedMarketplace((prev) => (prev === name ? null : name));
  }, []);

  const onMarketplaceRemove = useCallback(
    (name: string) => void handleMarketplaceRemove(name),
    [handleMarketplaceRemove],
  );
  const onMarketplaceInstall = useCallback(
    (plugin: OmpMarketplaceCatalogEntry, marketplaceName: string) =>
      void handleMarketplaceInstall(plugin, marketplaceName),
    [handleMarketplaceInstall],
  );
  const onMarketplaceAdd = useCallback(() => void handleMarketplaceAdd(), [handleMarketplaceAdd]);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  const handleInstallPress = useCallback(() => {
    void handleInstall();
  }, [handleInstall]);

  const handleDoctorPress = useCallback(() => {
    void handleDoctor(false);
  }, [handleDoctor]);

  const handleDoctorFixPress = useCallback(() => {
    void handleDoctor(true);
  }, [handleDoctor]);

  const errorAction = useMemo(
    () => ({ label: t("settings.host.ompPlugins.states.retry"), onPress: handleRetry }),
    [handleRetry, t],
  );

  let body: ReactNode;
  if (pageState === "offline") {
    body = (
      <SettingsSection title={t("settings.host.ompPlugins.title")}>
        <View style={settingsStyles.card} testID="omp-plugins-offline">
          <View style={[settingsStyles.row, styles.centeredRow]}>
            <View style={styles.centeredContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.host.ompPlugins.states.offlineTitle")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.host.ompPlugins.states.offlineDescription")}
              </Text>
            </View>
          </View>
        </View>
      </SettingsSection>
    );
  } else if (pageState === "loading") {
    body = (
      <SettingsSection title={t("settings.host.ompPlugins.title")}>
        <View style={settingsStyles.card} testID="omp-plugins-loading">
          <View style={[settingsStyles.row, styles.centeredRow]}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.ompPlugins.states.loading")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  } else if (pageState === "error") {
    body = (
      <SettingsSection title={t("settings.host.ompPlugins.title")}>
        <View style={settingsStyles.card} testID="omp-plugins-error">
          <View style={[settingsStyles.row, styles.centeredRow]}>
            <View style={styles.centeredContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.host.ompPlugins.states.errorTitle")}
              </Text>
              {loadError ? (
                <Text style={settingsStyles.rowError} numberOfLines={4}>
                  {loadError}
                </Text>
              ) : null}
            </View>
            <Button size="sm" onPress={errorAction.onPress}>
              {errorAction.label}
            </Button>
          </View>
        </View>
      </SettingsSection>
    );
  } else {
    body = (
      <>
        {view === "installed" ? <>
        <SettingsSection title={t("settings.host.ompPlugins.listTitle")}>
          <View style={settingsStyles.card} testID="omp-plugins-list-card">
            {pageState === "empty" ? (
              <View style={[settingsStyles.row, styles.centeredRow]}>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.states.empty")}
                </Text>
              </View>
            ) : (
              filteredPlugins.map((plugin) => {
                const rowId = getPluginRowId(plugin);
                return (
                  <OmpPluginRow
                    key={rowId}
                    plugin={plugin}
                    busy={operation === rowId}
                    disabled={controlsDisabled || (plugin.scope === "project" && !cwd)}
                    onToggle={handleToggle}
                    onRemove={handleRemove}
                    onConfigure={setDetails}
                    onUpgrade={handleUpgrade}
                    removeLabel={t("settings.host.ompPlugins.actions.remove")}
                    toggleLabel={t("settings.host.ompPlugins.toggleLabel", { id: plugin.name })}
                  />
                );
              })
            )}
            {rawOutput ? (
              <View style={[styles.outputBlock, styles.outputBlockFirst]}>
                <Text style={styles.outputText}>{rawOutput}</Text>
              </View>
            ) : null}
          </View>
        </SettingsSection>
        {details && client ? <SettingsSection title={getPluginOperationId(details)}>
          <View style={settingsStyles.card}><View style={settingsStyles.row}>
            <NativePluginDetails client={client} name={getPluginOperationId(details)} scope={details.scope} cwd={cwd} onChanged={() => { void load(); }} />
          </View></View>
        </SettingsSection> : null}
        </> : null}

        {view === "discover" ? <>
        <SettingsSection title={t("settings.host.ompPlugins.installTitle")}>
          <View style={settingsStyles.card} testID="omp-plugins-install-card">
            <View style={[settingsStyles.row, styles.installRow]}>
              <Field
                label={t("settings.host.ompPlugins.installSpecLabel")}
                testID="omp-plugins-install-field"
              >
                <FieldControlRow
                  initialValue={installSpec}
                  onChangeText={setInstallSpec}
                  onSubmitEditing={handleInstallPress}
                  placeholder={t("settings.host.ompPlugins.installPlaceholder")}
                  editable={!controlsDisabled}
                  buttonLabel={
                    installDryRun
                      ? t("settings.host.ompPlugins.actions.check")
                      : t("settings.host.ompPlugins.actions.install")
                  }
                  buttonLoading={operation === "install"}
                  buttonDisabled={controlsDisabled || !installSpec.trim()}
                  buttonTestID="omp-plugins-install-button"
                  inputTestID="omp-plugins-install-input"
                  onPress={handleInstallPress}
                />
              </Field>
              <View style={styles.dryRunRow}>
                <Switch
                  disabled={controlsDisabled}
                  value={installDryRun}
                  onValueChange={setInstallDryRun}
                  accessibilityLabel={t("settings.host.ompPlugins.dryRunLabel")}
                  testID="omp-plugins-install-dry-run"
                />
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.dryRunLabel")}
                </Text>
              </View>
              {installOutput ? (
                <View style={styles.outputBlock}>
                  <Text style={styles.outputText}>{installOutput}</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.browseLinkRow}>
              <Text style={settingsStyles.rowHint}>
                {t("settings.host.ompPlugins.manualScopeHint")}
              </Text>
            </View>
          </View>
        </SettingsSection>

        <SettingsSection title={t("settings.host.ompPlugins.marketplace.title")}>
          <View style={settingsStyles.card} testID="omp-plugins-marketplace-card">
            {marketplaces.map((marketplace) => (
              <MarketplaceEntryCard
                key={marketplace.name}
                marketplace={marketplace}
                expanded={expandedMarketplace === marketplace.name}
                busy={operation === "marketplace"}
                busyCatalogName={operation}
                disabled={controlsDisabled}
                scope={scope}
                onRefresh={handleMarketplaceRefresh}
                hideLabel={t("settings.host.ompPlugins.marketplace.actions.hide")}
                browseLabel={t("settings.host.ompPlugins.marketplace.actions.browse", {
                  count: marketplace.plugins?.length ?? 0,
                })}
                removeLabel={t("settings.host.ompPlugins.actions.remove")}
                installLabel={t("settings.host.ompPlugins.actions.install")}
                installedPlugins={plugins}
                upgradeLabel={t("settings.host.ompPlugins.actions.upgrade")}
                installedLabel={t("settings.host.ompPlugins.actions.installed")}
                searchPlaceholder={t("settings.host.ompPlugins.marketplace.searchPlaceholder")}
                searchClearLabel={t("settings.host.ompPlugins.marketplace.searchClear")}
                onToggle={handleMarketplaceToggle}
                onRemove={onMarketplaceRemove}
                onInstall={onMarketplaceInstall}
              />
            ))}
            <View style={[settingsStyles.row, styles.installRow]}>
              <Field
                label={t("settings.host.ompPlugins.marketplace.addLabel")}
                testID="omp-plugins-marketplace-field"
              >
                <FieldControlRow
                  initialValue={mktSource}
                  onChangeText={setMktSource}
                  onSubmitEditing={onMarketplaceAdd}
                  placeholder={t("settings.host.ompPlugins.marketplace.addPlaceholder")}
                  editable={!controlsDisabled}
                  buttonLabel={t("settings.host.ompPlugins.marketplace.actions.add")}
                  buttonLoading={operation === "marketplace"}
                  buttonDisabled={controlsDisabled || !mktSource.trim()}
                  buttonTestID="omp-plugins-marketplace-add-button"
                  inputTestID="omp-plugins-marketplace-input"
                  onPress={onMarketplaceAdd}
                />
              </Field>
            </View>
          </View>
        </SettingsSection>
        </> : null}

        <SettingsSection title={t("settings.host.ompPlugins.doctorTitle")}>
          <View style={settingsStyles.card} testID="omp-plugins-doctor-card">
            <View style={[settingsStyles.row, styles.doctorActionsRow]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.host.ompPlugins.doctorTitle")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.doctorHint")}
                  <Text style={settingsStyles.rowHint}>{t("plugins.doctorEffect", { defaultValue: "此操作会执行插件 factory，并可能持久化禁用失败插件。" })}</Text>
                </Text>
              </View>
              <View style={styles.doctorButtons}>
                <Button
                  size="sm"
                  onPress={handleDoctorPress}
                  loading={operation === "doctor"}
                  disabled={controlsDisabled}
                  testID="omp-plugins-doctor-run"
                >
                  {t("settings.host.ompPlugins.actions.doctor")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleDoctorFixPress}
                  loading={operation === "doctor"}
                  disabled={controlsDisabled}
                  testID="omp-plugins-doctor-fix"
                >
                  {t("settings.host.ompPlugins.actions.doctorFix")}
                </Button>
              </View>
            </View>
            {doctorChecks?.map((check) => (
              <View key={check.name} style={styles.checkRowBorder}>
                <DoctorCheckRow check={check} />
              </View>
            ))}
          </View>
        </SettingsSection>

        {loadError ? (
          <View style={settingsStyles.card} testID="omp-plugins-action-error">
            <View style={[settingsStyles.row, styles.centeredRow]}>
              <Text style={settingsStyles.rowError} numberOfLines={4}>
                {loadError}
              </Text>
            </View>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.container}>
      {view === "discover" ? <SettingsSection title={t("settings.host.ompPlugins.scope.title")}>
        <View style={settingsStyles.card}>
          <View style={[settingsStyles.row, styles.installRow]}>
            <View style={styles.pluginActions}>
              <Button
                size="sm"
                variant={scope === "user" ? "default" : "outline"}
                disabled={controlsDisabled}
                onPress={selectUserScope}
                testID="omp-plugins-scope-user"
              >
                {t("settings.host.ompPlugins.scope.user")}
              </Button>
              <Button
                size="sm"
                variant={scope === "project" ? "default" : "outline"}
                disabled={controlsDisabled || !cwd}
                onPress={selectProjectScope}
                testID="omp-plugins-scope-project"
              >
                {t("settings.host.ompPlugins.scope.project")}
              </Button>
            </View>
            <Text style={settingsStyles.rowHint}>{t("settings.host.ompPlugins.scope.hint")}</Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.ompPlugins.marketplace.refreshHint")}
            </Text>
          </View>
        </View>
      </SettingsSection> : null}
      {notice ? (
        <View style={settingsStyles.card} testID={`omp-plugins-notice-${notice}`}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              {t(`settings.host.ompPlugins.notices.${notice}`)}
            </Text>
          </View>
        </View>
      ) : null}
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  marketplaceEntry: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  catalogSearchRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: 0,
  },
  browseLinkRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  centeredRow: {
    paddingVertical: theme.spacing[4],
    justifyContent: "center",
  },
  centeredContent: {
    flex: 1,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  pluginRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  pluginActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  pluginPath: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    marginTop: theme.spacing[1],
  },
  installRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  installControlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  installInput: {
    flex: 1,
    minWidth: 0,
  },
  dryRunRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  doctorActionsRow: {
    alignItems: "center",
  },
  doctorButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    flex: 1,
  },
  checkRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  checkBadge: {
    flexShrink: 0,
    maxWidth: 180,
  },
  outputBlock: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  outputBlockFirst: {
    borderTopWidth: 0,
  },
  outputText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    fontFamily: theme.fontFamily.mono,
  },
}));
