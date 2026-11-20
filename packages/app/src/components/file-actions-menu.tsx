import { Fragment, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import {
  Pressable,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FileText,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  MoreVertical,
  Pencil,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { TOUCH_LIST_ROW_ACTION_SIZE } from "@/components/ui/control-geometry";
import { measureElement } from "@/components/ui/menu/menu-anchor";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedMoreVertical = withUnistyles(MoreVertical);

const menuButtonPointerBlockers = {
  onMouseDown: (event: { preventDefault(): void; stopPropagation(): void }) => {
    // Keep editor/browser selection intact and never begin the surrounding row's drag.
    event.preventDefault();
    event.stopPropagation();
  },
  onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
};

/** An explicit trigger for the same menu used by right-click, outside a row's drag handle. */
export function FileActionsMenuButton({
  onSelect,
  visible = true,
  testID,
}: {
  onSelect?: () => void;
  visible?: boolean;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const touchSized = useShowPersistentActions();
  const isVisible = touchSized || visible || Boolean(menu.open);
  const ref = useRef<View>(null);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onSelect?.();
      if (!ref.current) return;
      void measureElement(ref.current).then((rect) => {
        menu.setAnchorRect(rect);
        return menu.setOpen(true);
      });
    },
    [menu, onSelect],
  );
  const stopPropagation = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      buttonStyles.button,
      touchSized ? buttonStyles.touchButton : buttonStyles.desktopButton,
      ((!touchSized && hovered) || pressed) && buttonStyles.buttonHovered,
      !isVisible && buttonStyles.hidden,
    ],
    [isVisible, touchSized],
  );
  const renderIcon = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
      <ThemedMoreVertical
        size={touchSized ? 16 : 14}
        uniProps={
          (!touchSized && hovered) || pressed ? foregroundColorMapping : foregroundMutedColorMapping
        }
      />
    ),
    [touchSized],
  );
  return (
    <Pressable
      ref={ref}
      onPress={handlePress}
      onPressIn={stopPropagation}
      hitSlop={4}
      style={pressableStyle}
      {...menuButtonPointerBlockers}
      accessibilityRole="button"
      accessibilityLabel={t("workspace.fileActions.moreActions")}
      testID={testID}
    >
      {renderIcon}
    </Pressable>
  );
}

const buttonStyles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  touchButton: {
    width: TOUCH_LIST_ROW_ACTION_SIZE,
    height: TOUCH_LIST_ROW_ACTION_SIZE,
  },
  desktopButton: {
    width: 20,
    height: 20,
    // MoreVertical paints only around the center of its 14px SVG. Keep the 20px hit box,
    // and pull the painted dots onto the trailing glyph rail like the left sidebar.
    marginRight: -6,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  hidden: {
    opacity: 0,
    pointerEvents: "none",
  },
}));
interface FileAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
  testID?: string;
}

interface FileActionsContextMenuContentProps {
  fileKind: "file" | "directory";
  fileExists?: boolean;
  onOpenFile?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onReveal?: () => void;
  revealTargetName?: string;
  onDownload?: () => void;
  onAddToChat?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onCollapseFolder?: () => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onRevert?: () => void;
  onDelete?: () => void;
  /** Optional metadata block rendered above the actions (e.g. size/modified). */
  header?: ReactNode;
  testIDPrefix?: string;
}

/**
 * Shared context-menu content for per-file actions. The file explorer tree and git diff pane
 * own their row triggers while sharing action availability, ordering, and chrome here.
 */
