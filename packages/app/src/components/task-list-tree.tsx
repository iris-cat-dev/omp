import { Fragment, memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import {
  Circle,
  CircleDot,
  CircleCheck,
  CircleMinus,
  CirclePause,
  ListTodo,
  ChevronsUpDown,
} from "lucide-react-native";
import { Tree, TreeItem } from "@/components/ui/tree";
import { proseLineHeight } from "@/styles/markdown-styles";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import {
  buildTaskTree,
  getTaskStatus,
  type TaskStatus,
  type TaskTreePhase,
  type TaskTreeTask,
} from "./task-list-tree-model";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleMinus = withUnistyles(CircleMinus);
const ThemedCirclePause = withUnistyles(CirclePause);
const ThemedListTodo = withUnistyles(ListTodo);
const ThemedChevronsUpDown = withUnistyles(ChevronsUpDown);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const runningIconColor = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const blockedIconColor = (theme: Theme) => ({ color: theme.colors.statusWarning });

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "in_progress":
      return <ThemedCircleDot size={16} uniProps={runningIconColor} />;
    case "completed":
      return <ThemedCircleCheck size={16} uniProps={mutedIconColor} />;
    case "blocked":
      return <ThemedCirclePause size={16} uniProps={blockedIconColor} />;
    case "abandoned":
      return <ThemedCircleMinus size={16} uniProps={mutedIconColor} />;
    default:
      return <ThemedCircle size={16} uniProps={mutedIconColor} />;
  }
}

function TaskLeaf({ node, depth }: { node: TaskTreeTask; depth: number }) {
  const status = getTaskStatus(node.task);
  const label =
    status === "in_progress" && node.task.activeForm ? node.task.activeForm : node.task.text;
  const closed = status === "completed" || status === "abandoned";
  return (
    <TreeItem label={`${status}: ${label}`} depth={depth}>
      <View style={styles.statusIcon}>
        <TaskStatusIcon status={status} />
      </View>
      <Text
        style={[
          styles.taskLabel,
          closed && styles.closedLabel,
          status === "in_progress" && styles.runningLabel,
        ]}
      >
        {label}
      </Text>
    </TreeItem>
  );
}

function TaskPhase({
  phase,
  expanded,
  onToggle,
}: {
  phase: TaskTreePhase;
  expanded: boolean;
  onToggle: (id: string, expanded: boolean) => void;
}) {
  const handleToggle = useCallback(
    () => onToggle(phase.id, !expanded),
    [onToggle, phase.id, expanded],
  );
  return (
    <Fragment>
      <TreeItem
        label={`${phase.name}: ${phase.closed}/${phase.tasks.length}`}
        expanded={expanded}
        active={phase.active}
        onToggle={handleToggle}
        testID={`todo-phase-${phase.index}`}
      >
        <Text style={[styles.phaseLabel, phase.active && styles.activePhaseLabel]}>
          {phase.name}
        </Text>
        <Text style={styles.phaseProgress}>{`${phase.closed}/${phase.tasks.length}`}</Text>
      </TreeItem>
      {expanded && phase.tasks.map((node) => <TaskLeaf key={node.id} node={node} depth={1} />)}
    </Fragment>
  );
}

export const TaskListTree = memo(function TaskListTree({
  items,
  headerAccessory,
  scrollable = false,
}: {
  items: TodoEntry[];
  headerAccessory?: ReactNode;
  scrollable?: boolean;
}) {
  const { t } = useTranslation();
  const { nodes, phases, closed } = useMemo(() => buildTaskTree(items), [items]);
  const [expandedPhases, setExpandedPhases] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const allExpanded =
    phases.length > 0 && phases.every((phase) => expandedPhases.get(phase.id) ?? phase.active);
  const togglePhase = useCallback((id: string, expanded: boolean) => {
    setExpandedPhases((current) => {
      const next = new Map(current);
      next.set(id, expanded);
      return next;
    });
  }, []);
  const toggleAll = useCallback(() => {
    setExpandedPhases(new Map(phases.map((phase) => [phase.id, !allExpanded])));
  }, [allExpanded, phases]);
  const progress = t("message.todo.tasksProgress", { completed: closed, total: items.length });
  const toggleLabel = `${t(allExpanded ? "message.todo.collapse" : "message.todo.expand")}: ${progress}`;
  const contents =
    items.length === 0 ? (
      <Text style={styles.emptyText}>{t("message.todo.empty")}</Text>
    ) : (
      <Tree label={t("message.todo.title")}>
        {nodes.map((node) =>
          node.kind === "task" ? (
            <TaskLeaf key={node.id} node={node} depth={0} />
          ) : (
            <TaskPhase
              key={node.id}
              phase={node}
              expanded={expandedPhases.get(node.id) ?? node.active}
              onToggle={togglePhase}
            />
          ),
        )}
      </Tree>
    );
  return (
    <View style={styles.tree}>
      <View style={styles.header}>
        <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <Pressable
              onPress={toggleAll}
              accessibilityRole="button"
              accessibilityLabel={toggleLabel}
              aria-expanded={allExpanded}
              disabled={phases.length === 0}
              style={styles.headerToggle}
            >
              <ThemedListTodo size={16} uniProps={mutedIconColor} />
              <Text style={styles.title}>{t("message.todo.title")}</Text>
              <Text style={styles.overallProgress}>{`${closed}/${items.length}`}</Text>
              {phases.length > 0 ? (
                <ThemedChevronsUpDown size={14} uniProps={mutedIconColor} />
              ) : null}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="left" align="center" offset={8}>
            <Text style={styles.tooltipText}>{toggleLabel}</Text>
          </TooltipContent>
        </Tooltip>
        {headerAccessory}
      </View>
      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.contents}
          showsVerticalScrollIndicator
        >
          {contents}
        </ScrollView>
      ) : (
        <View style={styles.contents}>{contents}</View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  tree: { minWidth: 0, minHeight: 0, flexShrink: 1, gap: theme.spacing[2] },
  header: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  headerToggle: {
    minWidth: 0,
    minHeight: 28,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    fontWeight: theme.fontWeight.medium,
  },
  overallProgress: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    fontVariant: ["tabular-nums"],
  },
  scroll: { minHeight: 0, flexShrink: 1 },
  contents: { minWidth: 0 },
  statusIcon: {
    height: proseLineHeight(theme.fontSize.content),
    justifyContent: "center",
    flexShrink: 0,
  },
  taskLabel: {
    minWidth: 0,
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  runningLabel: { color: theme.colors.foreground },
  closedLabel: { color: theme.colors.foregroundExtraMuted },
  phaseLabel: {
    minWidth: 0,
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    fontWeight: theme.fontWeight.medium,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  activePhaseLabel: { color: theme.colors.foreground },
  phaseProgress: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    fontVariant: ["tabular-nums"],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
  },
  tooltipText: {
    maxWidth: 420,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
}));
