import { memo, useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { proseLineHeight } from "@/styles/markdown-styles";

const COLLAPSED_LINES = 6;
const collapsedAccessibilityState = { expanded: false };
const expandedAccessibilityState = { expanded: true };

const styles = StyleSheet.create((theme) => ({
  viewport: {
    overflow: "hidden",
  },
  collapsed: {
    maxHeight: proseLineHeight(theme.fontSize.content) * COLLAPSED_LINES,
  },
  text: {
    flexShrink: 0,
    lineHeight: proseLineHeight(theme.fontSize.content),
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  toggle: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  toggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));

export const CollapsibleUserMessageText = memo(function CollapsibleUserMessageText({
  message,
  style,
  testID,
}: {
  message: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [contentHeight, setContentHeight] = useState(0);
  const [collapsedHeight, setCollapsedHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const canCollapse = collapsedHeight > 0 && contentHeight > collapsedHeight + 1;

  useLayoutEffect(() => {
    setExpanded(false);
  }, [message]);
  useLayoutEffect(() => {
    if (!canCollapse) setExpanded(false);
  }, [canCollapse]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(event.nativeEvent.layout.height);
  }, []);
  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!expanded) setCollapsedHeight(event.nativeEvent.layout.height);
    },
    [expanded],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  const toggleLabel = t(
    expanded ? "message.actions.collapseMessage" : "message.actions.expandMessage",
  );

  return (
    <View>
      <View
        style={[styles.viewport, !expanded && styles.collapsed]}
        testID="user-message-text-viewport"
        onLayout={handleViewportLayout}
      >
        {/* Measure the untruncated text, even while its viewport is clipped. */}
        <Text selectable style={[style, styles.text]} onLayout={handleLayout} testID={testID}>
          {message}
        </Text>
      </View>
      {canCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          accessibilityState={expanded ? expandedAccessibilityState : collapsedAccessibilityState}
          aria-expanded={expanded}
          onPress={toggleExpanded}
          style={styles.toggle}
          testID="user-message-text-toggle"
        >
          <Text style={styles.toggleText}>{toggleLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});