export function FileActionsContextMenuContent({
  fileKind,
  fileExists = true,
  onOpenFile,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  revealTargetName,
  onDownload,
  onAddToChat,
  onNewFile,
  onNewFolder,
  onCollapseFolder,
  onRename,
  onDuplicate,
  onRevert,
  onDelete,
  header,
  testIDPrefix,
}: FileActionsContextMenuContentProps): ReactElement | null {
  const { t } = useTranslation();
  const actions = useMemo<FileAction[]>(() => {
    const availableFile = fileKind === "file" && fileExists;
    const specs: (FileAction | null)[] = [
      onNewFile
        ? {
            key: "new-file",
            label: t("workspace.fileActions.newFile"),
            icon: FilePlus,
            onSelect: onNewFile,
          }
        : null,
      onNewFolder
        ? {
            key: "new-folder",
            label: t("workspace.fileActions.newFolder"),
            icon: FolderPlus,
            onSelect: onNewFolder,
          }
        : null,
      onCollapseFolder
        ? {
            key: "collapse-folder",
            label: t("workspace.fileActions.collapseFolder"),
            icon: FolderMinus,
            onSelect: onCollapseFolder,
          }
        : null,
      availableFile && onOpenFile
        ? {
            key: "open-file",
            label: t("workspace.fileActions.openFile"),
            icon: FileText,
            onSelect: onOpenFile,
          }
        : null,
      onRename
        ? {
            key: "rename",
            label: t("workspace.fileActions.rename"),
            icon: Pencil,
            onSelect: onRename,
          }
        : null,
      onDuplicate
        ? {
            key: "duplicate",
            label: t("workspace.fileActions.duplicate"),
            icon: CopyPlus,
            onSelect: onDuplicate,
          }
        : null,
      onCopyPath
        ? {
            key: "copy-path",
            label: t("workspace.fileActions.copyPath"),
            icon: Copy,
            onSelect: onCopyPath,
          }
        : null,
      onCopyRelativePath
        ? {
            key: "copy-relative-path",
            label: t("workspace.fileActions.copyRelativePath"),
            icon: Copy,
            onSelect: onCopyRelativePath,
          }
        : null,
      onReveal && revealTargetName
        ? {
            key: "reveal",
            label: t("workspace.fileActions.revealIn", { target: revealTargetName }),
            icon: FolderOpen,
            onSelect: onReveal,
          }
        : null,
      availableFile && onDownload
        ? {
            key: "download",
            label: t("workspace.fileActions.download"),
            icon: Download,
            onSelect: onDownload,
          }
        : null,
      onAddToChat
        ? {
            key: "add-to-chat",
            label: t("workspace.fileActions.addToChat"),
            icon: MessageSquarePlus,
            onSelect: onAddToChat,
          }
        : null,
      onRevert
        ? {
            key: "revert",
            label: t("workspace.fileActions.revert"),
            icon: Undo2,
            onSelect: onRevert,
            destructive: true,
          }
        : null,
      onDelete
        ? {
            key: "delete",
            label: t("workspace.fileActions.delete"),
            icon: Trash2,
            onSelect: onDelete,
            destructive: true,
          }
        : null,
    ];
    const availableActions = specs.filter((action): action is FileAction => action !== null);
    return availableActions.map((action, index) =>
      Object.assign(action, {
        separatorBefore: Boolean(
          action.destructive && index > 0 && !availableActions[index - 1].destructive,
        ),
        testID: testIDPrefix ? `${testIDPrefix}-${action.key}` : undefined,
      }),
    );
  }, [
    fileExists,
    fileKind,
    onAddToChat,
    onCollapseFolder,
    onCopyPath,
    onCopyRelativePath,
    onDelete,
    onDownload,
    onDuplicate,
    onNewFile,
    onNewFolder,
    onOpenFile,
    onRename,
    onReveal,
    onRevert,
    revealTargetName,
    t,
    testIDPrefix,
  ]);

  if (actions.length === 0) {
    return null;
  }
  return (
    <ContextMenuContent
      align="start"
      width={220}
      testID={testIDPrefix ? `${testIDPrefix}-context-menu` : undefined}
    >
      {header ? (
        <>
          {header}
          <ContextMenuSeparator />
        </>
      ) : null}
      {actions.map((action) => (
        <Fragment key={action.key}>
          {action.separatorBefore ? <ContextMenuSeparator /> : null}
          <FileActionMenuItem action={action} />
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}

function FileActionMenuItem({ action }: { action: FileAction }): ReactElement {
  const leading = useMemo(() => {
    const ThemedIcon = withUnistyles(action.icon);
    return (
      <ThemedIcon
        size={ICON_SIZE.sm}
        uniProps={action.destructive ? destructiveColorMapping : foregroundMutedColorMapping}
      />
    );
  }, [action.destructive, action.icon]);
  return (
    <ContextMenuItem
      leading={leading}
      onSelect={action.onSelect}
      destructive={action.destructive}
      testID={action.testID}
    >
      {action.label}
    </ContextMenuItem>
  );
}
