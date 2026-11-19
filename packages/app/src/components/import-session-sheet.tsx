import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@omp-desktop/client/internal/daemon-client";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import { ChevronDown, Folder, Inbox, Layers, RotateCw } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { getProviderIcon } from "@/components/provider-icons";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatAgo } from "@/provider-usage/format";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { i18n } from "@/i18n/i18next";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectErroredProviderLabels,
  computeEmptyState,
  filterImportSessions,
  prepareImportSession,
  resolveProvidersToFetch,
  requiresImportSessionsHostUpgrade,
  sumFilteredAlreadyImportedCount,
  type PreparedImportSession,
  type SessionsQueryResult,
} from "@/components/import-session-sheet-view-model";

const IMPORT_SHEET_SNAP_POINTS = ["70%", "92%"];
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };

const rowKey = ({ entry }: PreparedImportSession) =>
  `${entry.providerId}:${entry.providerHandleId}`;

// useQueries returns a new array on every render. Combine the fields the sheet
// observes so typing doesn't repeatedly sort the same entries and parse their previews.
function sessionQueryStates(queries: ReadonlyArray<SessionsQueryResult & { isFetching: boolean }>) {
  return queries.map(({ data, isError, isLoading, isPending, isFetching }) => ({
    data,
    isError,
    isLoading,
    isPending,
    isFetching,
  }));
}

type RecentProviderSessionsClient = Pick<
  DaemonClient,
  "fetchRecentProviderSessions" | "importAgent"
>;

type ImportedAgent = Awaited<ReturnType<RecentProviderSessionsClient["importAgent"]>>;

interface ImportSessionSheetProps {
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  serverId: string | null;
  cwd?: string | null;
  workspaceId?: string | null;
  onClose: () => void;
  onImportedAgent?: (agentId: string) => void;
  onImported?: (agent: ImportedAgent) => void;
}

type RecentSessionsResponse = Awaited<
  ReturnType<RecentProviderSessionsClient["fetchRecentProviderSessions"]>
>;

interface SessionsQueryConfig {
  queryKey: ReadonlyArray<string | null>;
  enabled: boolean;
  queryFn: () => Promise<RecentSessionsResponse>;
}

function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  sessionsQueryRoot: ReadonlyArray<string | null>;
  visible: boolean;
  client: RecentProviderSessionsClient | null;
  cwd: string | null | undefined;
  hostDisconnectedMessage?: string;
}): SessionsQueryConfig[] {
  const { providersToFetch, sessionsQueryRoot, visible, client, cwd, hostDisconnectedMessage } =
    args;
  if (providersToFetch === null) return [];
  const enabled = visible && Boolean(client);
  return providersToFetch.map((provider) => ({
    queryKey: [...sessionsQueryRoot, provider],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error(hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
      }
      return await client.fetchRecentProviderSessions({
        ...(cwd ? { cwd } : {}),
        providers: [provider],
        limit: null,
      });
    },
  }));
}

interface SheetStatusMessagesProps {
  isClientReady: boolean;
  isSnapshotUnsupported: boolean;
  hasNoImportableProviders: boolean;
  isLoadingSessions: boolean;
  hasRows: boolean;
  allQueriesErrored: boolean;
  erroredProviderLabels: ReadonlyArray<string>;
  importErrored: boolean;
}

function SheetStatusMessages({
  isClientReady,
  isSnapshotUnsupported,
  hasNoImportableProviders,
  isLoadingSessions,
  hasRows,
  allQueriesErrored,
  erroredProviderLabels,
  importErrored,
}: SheetStatusMessagesProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  if (!isClientReady) {
    return <Text style={styles.statusText}>{t("importSession.status.connectHost")}</Text>;
  }
  if (isSnapshotUnsupported) {
    return <Text style={styles.statusText}>{t("importSession.status.updateHost")}</Text>;
  }
  return (
    <>
      {hasNoImportableProviders ? (
        <Text style={styles.statusText}>{t("importSession.status.noProviders")}</Text>
      ) : null}
      {isLoadingSessions && !hasRows ? (
        <View style={styles.statusRow}>
          <LoadingSpinner color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>{t("importSession.status.loading")}</Text>
        </View>
      ) : null}
      {allQueriesErrored ? (
        <Text style={styles.statusText}>{t("importSession.status.failedAll")}</Text>
      ) : null}
      {!allQueriesErrored && erroredProviderLabels.length > 0 ? (
        <Text style={styles.statusText}>
          {t("importSession.status.failedProviders", {
            providers: erroredProviderLabels.join(", "),
          })}
        </Text>
      ) : null}
      {importErrored ? (
        <Text style={styles.statusText}>{t("importSession.status.failedImport")}</Text>
      ) : null}
    </>
  );
}

