import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";

export function SidebarWorkspaceTrailingContent({
  workspace,
}: {
  workspace: SidebarWorkspaceEntry;
}) {
  if (!workspace.statusEnteredAt) return null;
  return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />;
}

/**
 * Its own component so a minute tick updates only the timestamp, not the row or list.
 */
function WorkspaceTimestamp({ enteredAt }: { enteredAt: Date }) {
  const label = useCompactTimeAgo(enteredAt);
  return (
    <Text style={styles.timestamp} numberOfLines={1} testID="sidebar-workspace-timestamp">
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => {
  const rowLineHeight = Math.round(theme.fontSize.base * 1.54);
  return {
    // A step below the project title it shares the row with. The timestamp is the one thing here
    // you never came looking for, so it sits at the bottom of the muted ramp rather than tying
    // with the label naming the group.
    timestamp: {
      minHeight: rowLineHeight,
      lineHeight: rowLineHeight,
      color: theme.colors.foregroundExtraMuted,
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.normal,
      flexShrink: 0,
    },
  };
});
