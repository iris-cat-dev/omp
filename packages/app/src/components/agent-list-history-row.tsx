import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, FolderClosed, GitBranch, Monitor } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AgentSearchMatch } from "@omp-desktop/protocol/messages";
import type { MatchRange } from "@omp-desktop/protocol/search/text-match";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatAgo } from "@/provider-usage/format";
import { HighlightedText } from "@/components/ui/highlighted-text";

type Field = AgentSearchMatch["field"] | "host";
type MetadataField = Exclude<Field, "title">;
const fieldIcons = {
  project: FolderClosed,
  workspace: ChevronRight,
  branch: GitBranch,
  host: Monitor,
};
interface HistoryField {
  field: Field;
  text: string;
  ranges?: readonly MatchRange[];
}

// Keep the matching part of long names visible even in a two-line mobile result.
function excerpt({ text, ranges }: HistoryField) {
  const firstMatch = ranges?.[0];
  if (!firstMatch || firstMatch.start < 32) return { text, ranges };
  const start = firstMatch.start - 8;
  return {
    text: `…${text.slice(start)}`,
    ranges: ranges?.map((range) => ({ start: range.start - start + 1, length: range.length })),
  };
}

function historyFields(
  agent: AggregatedAgent,
  fallbackTitle: string,
  showHost: boolean,
  showProject: boolean,
  matches?: readonly AgentSearchMatch[],
) {
  const placement = agent.projectPlacement;
  const title: HistoryField = {
    field: "title",
    text: agent.title?.trim() ? agent.title : fallbackTitle,
    ranges: matches?.find((match) => match.field === "title")?.ranges,
  };
  const metadata: (HistoryField & { field: MetadataField })[] = [];
  const add = (field: MetadataField, text: string | null | undefined) => {
    if (!text?.trim()) return;
    const ranges = matches?.find((match) => match.field === field)?.ranges;
    // A workspace often repeats the title or branch. Keep its highlight on the
    // surviving label. Host is a separate identity when searching across hosts.
    const duplicate =
      field !== "host" &&
      (text === title.text ? title : metadata.find((item) => item.text === text));
    if (duplicate) {
      duplicate.ranges ??= ranges;
      return;
    }
    metadata.push({ field, text, ranges });
  };
  if (showProject) {
    add(
      "project",
      placement?.projectName || agent.cwd.split(/[/\\]/).filter(Boolean).pop() || agent.cwd,
    );
  }
  add("workspace", placement?.workspaceName);
  add("branch", placement?.checkout.currentBranch);
  if (showHost) add("host", agent.serverLabel);
  return { title, metadata };
}

export function HistoryRowContent({
  agent,
  searchMatches,
  showHost,
  showProject,
  isMobile,
  badges,
}: {
  agent: AggregatedAgent;
  searchMatches?: readonly AgentSearchMatch[];
  showHost: boolean;
  showProject: boolean;
  isMobile: boolean;
  badges: ReactElement;
}) {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const { title, metadata } = historyFields(
    agent,
    t("agentList.fallbackTitle"),
    showHost,
    showProject,
    searchMatches,
  );
  const now = new Date();
  const date = agent.lastActivityAt;
  const time =
    now.getTime() - date.getTime() < 86_400_000
      ? formatAgo(date.toISOString(), t)
      : date.toLocaleDateString(i18n.resolvedLanguage ?? i18n.language, {
          year: now.getFullYear() === date.getFullYear() ? undefined : "numeric",
          month: "short",
          day: "numeric",
        });
  const timestamp = (
    <Text style={styles.time} numberOfLines={1}>
      {time}
    </Text>
  );
  const key = `${agent.serverId}-${agent.id}`;
  return (
    <View style={styles.content}>
      <View style={styles.headline}>
        <HighlightedText
          {...excerpt(title)}
          style={styles.title}
          numberOfLines={isMobile || searchMatches?.length ? 2 : 1}
        />
        {!isMobile ? timestamp : null}
      </View>
      <View style={styles.details}>
        {metadata.map((item) => {
          const Icon = fieldIcons[item.field];
          return (
            <View key={item.field} style={styles.detail}>
              <Icon size={theme.iconSize.xs} color={theme.colors.foregroundMuted} />
              <HighlightedText
                {...excerpt(item)}
                style={styles.meta}
                numberOfLines={item.ranges?.length ? 2 : 1}
                testID={`agent-row-${item.field}-${key}`}
              />
            </View>
          );
        })}
        {isMobile ? timestamp : null}
        {badges}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  headline: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing[3] },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
  },
  details: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[2],
    rowGap: theme.spacing[1],
  },
  detail: { maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  meta: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 1 },
  time: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 0 },
}));
