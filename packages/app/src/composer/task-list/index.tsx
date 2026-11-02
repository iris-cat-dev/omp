import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ListTodo, PanelRightClose } from "lucide-react-native";
import { TaskListTree } from "@/components/task-list-tree";
import { isClosedTask } from "@/components/task-list-tree-model";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TodoEntry } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { proseLineHeight } from "@/styles/markdown-styles";

const ThemedListTodo = withUnistyles(ListTodo);
const ThemedPanelRightClose = withUnistyles(PanelRightClose);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AGENT_TASK_PANEL_DESKTOP_WIDTH = 340;

export const AgentTaskPanel = memo(function AgentTaskPanel({
  tasks,
  onCollapse,
}: {
  tasks: TodoEntry[] | undefined;
  onCollapse: () => void;
}) {
  const { t } = useTranslation();
  const headerAccessory = useMemo(
    () => (
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <Pressable
            onPress={onCollapse}
            accessibilityRole="button"
            accessibilityLabel={t("message.todo.collapse")}
            style={styles.iconButton}
            testID="agent-task-panel-collapse"
          >
            <ThemedPanelRightClose size={16} uniProps={mutedIconColor} />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="left" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("message.todo.collapse")}</Text>
        </TooltipContent>
      </Tooltip>
    ),
    [onCollapse, t],
  );
  if (!tasks?.length) return null;

  return (
    <View style={styles.panel} testID="agent-task-panel">
      <TaskListTree items={tasks} scrollable headerAccessory={headerAccessory} />
    </View>
  );
});

export const AgentTaskPanelToggle = memo(function AgentTaskPanelToggle({
  tasks,
  onExpand,
}: {
  tasks: TodoEntry[];
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const completed = useMemo(() => tasks.filter(isClosedTask).length, [tasks]);
  const progress = t("message.todo.tasksProgress", { completed, total: tasks.length });
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onExpand}
          accessibilityRole="button"
          accessibilityLabel={`${t("message.todo.expand")}: ${progress}`}
          style={styles.collapsedButton}
          testID="agent-task-panel-expand"
        >
          <ThemedListTodo size={18} uniProps={mutedIconColor} />
          <Text style={styles.collapsedProgress}>{progress}</Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="left" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.todo.expand")}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const styles = StyleSheet.create((theme) => ({
  panel: {
    width: { xs: 280, md: AGENT_TASK_PANEL_DESKTOP_WIDTH },
    maxHeight: 560,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
  },
  iconButton: {
    width: { xs: 28, md: 24 },
    height: { xs: 28, md: 24 },
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  collapsedButton: {
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  collapsedProgress: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
    fontVariant: ["tabular-nums"],
  },
  tooltipText: {
    maxWidth: 420,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
}));
