import { memo, useCallback, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { Archive, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedArchive = withUnistyles(Archive);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type ActionStatus = "idle" | "pending" | "success";

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function QuickAction({
  label,
  testID,
  onPress,
  disabled,
  pending,
  children,
}: {
  label: string;
  testID: string;
  onPress?: () => void;
  disabled: boolean;
  pending: boolean;
  children: ReactNode;
}) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (!disabled && !pending) onPress?.();
    },
    [disabled, pending, onPress],
  );
  const buttonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      (hovered || pressed) && styles.buttonHovered,
      disabled && styles.buttonDisabled,
    ],
    [disabled],
  );
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View collapsable={false}>
          <Pressable
            accessibilityRole={isWeb ? undefined : "button"}
            accessibilityLabel={label}
            disabled={disabled || pending}
            onPressIn={stopPropagation}
            onPress={handlePress}
            testID={testID}
            style={buttonStyle}
          >
            {pending ? <ThemedLoadingSpinner size={14} uniProps={mutedColor} /> : children}
          </Pressable>
        </View>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export const SidebarWorkspaceQuickActions = memo(function SidebarWorkspaceQuickActions({
  workspaceKey,
  onDelete,
  onArchive,
  deleteStatus = "idle",
  archiveStatus = "idle",
  disabled = false,
  visible,
}: {
  workspaceKey: string;
  onDelete?: () => void;
  onArchive?: () => void;
  deleteStatus?: ActionStatus;
  archiveStatus?: ActionStatus;
  disabled?: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  const busy = disabled || deleteStatus === "pending" || archiveStatus === "pending";
  return (
    <View
      style={styles.actions}
      {...(isWeb ? { onPointerDown: stopPropagation, onDoubleClick: stopPropagation } : {})}
    >
      <QuickAction
        label={t("sidebar.workspace.actions.delete")}
        testID={`sidebar-workspace-quick-delete-${workspaceKey}`}
        onPress={onDelete}
        disabled={busy || !onDelete}
        pending={deleteStatus === "pending"}
      >
        <ThemedTrash2 size={14} uniProps={mutedColor} />
      </QuickAction>
      <QuickAction
        label={t("sidebar.workspace.actions.archive")}
        testID={`sidebar-workspace-quick-archive-${workspaceKey}`}
        onPress={onArchive}
        disabled={busy || !onArchive}
        pending={archiveStatus === "pending"}
      >
        <ThemedArchive size={14} uniProps={mutedColor} />
      </QuickAction>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  button: {
    width: 22,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  buttonDisabled: {
    opacity: theme.opacity[50],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
