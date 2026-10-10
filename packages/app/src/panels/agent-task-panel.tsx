import { useCallback, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AGENT_TASK_PANEL_DESKTOP_WIDTH,
  AgentTaskPanel,
  AgentTaskPanelToggle,
} from "@/composer/task-list";
import { COMPACT_FORM_FACTOR_WIDTH } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const EMPTY_TASKS: TodoEntry[] = [];

const AGENT_TASK_PANEL_RAIL_WIDTH = AGENT_TASK_PANEL_DESKTOP_WIDTH + SPACING[4];

/**
 * The task rail must leave a complete compact conversation/composer beside it.
 * This is pane-local: a desktop window can contain two panes that are each too
 * narrow for the rail even though the global viewport is on a desktop breakpoint.
 */
export const AGENT_TASK_PANEL_MIN_PANE_WIDTH =
  AGENT_TASK_PANEL_RAIL_WIDTH + COMPACT_FORM_FACTOR_WIDTH;

export function useAgentTaskPanel(tasks: TodoEntry[] | undefined, isAvailable: boolean) {
  const [collapsed, setCollapsed] = useState(true);
  const collapse = useCallback(() => setCollapsed(true), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const taskItems = tasks ?? EMPTY_TASKS;
  const hasTasks = taskItems.length > 0;
  const isExpanded = isAvailable && hasTasks && !collapsed;
  const showToggle = isAvailable && hasTasks && collapsed;

  const content = (
    <>
      {isExpanded ? (
        <View style={styles.taskPanel} testID="agent-task-panel-rail">
          <AgentTaskPanel tasks={taskItems} onCollapse={collapse} />
        </View>
      ) : null}
      {showToggle ? (
        <View style={styles.taskPanelToggle} testID="agent-task-panel-toggle">
          <AgentTaskPanelToggle tasks={taskItems} onExpand={expand} />
        </View>
      ) : null}
    </>
  );
  const spacer = isExpanded ? (
    <View style={styles.composerTaskPanelSpacer} testID="agent-task-panel-spacer" />
  ) : null;

  return { content, spacer };
}

const styles = StyleSheet.create((theme) => ({
  composerTaskPanelSpacer: {
    width: AGENT_TASK_PANEL_RAIL_WIDTH,
    flexShrink: 0,
  },
  taskPanel: {
    flexShrink: 0,
    alignItems: "flex-end",
    paddingTop: theme.spacing[4],
    paddingRight: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  taskPanelToggle: {
    position: "absolute",
    top: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 20,
  },
}));
