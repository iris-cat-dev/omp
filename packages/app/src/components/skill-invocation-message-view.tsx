import { ChevronDown, ChevronRight } from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

import type { SkillInvocationMessage } from "./skill-invocation-message";
import { CollapsibleUserMessageText } from "./collapsible-user-message-text";

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  toggle: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.content,
    fontWeight: "600",
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
  },
  content: {
    borderTopWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
}));

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIconColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const collapsedAccessibilityState = { expanded: false };
const expandedAccessibilityState = { expanded: true };

export const SkillInvocationMessageView = memo(function SkillInvocationMessageView({
  message,
  invocation,
}: {
  message: string;
  invocation: SkillInvocationMessage;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const accessibilityState = expanded ? expandedAccessibilityState : collapsedAccessibilityState;
  let content = null;
  if (expanded) {
    content = (
      <Text selectable style={[styles.text, styles.content]} testID="user-message-skill-content">
        {message}
      </Text>
    );
  } else if (invocation.userArguments) {
    content = <CollapsibleUserMessageText message={invocation.userArguments} style={styles.text} />;
  }

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`/${invocation.name}`}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        style={styles.toggle}
        testID="user-message-skill-toggle"
      >
        {expanded ? (
          <ThemedChevronDown size={14} uniProps={mutedIconColor} />
        ) : (
          <ThemedChevronRight size={14} uniProps={mutedIconColor} />
        )}
        <Text style={styles.label}>{`/${invocation.name}`}</Text>
      </Pressable>
      {content}
    </View>
  );
});
