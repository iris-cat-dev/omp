import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { FileText, Layers, MessageSquare, RefreshCw, Undo2 } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type RewindMode, useRewindCapabilities } from "./use-rewind-capabilities";
import type {
  AgentCapabilityFlags,
  AgentUserMessageRewindStatus,
} from "@omp-desktop/protocol/agent-types";
import type { AgentAttachment } from "@omp-desktop/protocol/messages";
import type { UserMessageImageAttachment } from "@/types/stream";

export type { RewindMode };

interface RewindMenuProps {
  capabilities: AgentCapabilityFlags;
  rewindStatus: AgentUserMessageRewindStatus;
  onSync: () => Promise<void> | void;
  rewoundText: string;
  rewoundImages: readonly UserMessageImageAttachment[];
  rewoundAttachments: readonly AgentAttachment[];
  onRewind: (input: {
    mode: RewindMode;
    rewoundText: string;
    rewoundImages: readonly UserMessageImageAttachment[];
    rewoundAttachments: readonly AgentAttachment[];
  }) => Promise<void> | void;
  isPending?: boolean;
  testID?: string;
}

function getIcon(mode: RewindMode, color: string): ReactElement {
  switch (mode) {
    case "conversation":
      return <MessageSquare size={16} color={color} />;
    case "files":
      return <FileText size={16} color={color} />;
    case "both":
      return <Layers size={16} color={color} />;
  }
}

export const RewindMenu = memo(function RewindMenu({
  capabilities,
  rewindStatus,
  onSync,
  rewoundText,
  rewoundImages,
  rewoundAttachments,
  onRewind,
  isPending: isPendingProp = false,
  testID = "rewind-menu",
}: RewindMenuProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const rewindLabels = useMemo(
    () => ({
      conversation: t("rewind.actions.conversation"),
      files: t("rewind.actions.files"),
      both: t("rewind.actions.both"),
    }),
    [t],
  );
  const items = useRewindCapabilities(capabilities, rewindLabels);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<RewindMode | null>(null);
  const [isSyncPending, setIsSyncPending] = useState(false);
  const actionInFlight = useRef(false);
  const isLocked = isPendingProp || pendingMode !== null || isSyncPending;
  const isTriggerDisabled = isLocked || rewindStatus === "pending";
  let tooltipLabel: string;
  if (rewindStatus === "pending") {
    tooltipLabel = t("rewind.pending");
  } else if (rewindStatus === "unavailable") {
    tooltipLabel = t("rewind.unavailable");
  } else {
    tooltipLabel = t("rewind.tooltip");
  }
  const syncIcon = useMemo(
    () => <RefreshCw size={16} color={theme.colors.foreground} />,
    [theme.colors.foreground],
  );

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && actionInFlight.current) return;
    setIsOpen(next);
  }, []);

  const handleSelect = useCallback(
    (mode: RewindMode) => async () => {
      if (isLocked || actionInFlight.current || rewindStatus !== "ready") return;
      actionInFlight.current = true;
      setPendingMode(mode);
      try {
        await onRewind({ mode, rewoundText, rewoundImages, rewoundAttachments });
      } catch {
        // useRewindAgentMutation owns the toast; the menu only owns flow state.
      } finally {
        setPendingMode(null);
        actionInFlight.current = false;
        setIsOpen(false);
      }
    },
    [isLocked, onRewind, rewindStatus, rewoundAttachments, rewoundImages, rewoundText],
  );
  const handleSync = useCallback(async () => {
    if (isLocked || actionInFlight.current || rewindStatus !== "unavailable") return;
    actionInFlight.current = true;
    setIsSyncPending(true);
    try {
      await onSync();
    } catch {
      // The mutation owns error feedback; synchronization never rewinds or restores a draft.
    } finally {
      actionInFlight.current = false;
      setIsSyncPending(false);
    }
  }, [isLocked, onSync, rewindStatus]);

  const triggerStyle = useCallback(
    () => [styles.trigger, isTriggerDisabled ? styles.triggerDisabled : null],
    [isTriggerDisabled],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    ),
    [tooltipLabel],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={tooltipLabel}
              accessibilityRole="button"
              disabled={isTriggerDisabled}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <Undo2
                  size={16}
                  color={hovered || open ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="end" minWidth={220} side="bottom" testID={`${testID}-content`}>
        <View style={styles.warningHeader}>
          <Text style={styles.warningText}>
            {rewindStatus === "unavailable" ? t("rewind.unavailable") : t("rewind.warning")}
          </Text>
        </View>
        <DropdownMenuSeparator />
        {items.map((item) => (
          <DropdownMenuItem
            key={item.mode}
            closeOnSelect={false}
            disabled={isLocked || rewindStatus !== "ready"}
            leading={getIcon(item.mode, theme.colors.foreground)}
            onSelect={handleSelect(item.mode)}
            status={pendingMode === item.mode ? "pending" : undefined}
            testID={item.testID}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
        {rewindStatus === "unavailable" || isSyncPending ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              closeOnSelect={false}
              disabled={isLocked}
              leading={syncIcon}
              onSelect={handleSync}
              status={isSyncPending ? "pending" : undefined}
              testID={`${testID}-sync`}
            >
              {t("rewind.actions.sync")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  warningHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  warningText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
