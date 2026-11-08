import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
  AgentPromptContext,
  PromptContextCategory,
  PromptContextEntry,
} from "@omp-desktop/protocol/prompt-context";
import { Copy, Layers3, RefreshCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { usePaneContext } from "./pane-context";
import type { PanelRegistration } from "./panel-registry";

const ENTRIES_PER_PAGE = 40;
const COMPOSITION_SECTIONS = [
  { id: "systemPrompt", categories: ["system-prompt", "skills"] },
  {
    id: "messages",
    categories: [
      "user-messages",
      "assistant-messages",
      "assistant-thinking",
      "tool-calls",
      "tool-output",
    ],
  },
  { id: "tools", categories: ["built-in-tools", "custom-tools"] },
] as const;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function PromptAnalysisPanel() {
  const { serverId, target } = usePaneContext();
  invariant(
    target.kind === "prompt_analysis",
    "PromptAnalysisPanel requires prompt analysis target",
  );
  return (
    <PromptAnalysisContent
      key={JSON.stringify([serverId, target.agentId])}
      serverId={serverId}
      agentId={target.agentId}
    />
  );
}

function PromptAnalysisContent({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const instanceId = useId();
  const [width, setWidth] = useState(0);
  const snapshot = useFetchQuery({
    // Each tab captures on open rather than presenting another tab's cached snapshot.
    queryKey: ["agent-prompt-context", serverId, agentId, instanceId],
    queryFn: async () => {
      invariant(client, "Prompt context query requires a connected runtime client");
      const response = await client.getAgentPromptContext(agentId);
      if (response.error) throw new Error(response.error);
      if (!response.context) throw new Error(t("promptAnalysis.unavailable"));
      return response.context;
    },
    enabled: connected && Boolean(client),
    dataShape: "value",
    staleTimeMs: 86_400_000,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    structuralSharing: false,
  });
  const context = snapshot.data;
  const disconnected = !connected || !client;
  const narrow = width < 760;
  const onPaneLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const refetchSnapshot = snapshot.refetch;
  const refresh = useCallback(() => {
    void refetchSnapshot();
  }, [refetchSnapshot]);

  return (
    <View style={styles.root} onLayout={onPaneLayout} testID="prompt-analysis-panel">
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t("promptAnalysis.title")}</Text>
          <Button
            size="sm"
            variant="outline"
            leftIcon={RefreshCw}
            loading={snapshot.isFetching}
            disabled={disconnected}
            onPress={refresh}
            testID="prompt-analysis-refresh"
          >
            {t("promptAnalysis.refresh")}
          </Button>
        </View>
        <Text style={styles.note}>{t("promptAnalysis.snapshotSemantics")}</Text>
        {context ? <SnapshotSummary context={context} /> : null}
        {disconnected && (
          <Text
            style={styles.error}
            accessibilityRole="alert"
            testID="prompt-analysis-disconnected"
          >
            {t(context ? "promptAnalysis.disconnectedSnapshot" : "promptAnalysis.disconnected")}
          </Text>
        )}
        {!disconnected && snapshot.error && (
          <View testID="prompt-analysis-error">
            <Text
              style={styles.error}
              accessibilityRole="alert"
              testID={context ? "prompt-analysis-refresh-error" : "prompt-analysis-unavailable"}
            >
              {t(context ? "promptAnalysis.refreshFailed" : "promptAnalysis.unavailable")}
            </Text>
            {snapshot.error.message !== t("promptAnalysis.unavailable") ? (
              <Text style={styles.errorDetail} selectable>
                {snapshot.error.message}
              </Text>
            ) : null}
            {!context ? (
              <Text style={styles.note}>{t("promptAnalysis.unavailableHint")}</Text>
            ) : null}
          </View>
        )}
      </View>
      {context && <PromptComposition context={context} narrow={narrow} />}
      {!context && !disconnected && !snapshot.error && (
        <View style={styles.emptyState} testID="prompt-analysis-loading">
          <ThemedLoadingSpinner size="small" />
          <Text style={styles.note}>{t("promptAnalysis.loading")}</Text>
        </View>
      )}
    </View>
  );
}

function SnapshotSummary({ context }: { context: AgentPromptContext }) {
  const { t, i18n } = useTranslation();
  const number = (value: number) => value.toLocaleString(i18n.language);
  const { breakdown } = context;
  const usage =
    breakdown.contextWindow > 0
      ? Math.min(100, Math.max(0, (breakdown.usedTokens / breakdown.contextWindow) * 100))
      : 0;
  return (
    <View style={styles.summary} testID="prompt-analysis-summary">
      <View style={styles.summaryRow}>
        <Text style={styles.total}>
          {t("promptAnalysis.usedTokens", { tokens: number(breakdown.usedTokens) })}
        </Text>
        <Text style={styles.meta} selectable testID="prompt-analysis-model">
          {context.model
            ? `${context.model.provider} / ${context.model.id}`
            : t("promptAnalysis.modelUnavailable")}
        </Text>
        <Text style={styles.meta} testID="prompt-analysis-captured-at">
          {t("promptAnalysis.capturedAt", {
            time: new Date(context.capturedAt).toLocaleString(i18n.language),
          })}
        </Text>
      </View>
      {breakdown.contextWindow > 0 ? (
        <View style={styles.usageTrack}>
          <View style={[styles.usageFill, { width: `${usage}%` }]} />
        </View>
      ) : null}
      <View style={styles.summaryRow}>
        <Text style={styles.meta}>
          {breakdown.contextWindow > 0
            ? t("promptAnalysis.capacity", {
                window: number(breakdown.contextWindow),
                free: number(breakdown.freeTokens),
                reserve: number(breakdown.autoCompactBufferTokens),
              })
            : t("promptAnalysis.windowUnavailable")}
        </Text>
        {breakdown.thresholdTokens !== undefined ? (
          <Text style={styles.meta}>
            {t("promptAnalysis.compactionThreshold", { tokens: number(breakdown.thresholdTokens) })}
          </Text>
        ) : null}
      </View>
      <View style={styles.summaryRow}>
        {breakdown.categories.map((category) => (
          <Text style={styles.usageCategory} key={category.id}>
            {t(`promptAnalysis.usageCategories.${category.id}`, { defaultValue: category.label })}{" "}
            {number(category.tokens)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function PromptComposition({ context, narrow }: { context: AgentPromptContext; narrow: boolean }) {
  const { t, i18n } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sections = useMemo(() => {
    const categories = new Map<PromptContextCategory["id"], PromptContextCategory>(
      context.categories.map((category) => [category.id, category]),
    );
    return COMPOSITION_SECTIONS.map((section) => {
      const sectionCategories = section.categories.flatMap((id) => {
        const category = categories.get(id);
        return category ? [category] : [];
      });
      let tokens = 0;
      let chars = 0;
      for (const category of sectionCategories) {
        tokens += category.tokens;
        for (const entry of category.entries) chars += entry.text.length;
      }
      return {
        id: section.id,
        categories: sectionCategories,
        tokens,
        chars,
      };
    });
  }, [context]);
  const selected = useMemo(() => {
    for (const category of context.categories) {
      const entry = category.entries.find((candidate) => candidate.id === selectedId);
      if (entry) return { category, entry };
    }
    const category =
      selectedId === null
        ? (context.categories.find(
            (candidate) => candidate.id === "system-prompt" && candidate.entries.length > 0,
          ) ?? context.categories.find((candidate) => candidate.entries.length > 0))
        : context.categories.find((candidate) => candidate.entries.length > 0);
    return category ? { category, entry: category.entries[0]! } : null;
  }, [context, selectedId]);
  useEffect(() => {
    const currentId = selected?.entry.id ?? null;
    if (currentId !== selectedId) setSelectedId(currentId);
  }, [selected, selectedId]);

  return (
    <View style={[styles.workspace, narrow && styles.workspaceNarrow]}>
      <ScrollView
        style={styles.composition}
        contentContainerStyle={styles.compositionContent}
        testID="prompt-analysis-composition"
      >
        <Text style={styles.note}>{t("promptAnalysis.selectHint")}</Text>
        {sections.map((section, index) => (
          <View
            style={styles.section}
            key={section.id}
            testID={`prompt-analysis-section-${section.id}`}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionIndex}>{String(index + 1).padStart(2, "0")}</Text>
              <View style={styles.sectionName}>
                <Text style={styles.sectionTitle}>{section.id}</Text>
                <Text style={styles.meta}>{t(`promptAnalysis.sections.${section.id}`)}</Text>
              </View>
              <Text style={styles.sizes}>
                {t("promptAnalysis.sizes", {
                  tokens: section.tokens.toLocaleString(i18n.language),
                  chars: section.chars.toLocaleString(i18n.language),
                })}
              </Text>
            </View>
            {section.categories.map((category) => (
              <CompositionCategory
                key={`${context.capturedAt}/${category.id}`}
                category={category}
                selectedId={selected?.entry.id ?? null}
                onSelect={setSelectedId}
              />
            ))}
          </View>
        ))}
        <Text style={styles.note}>{t("promptAnalysis.estimatesNote")}</Text>
      </ScrollView>
      <View
        style={[styles.inspector, narrow && styles.inspectorNarrow]}
        testID="prompt-analysis-inspector"
      >
        {selected ? (
          <FragmentInspector key={`${context.capturedAt}/${selected.entry.id}`} {...selected} />
        ) : (
          <View style={styles.emptyState} testID="prompt-analysis-inspector-empty">
            <Text style={styles.inspectorTitle}>{t("promptAnalysis.inspector")}</Text>
            <Text style={styles.note}>{t("promptAnalysis.selectHint")}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function CompositionCategory({
  category,
  selectedId,
  onSelect,
}: {
  category: PromptContextCategory;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [page, setPage] = useState(0);
  const start = page * ENTRIES_PER_PAGE;
  const entries = category.entries.slice(start, start + ENTRIES_PER_PAGE);
  const label = t(`promptAnalysis.categories.${category.id}`, { defaultValue: category.label });
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const previousPage = useCallback(() => setPage((current) => current - 1), []);
  const nextPage = useCallback(() => setPage((current) => current + 1), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const expansionIndicator = expanded ? "− " : "+ ";
  let categoryNote: string | undefined;
  if (category.id === "skills") categoryNote = t("promptAnalysis.skillsNote");
  else if (expanded && category.entries.length === 0) {
    categoryNote = t("promptAnalysis.emptyCategory");
  }
  return (
    <View style={styles.category} testID={`prompt-analysis-category-${category.id}`}>
      <Pressable
        style={styles.categoryHeader}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        disabled={category.entries.length === 0}
        onPress={toggleExpanded}
        testID={`prompt-analysis-category-toggle-${category.id}`}
      >
        <Text style={styles.categoryTitle}>
          {category.entries.length > 0 && expansionIndicator}
          {label}
        </Text>
        <Text style={styles.sizes}>
          {t("promptAnalysis.categorySize", {
            entries: category.entries.length.toLocaleString(i18n.language),
            tokens: category.tokens.toLocaleString(i18n.language),
          })}
        </Text>
      </Pressable>
      {categoryNote && <Text style={styles.categoryNote}>{categoryNote}</Text>}
      {expanded &&
        entries.map((entry) => (
          <FragmentRow
            key={entry.id}
            categoryId={category.id}
            categoryLabel={label}
            entry={entry}
            selected={entry.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      {expanded && category.entries.length > ENTRIES_PER_PAGE ? (
        <View style={styles.pagination}>
          <Text style={styles.meta}>
            {t("promptAnalysis.entriesRange", {
              start: (start + 1).toLocaleString(i18n.language),
              end: Math.min(start + ENTRIES_PER_PAGE, category.entries.length).toLocaleString(
                i18n.language,
              ),
              total: category.entries.length.toLocaleString(i18n.language),
            })}
          </Text>
          <Button
            size="xs"
            variant="ghost"
            disabled={page === 0}
            onPress={previousPage}
            testID={`prompt-analysis-${category.id}-previous`}
          >
            {t("promptAnalysis.previous")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={start + ENTRIES_PER_PAGE >= category.entries.length}
            onPress={nextPage}
            testID={`prompt-analysis-${category.id}-next`}
          >
            {t("promptAnalysis.next")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function FragmentRow({
  categoryId,
  categoryLabel,
  entry,
  selected,
  onSelect,
}: {
  categoryId: PromptContextCategory["id"];
  categoryLabel: string;
  entry: PromptContextEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => onSelect(entry.id), [entry.id, onSelect]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.fragment,
      categoryId === "built-in-tools" && styles.builtInFragment,
      categoryId === "custom-tools" && styles.customFragment,
      selected && styles.fragmentSelected,
      pressed && styles.fragmentPressed,
    ],
    [categoryId, selected],
  );
  return (
    <Pressable
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${categoryLabel}: ${entry.label}`}
      accessibilityState={accessibilityState}
      onPress={select}
      testID={`prompt-analysis-fragment-${entry.id}`}
    >
      <View style={styles.fragmentName}>
        <Text style={styles.fragmentTitle} numberOfLines={2}>
          {entry.label}
        </Text>
        {entry.info ? (
          <Text style={styles.meta} numberOfLines={1}>
            {entry.info}
          </Text>
        ) : null}
        {entry.interrupted || entry.thinkingGroup?.interrupted ? (
          <Text style={styles.meta}>{t("promptAnalysis.interrupted")}</Text>
        ) : null}
      </View>
      <Text style={styles.sizes}>
        {t("promptAnalysis.sizes", {
          tokens: entry.tokens.toLocaleString(i18n.language),
          chars: entry.text.length.toLocaleString(i18n.language),
        })}
      </Text>
    </Pressable>
  );
}

function FragmentInspector({
  category,
  entry,
}: {
  category: PromptContextCategory;
  entry: PromptContextEntry;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const copy = useCallback(async () => {
    setCopying(true);
    try {
      await copyToClipboard(entry.text);
      toast.copied();
    } catch (error) {
      toast.error(
        t("promptAnalysis.copyFailed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setCopying(false);
    }
  }, [entry.text, t, toast]);
  const sourceLabel =
    category.id === "system-prompt"
      ? t("promptAnalysis.usageCategories.systemPrompt")
      : t(`promptAnalysis.categories.${category.id}`, { defaultValue: category.label });
  return (
    <ScrollView style={styles.inspectorScroll} contentContainerStyle={styles.inspectorContent}>
      <Text style={styles.kicker}>{t("promptAnalysis.inspector")}</Text>
      <Text style={styles.inspectorTitle} selectable testID="prompt-analysis-selected-title">
        {entry.label}
      </Text>
      <Text style={styles.sourceBadge}>{sourceLabel}</Text>
      <View style={styles.metadata} testID="prompt-analysis-selected-metadata">
        <MetadataRow label={t("promptAnalysis.entryId")} value={entry.id} />
        {entry.info !== undefined ? (
          <MetadataRow label={t("promptAnalysis.sdkInfo")} value={entry.info} />
        ) : null}
        {entry.path !== undefined ? (
          <MetadataRow label={t("promptAnalysis.path")} value={entry.path} />
        ) : null}
        {entry.timestamp !== undefined ? (
          <MetadataRow
            label={t("promptAnalysis.timestamp")}
            value={new Date(entry.timestamp).toLocaleString(i18n.language)}
          />
        ) : null}
        {entry.callId !== undefined ? (
          <MetadataRow label={t("promptAnalysis.callId")} value={entry.callId} />
        ) : null}
        {entry.thinkingGroup ? (
          <MetadataRow
            label={t("promptAnalysis.thinkingGroup")}
            value={t("promptAnalysis.groupEstimate", {
              label: entry.thinkingGroup.label,
              tokens: entry.thinkingGroup.tokens.toLocaleString(i18n.language),
            })}
          />
        ) : null}
        {entry.interrupted || entry.thinkingGroup?.interrupted ? (
          <Text style={styles.note}>{t("promptAnalysis.interrupted")}</Text>
        ) : null}
      </View>
      <View style={styles.rawHeader}>
        <View style={styles.fragmentName}>
          <Text style={styles.categoryTitle}>{t("promptAnalysis.rawText")}</Text>
          <Text style={styles.sizes}>
            {t("promptAnalysis.sizes", {
              tokens: entry.tokens.toLocaleString(i18n.language),
              chars: entry.text.length.toLocaleString(i18n.language),
            })}
          </Text>
        </View>
        <Button
          size="sm"
          variant="outline"
          leftIcon={Copy}
          loading={copying}
          onPress={copy}
          testID="prompt-analysis-copy-raw"
        >
          {t("promptAnalysis.copyRaw")}
        </Button>
      </View>
      {entry.text.length === 0 ? (
        <Text style={styles.note}>{t("promptAnalysis.emptyText")}</Text>
      ) : null}
      <Text style={styles.rawText} selectable testID="prompt-analysis-raw-text">
        {entry.text}
      </Text>
    </ScrollView>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.metadataValue} selectable>
        {value}
      </Text>
    </View>
  );
}

export const promptAnalysisPanelRegistration: PanelRegistration<"prompt_analysis"> = {
  kind: "prompt_analysis",
  resourceKey: (target) => target.agentId,
  component: PromptAnalysisPanel,
  useDescriptor() {
    const { t } = useTranslation();
    return {
      label: t("promptAnalysis.title"),
      subtitle: t("promptAnalysis.currentSnapshot"),
      tooltip: t("promptAnalysis.title"),
      titleState: "ready",
      icon: Layers3,
      statusBucket: null,
    };
  },
};

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.background },
  header: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 18 },
  summary: { gap: theme.spacing[1.5] },
  summaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  total: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  usageTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  usageFill: { height: 4, backgroundColor: theme.colors.primary },
  usageCategory: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm, lineHeight: 18 },
  errorDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 18 },
  emptyState: {
    flex: 1,
    minHeight: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  workspace: { flex: 1, minHeight: 0, flexDirection: "row" },
  workspaceNarrow: { flexDirection: "column" },
  composition: { flex: 1, minHeight: 0, minWidth: 0 },
  compositionContent: { padding: theme.spacing[3], gap: theme.spacing[3] },
  section: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  sectionIndex: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  sectionName: { flex: 1, minWidth: 100, gap: theme.spacing[1] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  category: {
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  categoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[1],
  },
  categoryTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  categoryNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    paddingHorizontal: theme.spacing[1],
  },
  sizes: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  fragment: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderRadius: theme.borderRadius.md,
  },
  builtInFragment: { borderLeftColor: theme.colors.primary },
  customFragment: { borderLeftColor: theme.colors.statusMerged },
  fragmentSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surface2 },
  fragmentPressed: { opacity: 0.85 },
  fragmentName: { flex: 1, minWidth: 100, gap: theme.spacing[1] },
  fragmentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  pagination: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  inspector: {
    width: "42%",
    minWidth: 300,
    minHeight: 0,
    borderLeftWidth: 1,
    borderColor: theme.colors.border,
  },
  inspectorNarrow: { width: "100%", minWidth: 0, flex: 1, borderLeftWidth: 0, borderTopWidth: 1 },
  inspectorScroll: { flex: 1, minHeight: 0 },
  inspectorContent: { padding: theme.spacing[3], gap: theme.spacing[3] },
  kicker: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  inspectorTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  sourceBadge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  metadata: { gap: theme.spacing[2] },
  metadataRow: { gap: theme.spacing[1] },
  metadataValue: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  rawHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  rawText: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 20,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
}));
