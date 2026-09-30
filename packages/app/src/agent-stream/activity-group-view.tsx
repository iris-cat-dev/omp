import React, { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Brain, Layers } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExpandableBadge } from "@/components/message";
import type { AgentActivityGroup } from "./activity-grouping";
import type { Theme } from "@/styles/theme";

interface AgentActivityGroupViewProps {
  group: AgentActivityGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

const ACTIVITY_GROUP_MAX_HEIGHT = 480;
const ThemedLayers = withUnistyles(Layers);
const countIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AgentActivityGroupView = memo(function AgentActivityGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: AgentActivityGroupViewProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const count = group.items.length;
  const countBadge = useMemo(
    () =>
      expanded ? undefined : (
        <View style={styles.countBadge} testID="agent-activity-count">
          <ThemedLayers size={12} uniProps={countIconColor} />
          <Text style={styles.countText}>{count}</Text>
        </View>
      ),
    [count, expanded],
  );
  const toggle = useCallback(() => {
    onExpandedChange(group.id, !expanded);
  }, [expanded, group.id, onExpandedChange]);
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        {children}
      </ScrollView>
    ),
    [children, scrollToLatest],
  );

  return (
    <ExpandableBadge
      testID="agent-activity-group"
      label={t("agentStream.activityGroup")}
      trailingAccessory={countBadge}
      icon={Brain}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  countBadge: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[1],
    marginLeft: theme.spacing[2],
    paddingHorizontal: theme.spacing[1.5],
    height: 22,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  countText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
    includeFontPadding: false,
  },
  scroll: {
    maxHeight: ACTIVITY_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
