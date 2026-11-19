import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  Archive,
  CheckSquare,
  ChevronLeft,
  History,
  Info,
  Search,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList, type HistoryGrouping } from "@/components/agent-list";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SearchField } from "@/components/ui/search-field";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { type AgentHistoryHostError, useAgentHistory } from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useDeleteAgent } from "@/hooks/use-delete-agent";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 200;

const sessionsHostOptionTestID = (serverId: string) => `sessions-host-filter-item-${serverId}`;
function agentSelectionKey(agent: AggregatedAgent): string {
  return `${agent.serverId}:${agent.id}`;
}

/**
 * A host that failed while others answered. Without this the list silently
 * under-reports, and under a query "No sessions match" becomes a claim the app
 * has no basis for.
 */
function SessionHostErrorsBanner({
  errors,
  t,
}: {
  errors: AgentHistoryHostError[];
  t: TFunction;
}): ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={styles.hostNotice} testID="sessions-host-errors">
      <Info size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      <Text style={styles.noticeText}>
        {t("sessions.hostLoadFailed", {
          host: errors.map((error) => error.serverName).join(" · "),
        })}
      </Text>
    </View>
  );
}

/** An empty list means something different once a query is narrowing it. */
function resolveEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
}): string {
  if (input.isSearching) return input.t("sessions.noMatches");
  if (input.isAllHosts) return input.t("sessions.empty");
  return input.t("sessions.emptyHost");
}

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const { group } = useLocalSearchParams<{ group?: string }>();
  const grouping: HistoryGrouping = group === "project" ? "project" : "time";
  const setGrouping = useCallback(
    (value: HistoryGrouping) => router.setParams({ group: value }),
    [],
  );
  const groupingOptions = useMemo<SegmentedControlOption<HistoryGrouping>[]>(
    () => [
      { value: "time", label: t("sessions.byTime"), testID: "sessions-group-time" },
      { value: "project", label: t("sessions.byProject"), testID: "sessions-group-project" },
    ],
    [t],
  );
  const toast = useToast();
  const { archiveAgent } = useArchiveAgent();
  const { deleteAgent } = useDeleteAgent();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentKeys, setSelectedAgentKeys] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<"archive" | "delete" | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS).trim();
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const {
    agents,
    hasMore,
    isInitialLoad,
    isLoadingMore,
    isError,
    hasReachableHosts,
    isSearchSupported,
    isSearchTruncated,
    searchMatchesByAgentKey,
    hostErrors,
    loadMore,
    refreshAll,
  } = useAgentHistory({
    serverId: historyServerId,
    search,
  });
  const isSearching = isSearchSupported && search.length > 0;

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);
  useEffect(() => {
    const availableKeys = new Set(agents.map(agentSelectionKey));
    setSelectedAgentKeys((current) => {
      const next = new Set([...current].filter((key) => availableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [agents]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const emptyText = resolveEmptyText({
    t,
    isSearching,
    isAllHosts: selectedHost === ALL_HOSTS_OPTION_ID,
  });
  const showHostFilter = hosts.length > 1;
  const onlyResultHost = useMemo(() => {
    const first = agents[0];
    if (!showHostFilter || historyServerId || !first) return null;
    return agents.every((agent) => agent.serverId === first.serverId) ? first.serverLabel : null;
  }, [agents, historyServerId, showHostFilter]);
  const showFilterRow = showHostFilter || isSearchSupported;
  const showGrouping = !isSearching && agents.length > 0;
  const noHostReached = !hasReachableHosts && hostErrors.length > 0;
  const showLoadError = agents.length === 0 && (isError || noHostReached);

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const handleClearSearch = useCallback(() => setSearchInput(""), []);
  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedAgentKeys.has(agentSelectionKey(agent))),
    [agents, selectedAgentKeys],
  );
  const beginSelection = useCallback(() => setSelectionMode(true), []);
  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedAgentKeys(new Set());
  }, []);
  const toggleAgentSelection = useCallback((agent: AggregatedAgent) => {
    const key = agentSelectionKey(agent);
    setSelectedAgentKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleSelectAll = useCallback(() => {
    setSelectedAgentKeys((current) =>
      current.size === agents.length ? new Set() : new Set(agents.map(agentSelectionKey)),
    );
  }, [agents]);
  const finishBulkAction = useCallback(
    (failedAgents: AggregatedAgent[]) => {
      if (failedAgents.length === 0) {
        cancelSelection();
        return;
      }
      setSelectedAgentKeys(new Set(failedAgents.map(agentSelectionKey)));
      toast.error(t("sessions.bulk.failed", { count: failedAgents.length }));
    },
    [cancelSelection, t, toast],
  );
  const handleBulkArchive = useCallback(async () => {
    const candidates = selectedAgents.filter((agent) => !agent.archivedAt);
    if (candidates.length === 0 || bulkAction) return;
    const confirmed = await confirmDialog({
      title: t("sessions.bulk.archiveTitle", { count: candidates.length }),
      message: t("sessions.bulk.archiveMessage", { count: candidates.length }),
      confirmLabel: t("sessions.bulk.archive"),
      cancelLabel: t("common.actions.cancel"),
    });
    if (!confirmed) return;
    setBulkAction("archive");
    const results = await Promise.allSettled(
      candidates.map((agent) => archiveAgent({ serverId: agent.serverId, agentId: agent.id })),
    );
    const failed = candidates.filter((_, index) => results[index]?.status === "rejected");
    setBulkAction(null);
    finishBulkAction(failed);
  }, [archiveAgent, bulkAction, finishBulkAction, selectedAgents, t]);
  const handleBulkDelete = useCallback(async () => {
    if (selectedAgents.length === 0 || bulkAction) return;
    const confirmed = await confirmDialog({
      title: t("sessions.bulk.deleteTitle", { count: selectedAgents.length }),
      message: t("sessions.bulk.deleteMessage", { count: selectedAgents.length }),
      confirmLabel: t("sessions.bulk.delete"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBulkAction("delete");
    const results = await Promise.allSettled(
      selectedAgents.map((agent) =>
        deleteAgent({
          serverId: agent.serverId,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
        }),
      ),
    );
    const failed = selectedAgents.filter((_, index) => results[index]?.status === "rejected");
    setBulkAction(null);
    finishBulkAction(failed);
  }, [bulkAction, deleteAgent, finishBulkAction, selectedAgents, t]);

  const listFooterComponent = useMemo(() => {
    // A ranked result set has no next page — reaching a weaker match means
    // narrowing the query, so the footer says that instead of offering a button.
    if (isSearchTruncated) {
      return (
        <View style={styles.footer}>
          <Text style={styles.footerHint}>{t("sessions.tooManyMatches")}</Text>
        </View>
      );
    }
    if (!hasMore) {
      return null;
    }
    return (
      <View style={styles.footer}>
        <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? t("common.states.loading") : t("sessions.actions.loadMore")}
        </Button>
      </View>
    );
  }, [hasMore, isLoadingMore, isSearchTruncated, loadMore, t]);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      <View style={styles.page}>
        <View style={styles.pageHeader}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.pageTitle}>
              {t(isSearching ? "sessions.results" : "sessions.recent")}
            </Text>
            {onlyResultHost ? <Text style={styles.noticeText}>{onlyResultHost}</Text> : null}
          </View>
          {(selectionMode || agents.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={selectionMode ? undefined : CheckSquare}
              disabled={bulkAction !== null}
              onPress={selectionMode ? cancelSelection : beginSelection}
              testID="sessions-selection-toggle"
            >
              {selectionMode ? t("common.actions.cancel") : t("sessions.actions.select")}
            </Button>
          )}
        </View>
        {(showFilterRow || showGrouping) && (
          <View style={styles.filters}>
            {showFilterRow && (
              <View style={styles.filterContainer}>
                {isSearchSupported ? (
                  <SearchField
                    value={searchInput}
                    onChangeText={setSearchInput}
                    placeholder={t("sessions.searchPlaceholder")}
                    clearAccessibilityLabel={t("sessions.actions.clearSearch")}
                    testID="sessions-search-input"
                    clearTestID="sessions-search-clear"
                  />
                ) : null}
                {showHostFilter ? (
                  <HostFilter
                    hosts={hosts}
                    selectedHost={selectedHost}
                    onSelectHost={setSelectedHost}
                    triggerTestID="sessions-host-filter-trigger"
                    hostOptionTestID={sessionsHostOptionTestID}
                  />
                ) : null}
              </View>
            )}
            {showGrouping && (
              <SegmentedControl
                options={groupingOptions}
                value={grouping}
                onValueChange={setGrouping}
                size="sm"
              />
            )}
          </View>
        )}
        {selectionMode ? (
          <View style={styles.bulkToolbar} testID="sessions-bulk-toolbar">
            <Text style={styles.bulkSelectionCount}>
              {t("sessions.bulk.selected", { count: selectedAgentKeys.size })}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={CheckSquare}
              onPress={toggleSelectAll}
              disabled={bulkAction !== null}
              testID="sessions-select-all"
            >
              {selectedAgentKeys.size === agents.length
                ? t("sessions.bulk.clearSelection")
                : t("sessions.bulk.selectAll")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Archive}
              onPress={handleBulkArchive}
              disabled={bulkAction !== null || !selectedAgents.some((agent) => !agent.archivedAt)}
              loading={bulkAction === "archive"}
              testID="sessions-bulk-archive"
            >
              {t("sessions.bulk.archive")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Trash2}
              onPress={handleBulkDelete}
              disabled={bulkAction !== null || selectedAgents.length === 0}
              loading={bulkAction === "delete"}
              testID="sessions-bulk-delete"
            >
              {t("sessions.bulk.delete")}
            </Button>
          </View>
        ) : null}
        {hostErrors.length > 0 && (!noHostReached || agents.length > 0) ? (
          <SessionHostErrorsBanner errors={hostErrors} t={t} />
        ) : null}
        {isInitialLoad ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
          </View>
        ) : null}
        {!isInitialLoad && showLoadError ? (
          <View style={styles.emptyContainer}>
            <History size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
            <Text style={styles.emptyText}>{t("sessions.loadFailed")}</Text>
            {noHostReached ? (
              <Text style={styles.footerHint}>
                {t("sessions.offlineHint", {
                  host: hostErrors.map((host) => host.serverName).join(" · "),
                })}
              </Text>
            ) : (
              <Button variant="secondary" onPress={handleRefresh} disabled={isManualRefresh}>
                {t("common.actions.retry")}
              </Button>
            )}
          </View>
        ) : null}
        {!isInitialLoad && !showLoadError && agents.length === 0 ? (
          <View style={styles.emptyContainer} testID="sessions-empty">
            {isSearching ? (
              <Search size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
            ) : (
              <History size={theme.iconSize.lg} color={theme.colors.foregroundMuted} />
            )}
            <Text style={styles.emptyText}>
              {hostErrors.length ? t("sessions.emptyReachable") : emptyText}
            </Text>
            {isSearching ? (
              <Button variant="ghost" onPress={handleClearSearch}>
                {t("sessions.actions.clearSearch")}
              </Button>
            ) : (
              <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
                {t("common.actions.back")}
              </Button>
            )}
          </View>
        ) : null}
        {!isInitialLoad && !showLoadError && agents.length > 0 ? (
          <AgentList
            agents={agents}
            showCheckoutInfo={false}
            isRefreshing={isManualRefresh}
            onRefresh={handleRefresh}
            listFooterComponent={listFooterComponent}
            showAttentionIndicator={false}
            history={grouping}
            showHostColumn={showHostFilter && !historyServerId && !onlyResultHost}
            selectionMode={selectionMode}
            selectedAgentKeys={selectedAgentKeys}
            onToggleAgentSelection={toggleAgentSelection}
            searchMatchesByAgentKey={isSearching ? searchMatchesByAgentKey : undefined}
            flat={isSearching}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  page: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
  },
  pageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: { xs: theme.spacing[4], md: theme.spacing[6] },
    gap: theme.spacing[3],
  },
  heading: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  pageTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  filters: {
    flexDirection: { xs: "column", md: "row" },
    alignItems: { xs: "stretch", md: "center" },
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  filterContainer: {
    flexDirection: "row",
    flexGrow: 1,
    minWidth: 0,
    alignItems: "center",
    gap: theme.spacing[2],
  },
  bulkToolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[3],
  },
  bulkSelectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginRight: "auto",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  footerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  hostNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    marginTop: theme.spacing[3],
  },
  noticeText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
