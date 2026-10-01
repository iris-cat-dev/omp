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

interface OmpPluginsPageProps {
  serverId: string;
}

interface PluginRowProps {
  plugin: OmpPluginInfo;
  busy: boolean;
  onToggle: (plugin: OmpPluginInfo, enabled: boolean) => void;
  onRemove: (plugin: OmpPluginInfo) => void;
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
  onInstall,
  installLabel,
  installedPlugins,
  upgradeLabel,
  installedLabel,
}: MarketplaceCatalogRowProps) {
  const { installed, updateAvailable } = getMarketplacePluginState(
    plugin,
    marketplaceName,
    installedPlugins,
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
      </View>
      <View style={styles.pluginActions}>
        <Button
          size="sm"
          loading={busy}
          disabled={!!installed && !updateAvailable}
          onPress={handleInstall}
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
          <Button variant="destructive" size="sm" loading={busy} onPress={handleRemove}>
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
  onToggle,
  onRemove,
  removeLabel,
  toggleLabel,
}: PluginRowProps) {
  const handleToggle = useCallback((value: boolean) => onToggle(plugin, value), [onToggle, plugin]);
  const handleRemove = useCallback(() => onRemove(plugin), [onRemove, plugin]);
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
        {plugin.path ? (
          <Text style={styles.pluginPath} numberOfLines={1}>
            {plugin.path}
          </Text>
        ) : null}
      </View>
      <View style={styles.pluginActions}>
        <Switch
          accessibilityLabel={toggleLabel}
          value={plugin.enabled === true}
          onValueChange={handleToggle}
        />
        <Button variant="destructive" size="sm" loading={busy} onPress={handleRemove}>
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

/**
 * Management page for the OMP runtime's own plugin ecosystem (`omp plugin`).
 * Distinct from the daemon plugin runtime page (`plugins` slug): this talks to
 * the OMP CLI through the ompPlugins.* RPC family.
 */
export function OmpPluginsPage({ serverId }: OmpPluginsPageProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);

  const [plugins, setPlugins] = useState<OmpPluginInfo[]>([]);
  const [pageState, setPageState] = useState<PluginPageState>("loading");
  const [rawOutput, setRawOutput] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  const [installSpec, setInstallSpec] = useState("");
  const [installDryRun, setInstallDryRun] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [doctorChecks, setDoctorChecks] = useState<OmpPluginDoctorCheck[] | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [marketplaces, setMarketplaces] = useState<OmpPluginMarketplaceInfo[]>([]);
  const [expandedMarketplace, setExpandedMarketplace] = useState<string | null>(null);
  const [mktSource, setMktSource] = useState("");
  const [mktBusy, setMktBusy] = useState(false);
  const [busyCatalog, setBusyCatalog] = useState<string | null>(null);

  // The daemon serializes ompPlugins.* RPCs (one operation at a time); a
  // concurrent second call throws OmpPluginOperationInProgressError. Share a
  // single in-flight load so overlapping callers await the same request.
  const loadRef = useRef<Promise<void> | null>(null);
  const load = useCallback(async () => {
    if (!client) {
      setPageState("offline");
      return;
    }
    if (loadRef.current) {
      await loadRef.current;
      return;
    }
    const run = (async () => {
      setPageState("loading");
      setLoadError(null);
      try {
        const pluginResult = await client.listOmpPlugins();
        const marketplaceResult = await client.listOmpPluginMarketplaces().catch(() => null);
        setPlugins(pluginResult.plugins);
        setRawOutput(pluginResult.rawOutput ?? null);
        setPageState(pluginResult.plugins.length === 0 ? "empty" : "ready");
        if (marketplaceResult) {
          setMarketplaces(marketplaceResult.marketplaces);
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
        setPageState("error");
      } finally {
        loadRef.current = null;
      }
    })();
    loadRef.current = run;
    await run;
  }, [client]);

  useEffect(() => {
    if (!connected) {
      setPageState("offline");
      return;
    }
    void load();
  }, [connected, load]);

  const handleToggle = useCallback(
    async (plugin: OmpPluginInfo, enabled: boolean) => {
      if (!client) return;
      const rowId = getPluginRowId(plugin);
      setBusyPlugin(rowId);
      try {
        const result = await client.setOmpPluginEnabled(
          getPluginOperationId(plugin),
          enabled,
          plugin.scope,
        );
        if (result.ok) {
          setPlugins((prev) =>
            prev.map((entry) => (getPluginRowId(entry) === rowId ? { ...entry, enabled } : entry)),
          );
        } else {
          setLoadError(t("settings.host.ompPlugins.feedback.toggleFailed", { id: plugin.name }));
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyPlugin(null);
      }
    },
    [client, t],
  );

  const handleRemove = useCallback(
    async (plugin: OmpPluginInfo) => {
      if (!client) return;
      const rowId = getPluginRowId(plugin);
      setBusyPlugin(rowId);
      try {
        const result = await client.removeOmpPlugin(getPluginOperationId(plugin), plugin.scope);
        if (result.ok) {
          setPlugins((prev) => prev.filter((entry) => getPluginRowId(entry) !== rowId));
        } else {
          setLoadError(
            result.output ??
              t("settings.host.ompPlugins.feedback.removeFailed", { id: plugin.name }),
          );
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyPlugin(null);
      }
    },
    [client, t],
  );

  const handleInstall = useCallback(async () => {
    if (!client || !installSpec.trim()) return;
    setInstalling(true);
    setInstallOutput(null);
    try {
      const result = await client.installOmpPlugin({
        spec: installSpec.trim(),
        dryRun: installDryRun,
      });
      if (result.ok) {
        setInstallSpec("");
        setInstallDryRun(false);
        if (!installDryRun) {
          await load();
        }
      }
      setInstallOutput(result.output ?? null);
    } catch (error) {
      setInstallOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(false);
    }
  }, [client, installSpec, installDryRun, load]);

  const handleDoctor = useCallback(
    async (fix: boolean) => {
      if (!client) return;
      setDoctorRunning(true);
      try {
        const result = await client.runOmpPluginDoctor(fix);
        setDoctorChecks(result.checks.length > 0 ? result.checks : null);
        if (result.rawOutput) setInstallOutput(result.rawOutput);
      } catch (error) {
        setInstallOutput(error instanceof Error ? error.message : String(error));
      } finally {
        setDoctorRunning(false);
      }
    },
    [client],
  );

  const handleMarketplaceAdd = useCallback(async () => {
    if (!client || !mktSource.trim()) return;
    setMktBusy(true);
    setLoadError(null);
    try {
      const result = await client.addOmpPluginMarketplace(mktSource.trim());
      if (result.ok) {
        setMktSource("");
        const refreshed = await client.listOmpPluginMarketplaces();
        setMarketplaces(refreshed.marketplaces);
        if (result.marketplace) {
          setExpandedMarketplace(result.marketplace.name);
        }
      } else {
        setLoadError(result.output ?? t("settings.host.ompPlugins.marketplace.feedback.addFailed"));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setMktBusy(false);
    }
  }, [client, mktSource, t]);

  const handleMarketplaceRemove = useCallback(
    async (name: string) => {
      if (!client) return;
      setMktBusy(true);
      setLoadError(null);
      try {
        const result = await client.removeOmpPluginMarketplace(name);
        if (result.ok) {
          setMarketplaces((prev) => prev.filter((entry) => entry.name !== name));
          setExpandedMarketplace((prev) => (prev === name ? null : prev));
        } else {
          setLoadError(
            result.output ??
              t("settings.host.ompPlugins.marketplace.feedback.removeFailed", { id: name }),
          );
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setMktBusy(false);
      }
    },
    [client, t],
  );

  const handleMarketplaceInstall = useCallback(
    async (plugin: OmpMarketplaceCatalogEntry, marketplaceName: string) => {
      if (!client) return;
      const key = `${plugin.name}@${marketplaceName}`;
      const { installed, updateAvailable } = getMarketplacePluginState(
        plugin,
        marketplaceName,
        plugins,
      );
      if (installed && !updateAvailable) return;
      setBusyCatalog(key);
      setLoadError(null);
      try {
        const result = installed
          ? await client.upgradeOmpPlugin(key, installed.scope ?? "user")
          : await client.installOmpPlugin({ spec: key });
        if (result.ok) {
          await load();
        } else {
          setLoadError(
            result.output ??
              t(
                installed
                  ? "settings.host.ompPlugins.feedback.upgradeFailed"
                  : "settings.host.ompPlugins.feedback.installFailed",
                { id: plugin.name },
              ),
          );
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyCatalog(null);
      }
    },
    [client, load, plugins, t],
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
        <SettingsSection title={t("settings.host.ompPlugins.listTitle")}>
          <View style={settingsStyles.card} testID="omp-plugins-list-card">
            {pageState === "empty" ? (
              <View style={[settingsStyles.row, styles.centeredRow]}>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.states.empty")}
                </Text>
              </View>
            ) : (
              plugins.map((plugin) => {
                const rowId = getPluginRowId(plugin);
                return (
                  <OmpPluginRow
                    key={rowId}
                    plugin={plugin}
                    busy={busyPlugin === rowId}
                    onToggle={handleToggle}
                    onRemove={handleRemove}
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
                  editable={!installing}
                  buttonLabel={
                    installDryRun
                      ? t("settings.host.ompPlugins.actions.check")
                      : t("settings.host.ompPlugins.actions.install")
                  }
                  buttonLoading={installing}
                  buttonDisabled={!installSpec.trim()}
                  buttonTestID="omp-plugins-install-button"
                  inputTestID="omp-plugins-install-input"
                  onPress={handleInstallPress}
                />
              </Field>
              <View style={styles.dryRunRow}>
                <Switch
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
              <ExternalLink
                href="https://pi.dev/packages"
                label={t("settings.host.ompPlugins.browsePackages")}
                testID="omp-plugins-browse-packages-link"
              />
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
                busy={mktBusy}
                busyCatalogName={busyCatalog}
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
                  editable={!mktBusy}
                  buttonLabel={t("settings.host.ompPlugins.marketplace.actions.add")}
                  buttonLoading={mktBusy}
                  buttonDisabled={!mktSource.trim()}
                  buttonTestID="omp-plugins-marketplace-add-button"
                  inputTestID="omp-plugins-marketplace-input"
                  onPress={onMarketplaceAdd}
                />
              </Field>
            </View>
          </View>
        </SettingsSection>

        <SettingsSection title={t("settings.host.ompPlugins.doctorTitle")}>
          <View style={settingsStyles.card} testID="omp-plugins-doctor-card">
            <View style={[settingsStyles.row, styles.doctorActionsRow]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.host.ompPlugins.doctorTitle")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.host.ompPlugins.doctorHint")}
                </Text>
              </View>
              <View style={styles.doctorButtons}>
                <Button
                  size="sm"
                  onPress={handleDoctorPress}
                  loading={doctorRunning}
                  testID="omp-plugins-doctor-run"
                >
                  {t("settings.host.ompPlugins.actions.doctor")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleDoctorFixPress}
                  loading={doctorRunning}
                  disabled={doctorRunning}
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

  return <View style={styles.container}>{body}</View>;
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
