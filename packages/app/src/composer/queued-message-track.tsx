import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUp, GripVertical, Pencil } from "lucide-react-native";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  moveQueuedComposerMessageTo,
  type QueueWriter,
  type QueuedComposerMessage,
} from "@/composer/actions";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
const DRAG_HANDLE_WEB_STYLE = { touchAction: "none", cursor: "grab", userSelect: "none" } as object;
const ROW_WEB_STYLE = { touchAction: "pan-y" } as object;

function queuedMessageKey(item: QueuedComposerMessage): string {
  return item.id;
}

export function QueuedMessageTrack({
  agentId,
  messages,
  queue,
  onEdit,
  onSendNow,
  sendDisabled = false,
  sendLabel,
}: {
  agentId: string;
  messages: QueuedComposerMessage[];
  queue: QueueWriter;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  sendDisabled?: boolean;
  sendLabel?: string;
}) {
  const { t } = useTranslation();
  const resolvedSendLabel = sendLabel ?? t("composer.input.sendMessage");
  const onReorder = useCallback(
    (messageId: string, targetMessageId: string) => {
      moveQueuedComposerMessageTo({ agentId, messageId, targetMessageId, queue });
    },
    [agentId, queue],
  );
  const renderMessage = useCallback(
    (info: DraggableRenderItemInfo<QueuedComposerMessage>) => (
      <QueuedMessageRow
        {...info}
        draggable={messages.length > 1}
        onEdit={onEdit}
        onSendNow={onSendNow}
        sendDisabled={sendDisabled}
        sendLabel={resolvedSendLabel}
      />
    ),
    [messages.length, onEdit, onSendNow, resolvedSendLabel, sendDisabled],
  );

  if (messages.length === 0) return null;
  return (
    <DraggableList
      key={agentId}
      data={messages}
      keyExtractor={queuedMessageKey}
      renderItem={renderMessage}
      onReorder={onReorder}
      useDragHandle
      scrollEnabled={false}
      containerStyle={styles.queueTrack}
      contentContainerStyle={styles.queueTrack}
      testID="queued-message-track"
    />
  );
}

function QueuedMessageRow({
  item,
  drag,
  isActive,
  dragHandleProps,
  draggable,
  onEdit,
  onSendNow,
  sendDisabled,
  sendLabel,
}: DraggableRenderItemInfo<QueuedComposerMessage> & {
  draggable: boolean;
  onEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  sendDisabled: boolean;
  sendLabel: string;
}) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(item.id), [item.id, onEdit]);
  const handleSendNow = useCallback(() => onSendNow(item.id), [item.id, onSendNow]);
  const dragLabel = t("composer.queueOrder.dragMessage", { text: item.text });
  const handleIcon = (
    <ThemedGripVertical size={ICON_SIZE.md} uniProps={iconForegroundMutedMapping} />
  );
  let dragHandle: ReactElement | null = null;
  if (draggable && isWeb) {
    dragHandle = (
      <View
        {...dragHandleProps?.attributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef}
        style={[styles.dragHandle, DRAG_HANDLE_WEB_STYLE]}
        accessibilityRole="button"
        accessibilityLabel={dragLabel}
        accessibilityHint={t("composer.attachments.dragQueuedMessageHint")}
        testID={`queued-message-drag-${item.id}`}
      >
        {handleIcon}
      </View>
    );
  } else if (draggable) {
    dragHandle = (
      <Pressable
        onLongPress={drag}
        delayLongPress={180}
        style={styles.dragHandle}
        accessibilityRole="button"
        accessibilityLabel={dragLabel}
        testID={`queued-message-drag-${item.id}`}
      >
        {handleIcon}
      </Pressable>
    );
  }

  return (
    <View
      style={[
        styles.queueItem,
        !draggable && styles.queueItemWithoutHandle,
        isActive && styles.queueItemActive,
        isWeb && ROW_WEB_STYLE,
      ]}
      testID={`queued-message-${item.id}`}
    >
      {dragHandle}
      <Text style={styles.queueText} numberOfLines={2} ellipsizeMode="tail">
        {item.text}
      </Text>
      <View style={styles.queueActions}>
        <Pressable
          onPress={handleEdit}
          style={styles.queueActionButton}
          accessibilityLabel={t("composer.attachments.editQueuedMessage")}
          accessibilityRole="button"
        >
          <ThemedPencil size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
        </Pressable>
        <Tooltip delayDuration={200}>
          <TooltipTrigger
            onPress={handleSendNow}
            disabled={sendDisabled}
            style={[
              styles.queueActionButton,
              styles.queueSendButton,
              sendDisabled && styles.queueSendDisabled,
            ]}
            accessibilityLabel={sendLabel}
            accessibilityRole="button"
          >
            <ThemedArrowUp size={ICON_SIZE.sm} uniProps={iconAccentForegroundMapping} />
          </TooltipTrigger>
          <TooltipContent side="top">
            <Text style={styles.tooltipText}>{sendLabel}</Text>
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  queueTrack: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  queueItemWithoutHandle: {
    paddingLeft: theme.spacing[3],
  },
  queueItemActive: {
    backgroundColor: theme.colors.surface2,
  },
  dragHandle: {
    width: 36,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  queueText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  queueActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  queueActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  queueSendButton: {
    backgroundColor: theme.colors.accent,
  },
  queueSendDisabled: {
    opacity: 0.5,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));

const ThemedPencil = withUnistyles(Pencil);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedGripVertical = withUnistyles(GripVertical);
const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconAccentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