function RefreshAction({ isRefreshing, onPress }: { isRefreshing: boolean; onPress: () => void }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.refreshButton,
      pressed && styles.refreshButtonPressed,
    ],
    [],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={isRefreshing}
      accessibilityLabel={t("importSession.actions.refresh")}
      accessibilityRole="button"
      testID="import-session-refresh"
      style={pressableStyle}
    >
      <View style={styles.refreshIconSlot}>
        {isRefreshing ? (
          <LoadingSpinner color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={16} color={theme.colors.foregroundMuted} />
        )}
      </View>
    </Pressable>
  );
}

function SheetEmptyState({ title }: { title: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.emptyState} testID="import-session-empty-state">
      <View style={styles.emptyStateIcon}>
        <Inbox size={theme.iconSize.lg} color={theme.colors.foregroundMuted} strokeWidth={1.5} />
      </View>
      <Text style={styles.emptyStateTitle}>{title}</Text>
    </View>
  );
}

function ImportSessionSheetRow({
  row: { entry, title, preview, project },
  disabled,
  importing,
  showProject,
  onImportSession,
}: {
  row: PreparedImportSession;
  disabled: boolean;
  importing: boolean;
  showProject: boolean;
  onImportSession: (entry: FetchRecentProviderSessionEntry) => void;
}) {
  const { theme } = useUnistyles();
  const { t, i18n } = useTranslation();
  const activity = new Date(entry.lastActivityAt);
  const now = new Date();
  const lastActivity =
    now.getTime() - activity.getTime() < 7 * 86_400_000
      ? formatAgo(entry.lastActivityAt, t)
      : activity.toLocaleDateString(i18n.resolvedLanguage ?? i18n.language, {
          month: "short",
          day: "numeric",
          year: now.getFullYear() === activity.getFullYear() ? undefined : "numeric",
        });
  const ProviderIcon = getProviderIcon(entry.providerId);
  const accessibilityState = useMemo(
    () => (disabled ? DISABLED_ACCESSIBILITY_STATE : undefined),
    [disabled],
  );
  const handlePress = useCallback(() => {
    onImportSession(entry);
  }, [entry, onImportSession]);
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={pressableStyle}
      testID={`import-session-session-${entry.providerId}-${entry.providerHandleId}`}
    >
      <View style={styles.rowIconWrap}>
        <ProviderIcon size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {importing ? t("importSession.row.importing") : lastActivity}
          </Text>
        </View>
        {preview ? (
          <Text style={styles.rowPreview} numberOfLines={1}>
            {preview}
          </Text>
        ) : null}
        {showProject && project ? (
          <View style={styles.rowProject}>
            <Folder size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.projectName} numberOfLines={1}>
              {project}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export function ImportSessionSheet({
  visible,
  client,
  serverId,
  cwd,
  workspaceId,
  onClose,
  onImportedAgent,
  onImported,
}: ImportSessionSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();

  const { entries: snapshotEntries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    enabled: visible,
  });
  const supportsWorkspaceTarget = useHostFeature(serverId, "importSessionWorkspaceTarget");
  const requiresHostUpgrade = requiresImportSessionsHostUpgrade({
    supportsSnapshot,
    workspaceId,
    supportsWorkspaceTarget,
  });

  const providersToFetch = useMemo(
    () => (requiresHostUpgrade ? null : resolveProvidersToFetch(supportsSnapshot, snapshotEntries)),
    [requiresHostUpgrade, supportsSnapshot, snapshotEntries],
  );

  const providerLabelById = useMemo(
    () => buildProviderLabelMap(snapshotEntries),
    [snapshotEntries],
  );

  const sessionsQueryRoot = useMemo(
    () => ["recent-provider-sessions", serverId, cwd ?? null] as const,
    [serverId, cwd],
  );

  const queriesConfig = useMemo(
    () =>
      buildSessionsQueriesConfig({
        providersToFetch,
        sessionsQueryRoot,
        visible,
        client,
        cwd,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [providersToFetch, sessionsQueryRoot, visible, client, cwd, t],
  );

  const queries = useQueries({ queries: queriesConfig, combine: sessionQueryStates });

  const rows = useMemo(
    () =>
      aggregateSessionEntries(queries).map((entry) =>
        prepareImportSession(entry, providerLabelById.get(entry.providerId) ?? entry.providerLabel),
      ),
    [queries, providerLabelById, i18n.language],
  );
  const totalAlreadyImportedCount = useMemo(
    () => sumFilteredAlreadyImportedCount(queries),
    [queries],
  );

  const filterProviders = useMemo(() => [...(providersToFetch ?? [])].sort(), [providersToFetch]);

  const [selectedProvider, setSelectedProvider] = useState<string>(ALL_FILTER_VALUE);
  const [query, setQuery] = useState("");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setIsFilterOpen(false);
    }
  }, [visible]);

  useEffect(() => {
    if (
      !visible ||
      (selectedProvider !== ALL_FILTER_VALUE && !filterProviders.includes(selectedProvider))
    ) {
      setSelectedProvider(ALL_FILTER_VALUE);
    }
  }, [visible, filterProviders, selectedProvider]);

  const visibleRows = useMemo(
    () => filterImportSessions(rows, selectedProvider, query),
    [rows, selectedProvider, query],
  );

  const filterComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { id: ALL_FILTER_VALUE, label: t("importSession.filters.all") },
      ...filterProviders.map((provider) => ({
        id: provider,
        label: providerLabelById.get(provider) ?? provider,
      })),
    ],
    [filterProviders, providerLabelById, t],
  );

  const selectedProviderLabel = useMemo(
    () =>
      filterComboboxOptions.find((opt) => opt.id === selectedProvider)?.label ??
      t("importSession.filters.all"),
    [filterComboboxOptions, selectedProvider, t],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const filterTriggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.filterTrigger,
      Boolean(hovered) && styles.filterTriggerHovered,
      pressed && styles.filterTriggerPressed,
    ],
    [],
  );

  const handleFilterSelect = useCallback((id: string) => {
    setSelectedProvider(id);
    setIsFilterOpen(false);
  }, []);

  const filterOptionIcons = useMemo(() => {
    const map = new Map<string, React.ReactNode>();
    map.set(ALL_FILTER_VALUE, <Layers size={14} color={theme.colors.foregroundMuted} />);
    for (const provider of filterProviders) {
      const ProviderIcon = getProviderIcon(provider);
      map.set(provider, <ProviderIcon size={14} color={theme.colors.foregroundMuted} />);
    }
    return map;
  }, [filterProviders, theme.colors.foregroundMuted]);

  const renderFilterOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={filterOptionIcons.get(option.id)}
      />
    ),
    [filterOptionIcons],
  );

  const importMutation = useMutation({
    mutationFn: async (entry: FetchRecentProviderSessionEntry) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (!entry.cwd) {
        throw new Error("Session is missing a working directory");
      }
      const agent = await client.importAgent({
        providerId: entry.providerId,
        providerHandleId: entry.providerHandleId,
        cwd: entry.cwd,
        ...(workspaceId ? { workspaceId } : {}),
      });
      return agent;
    },
    onSuccess: async (agent) => {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
      onClose();
      onImportedAgent?.(agent.id);
      onImported?.(agent);
    },
  });

  const importingSessionKey =
    importMutation.isPending && importMutation.variables
      ? `${importMutation.variables.providerId}:${importMutation.variables.providerHandleId}`
      : null;

  const handleImportSession = importMutation.mutate;

  const erroredProviderLabels = useMemo(
    () => collectErroredProviderLabels(providersToFetch, queries, providerLabelById),
    [queries, providersToFetch, providerLabelById],
  );

  const isRefreshing = queries.some((query) => query.isFetching);

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sessionsQueryRoot });
  }, [queryClient, sessionsQueryRoot]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("importSession.title"),
      actions: <RefreshAction isRefreshing={isRefreshing} onPress={handleRefresh} />,
    }),
    [isRefreshing, handleRefresh, t],
  );

  const isSnapshotUnsupported = requiresHostUpgrade;
  const isWaitingForSnapshot = supportsSnapshot && snapshotEntries === undefined;
  const hasNoImportableProviders = providersToFetch !== null && providersToFetch.length === 0;
  const isQueryingProviders = queries.length > 0;
  const isLoadingSessions =
    isWaitingForSnapshot ||
    (isQueryingProviders && queries.some((query) => query.isLoading || query.isPending));
  const allQueriesErrored = isQueryingProviders && queries.every((query) => query.isError);
  const allQueriesSettled =
    isQueryingProviders && queries.every((query) => !query.isLoading && !query.isPending);
  const { showEmptyState, emptyStateTitle } = computeEmptyState({
    isLoadingSessions,
    allQueriesErrored,
    isQueryingProviders,
    allQueriesSettled,
    selectedProvider,
    aggregatedCount: rows.length,
    visibleCount: visibleRows.length,
    totalAlreadyImportedCount,
    providerLabelById,
  });
  const showFilter = filterProviders.length > 1;
  const noMatches =
    visibleRows.length === 0 &&
    query.trim().length > 0 &&
    (selectedProvider === ALL_FILTER_VALUE
      ? rows.length > 0
      : rows.some(({ entry }) => entry.providerId === selectedProvider));
  const filterHasError =
    selectedProvider === ALL_FILTER_VALUE
      ? erroredProviderLabels.length > 0
      : queries[providersToFetch?.indexOf(selectedProvider) ?? -1]?.isError;
  const renderRow = useCallback(
    ({ item }: { item: PreparedImportSession }) => (
      <ImportSessionSheetRow
        row={item}
        disabled={importMutation.isPending}
        importing={importingSessionKey === rowKey(item)}
        showProject={!cwd}
        onImportSession={handleImportSession}
      />
    ),
    [cwd, handleImportSession, importMutation.isPending, importingSessionKey],
  );
  const listProps = {
    data: visibleRows,
    keyExtractor: rowKey,
    renderItem: renderRow,
    keyboardShouldPersistTaps: "handled" as const,
    style: styles.list,
  };

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="import-session-sheet"
      desktopMaxWidth={600}
      scrollable={false}
      sizeContentToCurrentSnapPoint
      contentStyle={[styles.body, !isCompact && rows.length > 5 && styles.desktopResultsBody]}
      snapPoints={IMPORT_SHEET_SNAP_POINTS}
    >
      {client && filterProviders.length > 0 ? (
        <View style={styles.filterRail}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("importSession.searchPlaceholder")}
            clearAccessibilityLabel={t("sessions.actions.clearSearch")}
            testID="import-session-search-input"
            clearTestID="import-session-search-clear"
          />
          {showFilter ? (
            <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
              <Pressable
                onPress={handleFilterOpen}
                style={filterTriggerStyle}
                testID="import-session-filter-trigger"
                accessibilityRole="button"
                accessibilityLabel={`${t("importSession.filterProvider")}: ${selectedProviderLabel}`}
                accessibilityState={{ expanded: isFilterOpen }}
              >
                {filterOptionIcons.get(selectedProvider)}
                <Text style={styles.filterTriggerText} numberOfLines={1}>
                  {selectedProviderLabel}
                </Text>
                <ChevronDown size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Combobox
                options={filterComboboxOptions}
                value={selectedProvider}
                onSelect={handleFilterSelect}
                renderOption={renderFilterOption}
                searchable={false}
                title={t("importSession.filterProvider")}
                open={isFilterOpen}
                onOpenChange={setIsFilterOpen}
                anchorRef={filterAnchorRef}
                desktopPlacement="bottom-start"
                desktopPreventInitialFlash
              />
            </View>
          ) : null}
        </View>
      ) : null}
      <SheetStatusMessages
        isClientReady={Boolean(client)}
        isSnapshotUnsupported={isSnapshotUnsupported}
        hasNoImportableProviders={hasNoImportableProviders}
        isLoadingSessions={isLoadingSessions}
        hasRows={visibleRows.length > 0}
        allQueriesErrored={allQueriesErrored}
        erroredProviderLabels={erroredProviderLabels}
        importErrored={importMutation.isError}
      />
      {visibleRows.length > 0 ? (
        isCompact ? (
          <BottomSheetFlatList {...listProps} />
        ) : (
          <FlatList {...listProps} />
        )
      ) : null}
      {showEmptyState && !filterHasError ? (
        <SheetEmptyState title={noMatches ? t("importSession.noMatches") : emptyStateTitle} />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
  },
  desktopResultsBody: {
    height: 472,
  },
  filterRail: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  filterTriggerWrap: {
    maxWidth: "42%",
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 34,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  filterTriggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  filterTriggerText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  list: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowIconWrap: {
    width: theme.iconSize.md,
    paddingTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  rowProject: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  projectName: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  emptyStateIcon: {
    opacity: 0.6,
    marginBottom: theme.spacing[1],
  },
  emptyStateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  refreshButton: {
    padding: theme.spacing[2],
    marginRight: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  refreshButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIconSlot: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
}));
