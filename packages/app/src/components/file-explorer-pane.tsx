import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type RefCallback,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  ListRenderItemInfo,
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type GestureResponderEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type ViewStyle,
} from "react-native";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { getIsElectronRuntime, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import * as Clipboard from "expo-clipboard";
import {
  ChevronDown,
  CheckSquare,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  ListChecks,
  Square,
  RotateCw,
  Search,
} from "lucide-react-native";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
  WORKSPACE_TREE_LOADING_ICON_SIZE,
} from "@/components/tree-primitives";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  PaneContentToolbar,
  paneContentToolbarIconSize,
  paneContentToolbarIconButtonStyle,
} from "@/components/ui/pane-content-toolbar";
import { FileExplorerSearch } from "@/components/file-explorer-search";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { FileExplorerContentSearch } from "@/components/file-explorer-content-search";
import {
  useOverlayFlatListScrollbar,
  type OverlayFlatListScrollbar,
} from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import type { Theme } from "@/styles/theme";
import type {
  AgentFileExplorerState,
  ExplorerDirectory,
  ExplorerEntry,
} from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import {
  FileActionsContextMenuContent,
  FileActionsMenuButton,
} from "@/components/file-actions-menu";
import { ContextMenu, ContextMenuTrigger, useContextMenu } from "@/components/ui/context-menu";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { buildWorkspaceExplorerStateKey } from "@/file-explorer/state-key";
import { usePanelStore, type ExpandedPathsUpdate, type SortOption } from "@/stores/panel-store";
import { formatTimeAgo } from "@/utils/time";
import { buildAbsoluteExplorerPath, parentExplorerPath } from "@/utils/explorer-paths";
import { filterVisibleExplorerEntries, isHiddenExplorerPath } from "@/file-explorer/visibility";
import {
  flattenExplorerTree,
  reconcileRestoredExpandedPaths,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
  type ExplorerTreeRow,
} from "@/file-explorer/tree";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useToast } from "@/contexts/toast-context";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  resolveExplorerDragEntries,
  resolveExplorerEntryMoves,
  type ExplorerEntryDragItem,
  type ExplorerEntryMoveRequest,
} from "@/file-explorer/entry-drag";
import { deleteExplorerSelectionPaths, resolveExplorerSelection } from "@/file-explorer/selection";
import { useExplorerEntryDrag } from "@/file-explorer/use-entry-drag";
import { moveExplorerSelection } from "@/file-explorer/move-selection";
import { createDirectoryComposerAttachment } from "@/attachments/directory";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";

const FILE_EXPLORER_ROW_SELECTOR = '[data-testid^="file-explorer-row-"]';
const FILE_EXPLORER_ROOT_DROP_BLOCKED_SELECTOR = '[data-explorer-root-drop-blocked="true"]';
const FILE_EXPLORER_ROOT_DROP_BLOCKED_DATA_SET = { "explorer-root-drop-blocked": "true" };

interface ExplorerPressModifiers {
  additive: boolean;
  range: boolean;
}

function getExplorerPressModifiers(event: GestureResponderEvent): ExplorerPressModifiers {
  const nativeEvent = event.nativeEvent as typeof event.nativeEvent & {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  };
  return {
    additive:
      getShortcutOs() === "mac" ? nativeEvent.metaKey === true : nativeEvent.ctrlKey === true,
    range: nativeEvent.shiftKey === true,
  };
}

const SORT_OPTIONS: { value: SortOption }[] = [
  { value: "name" },
  { value: "modified" },
  { value: "size" },
];

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedListChecks = withUnistyles(ListChecks);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function DirectoryChevronIcon({ loading, expanded }: { loading: boolean; expanded: boolean }) {
  if (loading) {
    return (
      <ThemedLoadingSpinner
        size={WORKSPACE_TREE_LOADING_ICON_SIZE}
        uniProps={foregroundMutedColorMapping}
      />
    );
  }
  return <TreeChevron expanded={expanded} />;
}

function formatFileSize({ size }: { size: number }): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

interface ExplorerTouchControls {
  selectionMode: boolean;
  onToggleSelection: (entry: ExplorerEntry) => void;
  onMoveToDirectory?: (path: string) => void;
  canMoveToDirectory: (path: string) => boolean;
  moving: boolean;
}

interface TreeRowItemProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  entry: ExplorerEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  loading: boolean;
  onEntryPress: (entry: ExplorerEntry, event: GestureResponderEvent) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void;
  onCopyRelativePath: (path: string) => void;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onAddDirectoryToChat?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
  onMoveEntry?: (requests: ExplorerEntryMoveRequest[]) => void;
  selectedEntries?: readonly ExplorerEntryDragItem[];
  touchControls: ExplorerTouchControls;
  onLayout: (event: LayoutChangeEvent) => void;
  testID?: string;
}

function sortTriggerStyle({
  hovered,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.sortTrigger, (Boolean(hovered) || pressed) && styles.sortTriggerHovered];
}

function iconButtonStyle(
  isCompact: boolean,
  { hovered, pressed }: PressableStateCallbackType & { hovered?: boolean },
) {
  return paneContentToolbarIconButtonStyle({ hovered, pressed }, false, isCompact);
}

type ExplorerListRow =
  | { type: "entry"; row: ExplorerTreeRow }
  | { type: "draft"; parentPath: string; kind: "file" | "directory"; depth: number }
  | { type: "rename"; entry: ExplorerEntry; depth: number };

type ExplorerPendingEdit =
  | { type: "create"; parentPath: string; kind: "file" | "directory" }
  | { type: "rename"; entry: ExplorerEntry };

function listRowKeyExtractor(row: ExplorerListRow) {
  if (row.type === "entry") {
    return row.row.entry.path;
  }
  return row.type === "rename" ? `rename:${row.entry.path}` : `draft:${row.parentPath}:${row.kind}`;
}

interface EntryNameInputRowProps {
  depth: number;
  kind: "file" | "directory";
  initialName?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}

function EntryNameInputRow({
  depth,
  kind,
  initialName = "",
  onCommit,
  onCancel,
  onLayout,
}: EntryNameInputRowProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const settledRef = useRef(false);

  const commit = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    const trimmed = name.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }, [name, onCancel, onCommit]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        settledRef.current = true;
        onCancel();
      }
    },
    [onCancel],
  );

  return (
    <View
      style={[workspaceTreeRowStyles.row, { paddingLeft: treeRowPaddingLeft(depth) }]}
      onLayout={onLayout}
    >
      <View style={styles.entryInfo}>
        <View style={styles.entryIcon}>
          {kind === "directory" ? (
            <TreeChevron expanded={false} />
          ) : (
            <MaterialFileIcon fileName={name || "untitled"} size={WORKSPACE_TREE_ICON_SIZE} />
          )}
        </View>
        <TextInput
          autoFocus
          initialValue={name}
          onChangeText={setName}
          onSubmitEditing={commit}
          onBlur={commit}
          onKeyPress={handleKeyPress}
          placeholder={
            kind === "directory"
              ? t("workspace.fileExplorer.draft.folderPlaceholder")
              : t("workspace.fileExplorer.draft.filePlaceholder")
          }
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={styles.draftPlaceholder.color}
          style={styles.draftInput}
          selectTextOnFocus={Boolean(initialName)}
          testID="file-explorer-name-input"
        />
      </View>
    </View>
  );
}

function stopExplorerActionPropagation(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

const explorerSelectionPointerBlockers = {
  onPointerDown: stopExplorerActionPropagation,
  onMouseDown: stopExplorerActionPropagation,
};

type TreeRowTouchActionProps = Pick<TreeRowItemProps, "entry" | "touchControls" | "testID">;

function TreeRowSelectionCheckbox({
  entry,
  touchControls,
  testID,
  isSelected,
}: TreeRowTouchActionProps & { isSelected: boolean }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const touchSized = useShowPersistentActions();
  const accessibilityState = useMemo(() => ({ checked: isSelected }), [isSelected]);
  const handleToggleSelection = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      touchControls.onToggleSelection(entry);
    },
    [entry, touchControls],
  );

  if (!touchControls.selectionMode || touchControls.onMoveToDirectory) return null;

  return (
    <Pressable
      {...explorerSelectionPointerBlockers}
      onPress={handleToggleSelection}
      onPressIn={stopExplorerActionPropagation}
      style={[styles.rowAction, !touchSized && styles.compactRowAction]}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      aria-checked={isSelected}
      accessibilityLabel={t("workspace.fileExplorer.actions.selectEntry", { name: entry.name })}
      testID={testID ? `${testID}-select` : undefined}
    >
      {isSelected ? (
        <CheckSquare size={18} color={theme.colors.foreground} />
      ) : (
        <Square size={18} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

function TreeRowMoveButton({ entry, touchControls, testID }: TreeRowTouchActionProps) {
  const { t } = useTranslation();
  const touchSized = useShowPersistentActions();
  const handleMoveHere = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      touchControls.onMoveToDirectory?.(entry.path);
    },
    [entry.path, touchControls],
  );

  if (entry.kind !== "directory" || !touchControls.onMoveToDirectory) return null;

  const disabled = touchControls.moving || !touchControls.canMoveToDirectory(entry.path);
  return (
    <Pressable
      onPress={handleMoveHere}
      onPressIn={stopExplorerActionPropagation}
      disabled={disabled}
      accessibilityRole="button"
      style={[
        styles.rowAction,
        !touchSized && styles.compactRowAction,
        disabled && styles.disabledAction,
      ]}
      testID={testID ? `${testID}-move-here` : undefined}
    >
      <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.moveHere")}</Text>
    </Pressable>
  );
}

type TreeRowMenuProps = Pick<
  TreeRowItemProps,
  | "entry"
  | "isExpanded"
  | "onCopyPath"
  | "onCopyRelativePath"
  | "onRevealEntry"
  | "revealTargetName"
  | "onDownloadEntry"
  | "onAddToChat"
  | "onAddDirectoryToChat"
  | "onNewEntry"
  | "onCollapseDirectory"
  | "onRenameEntry"
  | "onDuplicateEntry"
  | "onDeleteEntry"
  | "selectedEntries"
  | "testID"
>;

function TreeRowMenu({
  entry,
  isExpanded,
  onCopyPath,
  onCopyRelativePath,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onAddDirectoryToChat,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
  selectedEntries,
  testID,
}: TreeRowMenuProps) {
  const { t } = useTranslation();
  const isDirectory = entry.kind === "directory";
  const selectionCount = useMemo(
    () =>
      selectedEntries?.some((selected) => selected.path === entry.path)
        ? selectedEntries.length
        : 1,
    [entry.path, selectedEntries],
  );
  const isBatchSelection = selectionCount > 1;
  const canAddToChat = isDirectory ? Boolean(onAddDirectoryToChat) : Boolean(onAddToChat);
  const handleCopy = useCallback(() => {
    onCopyPath(entry.path);
  }, [onCopyPath, entry.path]);
  const handleCopyRelativePath = useCallback(() => {
    onCopyRelativePath(entry.path);
  }, [onCopyRelativePath, entry.path]);
  const handleReveal = useCallback(() => {
    onRevealEntry?.(entry);
  }, [onRevealEntry, entry]);
  const handleDownload = useCallback(() => {
    onDownloadEntry(entry);
  }, [onDownloadEntry, entry]);
  const handleAddToChat = useCallback(() => {
    if (isDirectory) {
      onAddDirectoryToChat?.(entry.path);
      return;
    }
    onAddToChat?.(entry.path);
  }, [entry.path, isDirectory, onAddDirectoryToChat, onAddToChat]);
  const handleNewFile = useCallback(() => {
    onNewEntry?.(entry.path, "file");
  }, [onNewEntry, entry.path]);
  const handleNewFolder = useCallback(() => {
    onNewEntry?.(entry.path, "directory");
  }, [onNewEntry, entry.path]);
  const handleCollapseDirectory = useCallback(() => {
    onCollapseDirectory?.(entry.path);
  }, [entry.path, onCollapseDirectory]);
  const handleRename = useCallback(() => {
    onRenameEntry?.(entry);
  }, [onRenameEntry, entry]);
  const handleDuplicate = useCallback(() => {
    onDuplicateEntry?.(entry);
  }, [entry, onDuplicateEntry]);
  const handleDelete = useCallback(() => {
    onDeleteEntry?.(entry);
  }, [onDeleteEntry, entry]);
  const metaHeader = useMemo(() => {
    if (selectionCount > 1) {
      return (
        <View style={styles.contextMetaBlock}>
          <Text style={styles.contextMetaValue}>
            {t("workspace.fileExplorer.actions.selectedCount", { count: selectionCount })}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.contextMetaBlock}>
        <View style={styles.contextMetaRow}>
          <Text style={styles.contextMetaLabel} numberOfLines={1}>
            {t("workspace.fileExplorer.context.size")}
          </Text>
          <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
            {formatFileSize({ size: entry.size })}
          </Text>
        </View>
        <View style={styles.contextMetaRow}>
          <Text style={styles.contextMetaLabel} numberOfLines={1}>
            {t("workspace.fileExplorer.context.modified")}
          </Text>
          <Text style={styles.contextMetaValue} numberOfLines={1} ellipsizeMode="tail">
            {formatTimeAgo(new Date(entry.modifiedAt))}
          </Text>
        </View>
      </View>
    );
  }, [entry.modifiedAt, entry.size, selectionCount, t]);

  return (
    <FileActionsContextMenuContent
      fileKind={entry.kind}
      onCopyPath={handleCopy}
      onCopyRelativePath={handleCopyRelativePath}
      onReveal={!isBatchSelection && onRevealEntry ? handleReveal : undefined}
      revealTargetName={revealTargetName}
      onDownload={!isBatchSelection ? handleDownload : undefined}
      onAddToChat={!isBatchSelection && canAddToChat ? handleAddToChat : undefined}
      onNewFile={!isBatchSelection && onNewEntry ? handleNewFile : undefined}
      onNewFolder={!isBatchSelection && onNewEntry ? handleNewFolder : undefined}
      onCollapseFolder={
        !isBatchSelection && isDirectory && isExpanded ? handleCollapseDirectory : undefined
      }
      onRename={!isBatchSelection && onRenameEntry ? handleRename : undefined}
      onDuplicate={!isBatchSelection && onDuplicateEntry ? handleDuplicate : undefined}
      onDelete={onDeleteEntry ? handleDelete : undefined}
      header={metaHeader}
      testIDPrefix={testID}
    />
  );
}

function TreeRowItem({
  serverId,
  workspaceId,
  workspaceRoot,
  entry,
  depth,
  isExpanded,
  isSelected,
  loading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onAddDirectoryToChat,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
  onMoveEntry,
  selectedEntries,
  touchControls,
  onLayout,
  testID,
}: TreeRowItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const showNameHover = useCallback(() => setIsHovered(true), []);
  const hideNameHover = useCallback(() => setIsHovered(false), []);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const isDirectory = entry.kind === "directory";
  const blocksRootDrop = isDirectory || parentExplorerPath(entry.path) !== ".";
  const dragSource = useMemo(
    () =>
      workspaceId
        ? {
            payload: {
              version: 1 as const,
              serverId,
              workspaceId,
              entries: resolveExplorerDragEntries({
                dragged: { path: entry.path, kind: entry.kind },
                selectedEntries: selectedEntries ?? [],
              }),
            },
            chatAttachment: isDirectory
              ? createDirectoryComposerAttachment(
                  buildAbsoluteExplorerPath({ workspaceRoot, entryPath: entry.path }),
                )
              : createWorkspaceFileAttachment({ path: entry.path }),
            moveEnabled: Boolean(onMoveEntry),
          }
        : undefined,
    [
      entry.kind,
      entry.path,
      isDirectory,
      onMoveEntry,
      selectedEntries,
      serverId,
      workspaceId,
      workspaceRoot,
    ],
  );
  const dragTarget = useMemo(
    () =>
      workspaceId && isDirectory && onMoveEntry
        ? {
            serverId,
            workspaceId,
            parentPath: entry.path,
            onMove: onMoveEntry,
          }
        : undefined,
    [entry.path, isDirectory, onMoveEntry, serverId, workspaceId],
  );
  const { ref: entryDragRef, isDropTarget } = useExplorerEntryDrag({
    source: dragSource,
    target: dragTarget,
  });

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // Control-click belongs to the OS context menu on macOS, even if a click also arrives.
      const nativeEvent = event.nativeEvent as typeof event.nativeEvent & { ctrlKey?: boolean };
      if (getShortcutOs() === "mac" && nativeEvent.ctrlKey) return;
      const modifiers = getExplorerPressModifiers(event);
      const selection = isWeb ? window.getSelection() : null;
      if (
        !modifiers.additive &&
        !modifiers.range &&
        selection &&
        !selection.isCollapsed &&
        selection.toString().length > 0
      ) {
        return;
      }
      onEntryPress(entry, event);
    },
    [onEntryPress, entry],
  );

  const handleSelect = useCallback(() => {
    onSelectEntry(entry);
  }, [entry, onSelectEntry]);

  const handleSelectionMouseDown = useCallback((event: ReactMouseEvent) => {
    const isMac = getShortcutOs() === "mac";
    const additive = isMac ? event.metaKey : event.ctrlKey;
    if (event.button === 0 && (additive || event.shiftKey) && !(isMac && event.ctrlKey)) {
      // Range selection belongs to the tree, not the browser's text selection.
      event.preventDefault();
    }
  }, []);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);

  const rowStyle = [
    workspaceTreeRowStyles.row,
    { paddingLeft: treeRowPaddingLeft(depth) },
    (isHovered || isPressed || isSelected) && workspaceTreeRowStyles.active,
    isDropTarget && styles.entryDropTarget,
  ];

  return (
    <ContextMenu>
      <View
        style={rowStyle}
        onLayout={onLayout}
        onPointerEnter={showNameHover}
        onPointerLeave={hideNameHover}
        dataSet={isWeb && blocksRootDrop ? FILE_EXPLORER_ROOT_DROP_BLOCKED_DATA_SET : undefined}
      >
        <TreeRowSelectionCheckbox
          entry={entry}
          touchControls={touchControls}
          isSelected={isSelected}
          testID={testID}
        />
        <ContextMenuTrigger
          triggerRef={entryDragRef}
          onPress={handlePress}
          onLongPress={getIsElectronRuntime() ? undefined : handleSelect}
          onContextMenu={handleSelect}
          {...(isWeb ? { onMouseDown: handleSelectionMouseDown } : {})}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          style={styles.entryPressTarget}
          accessibilityRole="button"
          accessibilityLabel={entry.name}
          accessibilityState={accessibilityState}
          aria-selected={isSelected}
          testID={testID}
        >
          <View style={styles.entryInfo}>
            <View style={styles.entryIcon}>
              {isDirectory ? (
                <DirectoryChevronIcon loading={loading} expanded={isExpanded} />
              ) : (
                <MaterialFileIcon fileName={entry.name} size={WORKSPACE_TREE_ICON_SIZE} />
              )}
            </View>
            <Text
              style={[
                styles.entryName,
                workspaceTreeRowStyles.name,
                isHovered && workspaceTreeRowStyles.nameHovered,
              ]}
              numberOfLines={1}
              testID={testID ? `${testID}-name` : undefined}
            >
              {entry.name}
            </Text>
          </View>
        </ContextMenuTrigger>
        <TreeRowMoveButton entry={entry} touchControls={touchControls} testID={testID} />
        {!touchControls.onMoveToDirectory ? (
          <FileActionsMenuButton
            onSelect={handleSelect}
            testID={testID ? `${testID}-more` : undefined}
          />
        ) : null}
      </View>
      <TreeRowMenu
        entry={entry}
        isExpanded={isExpanded}
        onCopyPath={onCopyPath}
        onCopyRelativePath={onCopyRelativePath}
        onRevealEntry={onRevealEntry}
        revealTargetName={revealTargetName}
        onDownloadEntry={onDownloadEntry}
        onAddToChat={onAddToChat}
        onAddDirectoryToChat={onAddDirectoryToChat}
        onNewEntry={onNewEntry}
        onCollapseDirectory={onCollapseDirectory}
        onRenameEntry={onRenameEntry}
        onDuplicateEntry={onDuplicateEntry}
        onDeleteEntry={onDeleteEntry}
        selectedEntries={selectedEntries}
        testID={testID}
      />
    </ContextMenu>
  );
}

interface FileExplorerPaneProps {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  onOpenFile?: (location: WorkspaceFileLocation) => void;
  onAddToChat?: (path: string) => void;
  onAddDirectoryToChat?: (path: string) => void;
  revealRequests?: boolean;
}

function removeMovedExplorerEntries(
  entries: ExplorerEntryDragItem[] | null,
  movedPaths: readonly string[],
): ExplorerEntryDragItem[] | null {
  const remaining = (entries ?? []).filter(
    (entry) => !movedPaths.some((path) => isExplorerPathWithin(entry.path, path)),
  );
  return remaining.length > 0 ? remaining : null;
}

interface ExplorerSelectionToolbarProps {
  selectionMode: boolean;
  selectedCount: number;
  selectedDragEntryCount: number;
  moveEntries: readonly ExplorerEntryDragItem[] | null;
  moveEnabled: boolean;
  moving: boolean;
  canMoveToRoot: boolean;
  onToggleSelectionMode: () => void;
  onStartMove: () => void;
  onMoveToRoot: () => void;
  onCancelMove: () => void;
}

function ExplorerSelectionToolbar({
  selectionMode,
  selectedCount,
  selectedDragEntryCount,
  moveEntries,
  moveEnabled,
  moving,
  canMoveToRoot,
  onToggleSelectionMode,
  onStartMove,
  onMoveToRoot,
  onCancelMove,
}: ExplorerSelectionToolbarProps) {
  const { t } = useTranslation();

  const rootMoveDisabled = moving || !canMoveToRoot;
  return (
    <View style={styles.selectionToolbar}>
      <Pressable
        onPress={onToggleSelectionMode}
        disabled={moving}
        style={styles.selectionAction}
        accessibilityRole="button"
        testID="files-toggle-selection"
      >
        <ThemedListChecks size={18} uniProps={foregroundMutedColorMapping} />
        <Text style={styles.retryButtonText}>
          {t(
            selectionMode
              ? "workspace.fileExplorer.actions.finishSelection"
              : "workspace.fileExplorer.actions.selectEntries",
          )}
        </Text>
      </Pressable>
      {selectionMode || selectedCount > 1 ? (
        <Text style={styles.retryButtonText}>
          {t("workspace.fileExplorer.actions.selectedCount", {
            count: moveEntries?.length ?? selectedCount,
          })}
        </Text>
      ) : null}
      {moveEnabled && selectedDragEntryCount > 0 && !moveEntries ? (
        <Pressable
          onPress={onStartMove}
          style={styles.selectionAction}
          accessibilityRole="button"
          testID="files-move-selection"
        >
          <Text style={styles.retryButtonText}>
            {t("workspace.fileExplorer.actions.moveSelection")}
          </Text>
        </Pressable>
      ) : null}
      {moveEntries ? (
        <>
          <Text style={styles.retryButtonText}>
            {t("workspace.fileExplorer.actions.chooseDestination")}
          </Text>
          <Pressable
            onPress={onMoveToRoot}
            disabled={rootMoveDisabled}
            accessibilityRole="button"
            style={[styles.selectionAction, rootMoveDisabled && styles.disabledAction]}
            testID="files-move-to-root"
          >
            <Text style={styles.retryButtonText}>
              / · {t("workspace.fileExplorer.actions.moveHere")}
            </Text>
          </Pressable>
          <Pressable
            onPress={onCancelMove}
            disabled={moving}
            accessibilityRole="button"
            style={styles.selectionAction}
            testID="files-cancel-move"
          >
            <Text style={styles.retryButtonText}>
              {t("workspace.fileExplorer.actions.cancelMove")}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

// Memoized event callbacks share their enclosing V8 context. Keep bulk snapshots
// and derived rows out of that context rather than linking old renders together.
function useExplorerRenderData(
  state: AgentFileExplorerState | undefined,
  expandedPaths: Set<string>,
  sortOption: SortOption,
  showHiddenFiles: boolean,
  selectedEntryPaths: Set<string>,
  pendingEdit: ExplorerPendingEdit | null,
) {
  const fields = useMemo(() => deriveExplorerFields(state), [state]);
  const { directories } = fields;
  const treeRows = useMemo(
    () => flattenExplorerTree({ directories, expandedPaths, sortOption, showHiddenFiles }),
    [directories, expandedPaths, showHiddenFiles, sortOption],
  );
  const visibleEntryPaths = useMemo(() => treeRows.map((row) => row.entry.path), [treeRows]);
  const selectedDragEntries = useMemo(() => {
    if (selectedEntryPaths.size === 0) return [];
    const entries: ExplorerEntryDragItem[] = [];
    for (const path of selectedEntryPaths) {
      const entry = directories
        .get(parentExplorerPath(path))
        ?.entries.find((candidate) => candidate.path === path);
      if (entry) entries.push({ path, kind: entry.kind });
    }
    return entries;
  }, [directories, selectedEntryPaths]);
  const listRows = useMemo<ExplorerListRow[]>(() => {
    const rows: ExplorerListRow[] = treeRows.map((row) =>
      pendingEdit?.type === "rename" && pendingEdit.entry.path === row.entry.path
        ? { type: "rename", entry: row.entry, depth: row.depth }
        : { type: "entry", row },
    );
    if (pendingEdit?.type !== "create") return rows;
    let insertionIndex = 0;
    let depth = 0;
    if (pendingEdit.parentPath !== ".") {
      const parentIndex = treeRows.findIndex((row) => row.entry.path === pendingEdit.parentPath);
      if (parentIndex >= 0) {
        insertionIndex = parentIndex + 1;
        depth = treeRows[parentIndex].depth + 1;
      }
    }
    rows.splice(insertionIndex, 0, {
      type: "draft",
      parentPath: pendingEdit.parentPath,
      kind: pendingEdit.kind,
      depth,
    });
    return rows;
  }, [pendingEdit, treeRows]);
  return {
    ...fields,
    visibleEntryPaths,
    selectedDragEntries,
    listRows,
    errorRecoveryPath: getErrorRecoveryPath(state),
  };
}

// This memo also stays outside the pane's long-lived event-callback scope.
function useExplorerExpandedPaths(paths: string[] | undefined): Set<string> {
  return useMemo(() => new Set(paths && paths.length > 0 ? paths : ["."]), [paths]);
}

export function FileExplorerPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
  onAddToChat,
  onAddDirectoryToChat,
  revealRequests = false,
}: FileExplorerPaneProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const isActive = useRetainedPanelActive();

  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [normalizedWorkspaceRoot, workspaceId],
  );
  const hasWorkspaceScope = Boolean(workspaceStateKey && normalizedWorkspaceRoot);
  const explorerState = useSessionStore((state) =>
    workspaceStateKey && state.sessions[serverId]
      ? state.sessions[serverId]?.fileExplorer.get(workspaceStateKey)
      : undefined,
  );
  const refreshRevision = explorerState?.refreshRevision ?? 0;

  const {
    requestDirectoryListing,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    moveEntry,
    selectExplorerEntry,
  } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const toast = useToast();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  // COMPAT(fsEntryOps): added in v0.3.0, remove gate after 2027-02-08.
  const fsEntryOpsEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryOps === true,
  );
  // COMPAT(fsEntryMove): added in v0.3.2, remove gate after 2027-03-10.
  const fsEntryMoveEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryMove === true,
  );
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  // COMPAT(workspaceTextSearch): added 2026-09-08, remove filename-search fallback after 2027-03-08.
  const workspaceTextSearchEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceTextSearch === true,
  );
  const [pendingEdit, setPendingEdit] = useState<ExplorerPendingEdit | null>(null);
  const [selectedEntryPaths, setSelectedEntryPaths] = useState<Set<string>>(() => new Set());
  const selectedEntryPathsRef = useRef(selectedEntryPaths);
  const selectionAnchorPathRef = useRef<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [moveEntries, setMoveEntries] = useState<ExplorerEntryDragItem[] | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const moveInFlightRef = useRef(false);
  const commitSelectedEntryPaths = useCallback((next: Set<string>) => {
    selectedEntryPathsRef.current = next;
    setSelectedEntryPaths(next);
  }, []);
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const sortOption = usePanelStore((state) => state.explorerSortOption);
  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const setSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const toggleExplorerShowHiddenFiles = usePanelStore(
    (state) => state.toggleExplorerShowHiddenFiles,
  );
  const expandedPathsArray = usePanelStore((state) =>
    workspaceStateKey ? state.expandedPathsByWorkspace[workspaceStateKey] : undefined,
  );
  const setExpandedPathsForWorkspace = usePanelStore((state) => state.setExpandedPathsForWorkspace);
  const revealRequest = usePanelStore((state) => {
    const request = state.explorerRevealRequest;
    return revealRequests &&
      request?.serverId === serverId &&
      request.workspaceKey === workspaceStateKey
      ? request
      : null;
  });
  const completedRevealRequestRef = useRef<typeof revealRequest>(null);
  const [scrollReveal, setScrollReveal] = useState<{ path: string; revision: number } | null>(null);
  const expandedPaths = useExplorerExpandedPaths(expandedPathsArray);
  const renderData = useExplorerRenderData(
    explorerState,
    expandedPaths,
    sortOption,
    showHiddenFiles,
    selectedEntryPaths,
    pendingEdit,
  );
  const {
    directories,
    pendingRequest,
    isExplorerLoading,
    error,
    selectedEntryPath,
    selectedDragEntries,
    listRows,
    errorRecoveryPath,
  } = renderData;
  const renderDataRef = useRef(renderData);
  renderDataRef.current = renderData;
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  const moveEntriesRef = useRef(moveEntries);
  moveEntriesRef.current = moveEntries;
  const selectedEntryPathRef = useRef(selectedEntryPath);
  selectedEntryPathRef.current = selectedEntryPath;

  const isDirectoryLoading = useCallback(
    (path: string) => isPendingListForPath({ isExplorerLoading, pendingRequest, path }),
    [isExplorerLoading, pendingRequest],
  );

  const treeListRef = useRef<FlatList<ExplorerListRow>>(null);
  const scrollbar = useOverlayFlatListScrollbar(treeListRef, { enabled: !isCompact });

  const hasInitializedRef = useRef(false);
  // Initialization takes one snapshot; user expansion changes are reconciled on completion.
  const initializationOptionsRef = useRef({ expandedPaths, showHiddenFiles, refreshRevision });
  initializationOptionsRef.current = { expandedPaths, showHiddenFiles, refreshRevision };
  const observedRefreshRef = useRef({
    serverId,
    workspaceStateKey,
    workspaceRoot: normalizedWorkspaceRoot,
    revision: refreshRevision,
  });

  useEffect(() => {
    hasInitializedRef.current = false;
    setSelectionMode(false);
    setMoveEntries(null);
    setScrollReveal(null);
    const currentPath = selectedEntryPathRef.current;
    const next = currentPath ? new Set([currentPath]) : new Set<string>();
    selectionAnchorPathRef.current = currentPath;
    commitSelectedEntryPaths(next);
  }, [commitSelectedEntryPaths, normalizedWorkspaceRoot, serverId, workspaceStateKey]);

  useEffect(() => {
    if (selectedEntryPath ? selectedEntryPathsRef.current.has(selectedEntryPath) : false) {
      return;
    }
    const next = selectedEntryPath ? new Set([selectedEntryPath]) : new Set<string>();
    selectionAnchorPathRef.current = selectedEntryPath;
    commitSelectedEntryPaths(next);
  }, [commitSelectedEntryPaths, selectedEntryPath]);

  useEffect(() => {
    if (!isActive || !hasWorkspaceScope || hasInitializedRef.current) return;
    let cancelled = false;
    let completed = false;
    hasInitializedRef.current = true;
    const options = initializationOptionsRef.current;
    // The new initialization already requests the latest listing for this activation.
    observedRefreshRef.current = {
      serverId,
      workspaceStateKey,
      workspaceRoot: normalizedWorkspaceRoot,
      revision: options.refreshRevision,
    };
    const initialize = async () => {
      const initialized = await initializeExplorer({
        workspaceStateKey,
        persistedExpandedPaths: options.expandedPaths,
        showHiddenFiles: options.showHiddenFiles,
        requestDirectoryListing,
        setExpandedPathsForWorkspace,
        isCancelled: () => cancelled,
      });
      if (cancelled) return;
      completed = true;
      hasInitializedRef.current = initialized;
    };
    void initialize();
    return () => {
      cancelled = true;
      if (!completed) hasInitializedRef.current = false;
    };
  }, [
    hasWorkspaceScope,
    isActive,
    normalizedWorkspaceRoot,
    requestDirectoryListing,
    serverId,
    setExpandedPathsForWorkspace,
    workspaceStateKey,
  ]);
  useEffect(() => {
    if (!isActive || !revealRequest || !hasWorkspaceScope || !workspaceStateKey) return;
    if (completedRevealRequestRef.current === revealRequest) return;
    let cancelled = false;
    const reveal = async () => {
      const segments = revealRequest.path.split("/");
      let parentPath = ".";
      const ancestors = ["."];
      // Validate each step against the daemon listing rather than selecting a stale or
      // outside-workspace path that the tree cannot actually display.
      for (const [index, segment] of segments.entries()) {
        const directory = await requestDirectoryListing(parentPath, {
          recordHistory: false,
          setCurrentPath: false,
        });
        if (cancelled || !directory) return;
        const path = parentPath === "." ? segment : `${parentPath}/${segment}`;
        const entry = filterVisibleExplorerEntries(directory.entries, true).find(
          (candidate) =>
            candidate.path === path &&
            candidate.kind === (index === segments.length - 1 ? "file" : "directory"),
        );
        if (!entry) return;
        if (index === segments.length - 1) {
          if (isHiddenExplorerPath(path) && !usePanelStore.getState().explorerShowHiddenFiles) {
            usePanelStore.getState().toggleExplorerShowHiddenFiles();
          }
          setExpandedPathsForWorkspace(workspaceStateKey, (current) =>
            Array.from(new Set([...current, ...ancestors])),
          );
          selectionAnchorPathRef.current = path;
          commitSelectedEntryPaths(new Set([path]));
          selectExplorerEntry(path);
          setScrollReveal({ path, revision: revealRequest.revision });
          completedRevealRequestRef.current = revealRequest;
          return;
        }
        parentPath = path;
        ancestors.push(path);
      }
    };
    void reveal();
    return () => {
      cancelled = true;
    };
  }, [
    commitSelectedEntryPaths,
    hasWorkspaceScope,
    isActive,
    requestDirectoryListing,
    revealRequest,
    selectExplorerEntry,
    setExpandedPathsForWorkspace,
    workspaceStateKey,
  ]);

  const handleToggleDirectory = useCallback(
    (entry: ExplorerEntry) =>
      toggleDirectory({
        entry,
        workspaceStateKey,
        expandedPaths: expandedPathsRef.current,
        requestDirectoryListing,
        setExpandedPathsForWorkspace,
      }),
    [workspaceStateKey, requestDirectoryListing, setExpandedPathsForWorkspace],
  );

  const handleOpenFile = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) {
        return;
      }
      onOpenFile?.({ path: entry.path });
    },
    [hasWorkspaceScope, onOpenFile],
  );

  const handleCollapseDirectory = useCallback(
    (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        currentPaths.filter((expandedPath) => !isExplorerPathWithin(expandedPath, path)),
      );
    },
    [setExpandedPathsForWorkspace, workspaceStateKey],
  );

  const handleCopyPath = useCallback(
    async (path: string) => {
      const selection = selectedEntryPathsRef.current;
      const paths = selection.has(path) ? [...selection] : [path];
      await Clipboard.setStringAsync(
        paths
          .map((entryPath) =>
            buildAbsoluteExplorerPath({ workspaceRoot: normalizedWorkspaceRoot, entryPath }),
          )
          .join("\n"),
      );
    },
    [normalizedWorkspaceRoot],
  );

  const handleCopyRelativePath = useCallback(async (path: string) => {
    const selection = selectedEntryPathsRef.current;
    await Clipboard.setStringAsync(selection.has(path) ? [...selection].join("\n") : path);
  }, []);

  const handleAddDirectoryToChat = useCallback(
    (path: string) => {
      onAddDirectoryToChat?.(
        buildAbsoluteExplorerPath({
          workspaceRoot: normalizedWorkspaceRoot,
          entryPath: path,
        }),
      );
    },
    [normalizedWorkspaceRoot, onAddDirectoryToChat],
  );

  const handleRevealEntry = useCallback(
    async (entry: ExplorerEntry) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: normalizedWorkspaceRoot,
          filePath: buildAbsoluteExplorerPath({
            workspaceRoot: normalizedWorkspaceRoot,
            entryPath: entry.path,
          }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [fileManagerTarget, normalizedWorkspaceRoot, t, toast],
  );

  const handleDownloadEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (entry.kind !== "file") {
        return;
      }
      downloadFile({ fileName: entry.name, path: entry.path });
    },
    [downloadFile],
  );

  const handleNewEntry = useCallback(
    (parentPath: string, kind: "file" | "directory") => {
      if (!workspaceStateKey) {
        return;
      }
      if (parentPath !== ".") {
        setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
          setExpandedDirectoryPath({
            currentExpandedPaths: currentPaths,
            directoryPath: parentPath,
            expanded: true,
          }),
        );
        if (!renderDataRef.current.directories.has(parentPath)) {
          void requestDirectoryListing(parentPath, {
            recordHistory: false,
            setCurrentPath: false,
          });
        }
      }
      setPendingEdit({ type: "create", parentPath, kind });
    },
    [requestDirectoryListing, setExpandedPathsForWorkspace, workspaceStateKey],
  );

  const handleEditCancel = useCallback(() => {
    setPendingEdit(null);
  }, []);

  const handleRenameEntry = useCallback((entry: ExplorerEntry) => {
    setPendingEdit({ type: "rename", entry });
  }, []);

  const handleDraftCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "create") {
        return;
      }
      try {
        const payload = await createEntry({
          parentPath: edit.parentPath,
          name,
          kind: edit.kind,
        });
        if (!payload) {
          return;
        }
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.createFailed"));
          return;
        }
        if (edit.kind === "file" && payload.path) {
          selectExplorerEntry(payload.path);
          onOpenFile?.({ path: payload.path });
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [createEntry, onOpenFile, pendingEdit, selectExplorerEntry, t, toast],
  );

  const reconcileRelocatedEntry = useCallback(
    async (entry: Pick<ExplorerEntry, "path" | "kind">, relocatedPath: string): Promise<void> => {
      const activeSelectionPath = selectedEntryPathRef.current;
      if (workspaceStateKey && entry.kind === "directory") {
        const expandedRelocatedPaths = Array.from(expandedPathsRef.current)
          .filter((expandedPath) => isExplorerPathWithin(expandedPath, entry.path))
          .map((expandedPath) =>
            replaceExplorerPathPrefix(expandedPath, entry.path, relocatedPath),
          );
        setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
          currentPaths.map((currentPath) =>
            isExplorerPathWithin(currentPath, entry.path)
              ? replaceExplorerPathPrefix(currentPath, entry.path, relocatedPath)
              : currentPath,
          ),
        );
        await Promise.all(
          expandedRelocatedPaths.map((expandedPath) =>
            requestDirectoryListing(expandedPath, {
              recordHistory: false,
              setCurrentPath: false,
            }),
          ),
        );
      }
      let selectionChanged = false;
      const relocatedPaths = new Set<string>();
      for (const selectedPath of selectedEntryPathsRef.current) {
        if (isExplorerPathWithin(selectedPath, entry.path)) {
          relocatedPaths.add(replaceExplorerPathPrefix(selectedPath, entry.path, relocatedPath));
          selectionChanged = true;
        } else {
          relocatedPaths.add(selectedPath);
        }
      }
      if (selectionChanged) {
        commitSelectedEntryPaths(relocatedPaths);
      }
      if (
        selectionAnchorPathRef.current &&
        isExplorerPathWithin(selectionAnchorPathRef.current, entry.path)
      ) {
        selectionAnchorPathRef.current = replaceExplorerPathPrefix(
          selectionAnchorPathRef.current,
          entry.path,
          relocatedPath,
        );
      }
      if (activeSelectionPath && isExplorerPathWithin(activeSelectionPath, entry.path)) {
        const relocatedSelection = replaceExplorerPathPrefix(
          activeSelectionPath,
          entry.path,
          relocatedPath,
        );
        selectExplorerEntry(relocatedSelection);
        if (entry.kind === "file") {
          onOpenFile?.({ path: relocatedSelection });
        }
      }
    },
    [
      commitSelectedEntryPaths,
      onOpenFile,
      requestDirectoryListing,
      selectExplorerEntry,
      setExpandedPathsForWorkspace,
      workspaceStateKey,
    ],
  );

  const handleRenameCommit = useCallback(
    async (name: string) => {
      const edit = pendingEdit;
      setPendingEdit(null);
      if (edit?.type !== "rename" || name === edit.entry.name) {
        return;
      }
      const { entry } = edit;
      try {
        const payload = await renameEntry({
          path: entry.path,
          name,
        });
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.renamedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.renameFailed"));
          return;
        }

        await reconcileRelocatedEntry(entry, payload.renamedPath);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [pendingEdit, reconcileRelocatedEntry, renameEntry, t, toast],
  );
  const handleMoveEntry = useCallback(
    async (requests: ExplorerEntryMoveRequest[]) => {
      const result = await moveExplorerSelection(requests, moveEntry, reconcileRelocatedEntry);
      if (result.failed) {
        toast.error(result.firstError ?? t("workspace.fileExplorer.errors.moveFailed"));
      }
      return result;
    },
    [moveEntry, reconcileRelocatedEntry, t, toast],
  );
  const rootDropTarget = useMemo(
    () =>
      fsEntryMoveEnabled && workspaceId
        ? {
            serverId,
            workspaceId,
            parentPath: ".",
            blockedDescendantSelector: FILE_EXPLORER_ROOT_DROP_BLOCKED_SELECTOR,
            onMove: handleMoveEntry,
          }
        : undefined,
    [fsEntryMoveEnabled, handleMoveEntry, serverId, workspaceId],
  );
  const rootDrag = useExplorerEntryDrag({ target: rootDropTarget });

  const handleDuplicateEntry = useCallback(
    async (entry: ExplorerEntry) => {
      try {
        const payload = await duplicateEntry(entry.path);
        if (!payload) {
          return;
        }
        if (!payload.success || !payload.duplicatedPath) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
          return;
        }
        selectExplorerEntry(payload.duplicatedPath);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [duplicateEntry, selectExplorerEntry, t, toast],
  );

  const handleDeleteEntry = useCallback(
    async (entry: ExplorerEntry) => {
      const currentSelection = selectedEntryPathsRef.current;
      const selectedPaths =
        currentSelection.has(entry.path) && currentSelection.size > 1
          ? [...currentSelection]
          : [entry.path];
      const isBatchDelete = selectedPaths.length > 1;
      let confirmationTitle: string;
      if (isBatchDelete) {
        confirmationTitle = t("workspace.fileActions.confirmDelete.selectionTitle", {
          count: selectedPaths.length,
        });
      } else if (entry.kind === "directory") {
        confirmationTitle = t("workspace.fileActions.confirmDelete.folderTitle");
      } else {
        confirmationTitle = t("workspace.fileActions.confirmDelete.fileTitle");
      }
      const confirmed = await confirmDialog({
        title: confirmationTitle,
        message: isBatchDelete
          ? t("workspace.fileActions.confirmDelete.selectionMessage", {
              count: selectedPaths.length,
            })
          : t("workspace.fileActions.confirmDelete.message", { name: entry.name }),
        confirmLabel: t("workspace.fileActions.confirmDelete.confirm"),
        cancelLabel: t("workspace.fileActions.confirmDelete.cancel"),
        destructive: true,
      });
      if (!confirmed) return;

      const deletionResult = await deleteExplorerSelectionPaths(selectedPaths, deleteEntry);
      if (deletionResult.failed) {
        toast.error(deletionResult.firstError ?? t("workspace.fileExplorer.errors.deleteFailed"));
      }
      const { deletedPaths } = deletionResult;
      if (deletedPaths.length === 0) return;

      const remainingSelection = new Set(
        [...selectedEntryPathsRef.current].filter(
          (selectedPath) =>
            !deletedPaths.some((deletedPath) => isExplorerPathWithin(selectedPath, deletedPath)),
        ),
      );
      commitSelectedEntryPaths(remainingSelection);
      const selectionAnchorPath = selectionAnchorPathRef.current;
      if (
        selectionAnchorPath &&
        deletedPaths.some((deletedPath) => isExplorerPathWithin(selectionAnchorPath, deletedPath))
      ) {
        selectionAnchorPathRef.current = null;
      }
      if (
        selectedEntryPath &&
        deletedPaths.some((deletedPath) => isExplorerPathWithin(selectedEntryPath, deletedPath))
      ) {
        selectExplorerEntry(remainingSelection.values().next().value ?? null);
      }
    },
    [commitSelectedEntryPaths, deleteEntry, selectExplorerEntry, selectedEntryPath, t, toast],
  );

  const handleSortCycle = useCallback(() => {
    const currentIndex = SORT_OPTIONS.findIndex((opt) => opt.value === sortOption);
    const nextIndex = (currentIndex + 1) % SORT_OPTIONS.length;
    setSortOption(SORT_OPTIONS[nextIndex].value);
  }, [sortOption, setSortOption]);

  const handleToggleHiddenFiles = useCallback(() => {
    const willShow = !usePanelStore.getState().explorerShowHiddenFiles;
    if (!willShow) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    const rootDirectory = renderDataRef.current.directories.get(".");
    if (!rootDirectory || !workspaceStateKey) {
      toggleExplorerShowHiddenFiles();
      return;
    }
    const expandedSnapshot = expandedPathsRef.current;
    void showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: expandedSnapshot,
      showHiddenFiles: toggleExplorerShowHiddenFiles,
      requestDirectoryListing: (path) =>
        requestDirectoryListing(path, {
          recordHistory: false,
          setCurrentPath: false,
        }),
    }).then((restoredPaths) => {
      setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
        reconcileRestoredExpandedPaths({
          persistedExpandedPaths: expandedSnapshot,
          currentExpandedPaths: new Set(currentPaths),
          restoredExpandedPaths: restoredPaths,
        }),
      );
      return null;
    });
  }, [
    requestDirectoryListing,
    setExpandedPathsForWorkspace,
    toggleExplorerShowHiddenFiles,
    workspaceStateKey,
  ]);

  const refreshExplorer = useCallback(
    () =>
      refreshExplorerDirectories({
        hasWorkspaceScope,
        expandedPaths: expandedPathsRef.current,
        requestDirectoryListing,
      }),
    [hasWorkspaceScope, requestDirectoryListing],
  );
  const { refetch: refetchExplorer, isFetching: isRefreshFetching } = useQuery({
    // A completion during the first in-flight refresh must not reuse its older listing.
    queryKey: [
      "fileExplorerRefresh",
      serverId,
      workspaceStateKey,
      normalizedWorkspaceRoot,
      refreshRevision,
    ],
    queryFn: refreshExplorer,
    enabled: false,
    // A retired refresh query must not keep this pane's captured listings alive.
    gcTime: 0,
  });
  useEffect(() => {
    if (!isActive) return;
    const observed = observedRefreshRef.current;
    if (
      observed.serverId !== serverId ||
      observed.workspaceStateKey !== workspaceStateKey ||
      observed.workspaceRoot !== normalizedWorkspaceRoot
    ) {
      observed.serverId = serverId;
      observed.workspaceStateKey = workspaceStateKey;
      observed.workspaceRoot = normalizedWorkspaceRoot;
      observed.revision = refreshRevision;
      return;
    }
    if (refreshRevision <= observed.revision) return;
    observed.revision = refreshRevision;
    void refetchExplorer();
  }, [
    isActive,
    normalizedWorkspaceRoot,
    refreshRevision,
    refetchExplorer,
    serverId,
    workspaceStateKey,
  ]);

  const handleRefresh = useCallback(() => {
    void refetchExplorer();
  }, [refetchExplorer]);

  const sortLabels = useMemo(
    () => ({
      name: t("workspace.fileExplorer.sort.name"),
      modified: t("workspace.fileExplorer.sort.modified"),
      size: t("workspace.fileExplorer.sort.size"),
    }),
    [t],
  );
  const currentSortLabel = resolveCurrentSortLabel(sortOption, sortLabels);

  const resolveMoveToDirectory = useCallback(
    (parentPath: string) => {
      const entries = moveEntriesRef.current;
      return workspaceId && entries
        ? resolveExplorerEntryMoves({
            payload: { version: 1, serverId, workspaceId, entries },
            serverId,
            workspaceId,
            parentPath,
          })
        : null;
    },
    [serverId, workspaceId],
  );
  const handleMoveToDirectory = useCallback(
    async (parentPath: string) => {
      const requests = resolveMoveToDirectory(parentPath);
      if (!requests || moveInFlightRef.current) return;
      moveInFlightRef.current = true;
      setIsMoving(true);
      try {
        const result = await handleMoveEntry(requests);
        setMoveEntries((current) => removeMovedExplorerEntries(current, result.movedPaths));
      } finally {
        moveInFlightRef.current = false;
        setIsMoving(false);
      }
    },
    [handleMoveEntry, resolveMoveToDirectory],
  );
  const handleToggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => !current);
    setMoveEntries(null);
  }, []);
  const handleStartMove = useCallback(() => {
    setSelectionMode(true);
    setMoveEntries(renderDataRef.current.selectedDragEntries);
  }, []);
  const handleMoveToRoot = useCallback(() => {
    void handleMoveToDirectory(".");
  }, [handleMoveToDirectory]);
  const handleCancelMove = useCallback(() => setMoveEntries(null), []);
  const handleToggleSelection = useCallback(
    (entry: ExplorerEntry) => {
      const result = resolveExplorerSelection({
        path: entry.path,
        visiblePaths: renderDataRef.current.visibleEntryPaths,
        selectedPaths: selectedEntryPathsRef.current,
        anchorPath: selectionAnchorPathRef.current,
        additive: true,
        range: false,
      });
      selectionAnchorPathRef.current = result.anchorPath;
      commitSelectedEntryPaths(result.selectedPaths);
      selectExplorerEntry(result.activePath);
    },
    [commitSelectedEntryPaths, selectExplorerEntry],
  );
  const isMoveMode = moveEntries !== null;
  const touchControls = useMemo<ExplorerTouchControls>(
    () => ({
      selectionMode,
      onToggleSelection: handleToggleSelection,
      onMoveToDirectory: isMoveMode ? handleMoveToDirectory : undefined,
      canMoveToDirectory: (path) => Boolean(resolveMoveToDirectory(path)),
      moving: isMoving,
    }),
    [
      handleMoveToDirectory,
      handleToggleSelection,
      isMoving,
      isMoveMode,
      resolveMoveToDirectory,
      selectionMode,
    ],
  );

  const handleSelectEntry = useCallback(
    (entry: ExplorerEntry) => {
      if (!hasWorkspaceScope) return;
      if (selectedEntryPathsRef.current.has(entry.path)) {
        selectExplorerEntry(entry.path);
        return;
      }
      const next = new Set([entry.path]);
      selectionAnchorPathRef.current = entry.path;
      commitSelectedEntryPaths(next);
      selectExplorerEntry(entry.path);
    },
    [commitSelectedEntryPaths, hasWorkspaceScope, selectExplorerEntry],
  );

  const handleEntryPress = useCallback(
    (entry: ExplorerEntry, event: GestureResponderEvent) => {
      if (!hasWorkspaceScope) return;
      if (moveEntriesRef.current || selectionMode) {
        if (entry.kind === "directory") handleToggleDirectory(entry);
        else if (!moveEntriesRef.current) handleToggleSelection(entry);
        return;
      }
      const modifiers = getExplorerPressModifiers(event);
      const result = resolveExplorerSelection({
        path: entry.path,
        visiblePaths: renderDataRef.current.visibleEntryPaths,
        selectedPaths: selectedEntryPathsRef.current,
        anchorPath: selectionAnchorPathRef.current,
        additive: modifiers.additive,
        range: modifiers.range,
      });
      selectionAnchorPathRef.current = result.anchorPath;
      commitSelectedEntryPaths(result.selectedPaths);
      selectExplorerEntry(result.activePath);

      if (modifiers.additive || modifiers.range) return;
      if (entry.kind === "directory") {
        handleToggleDirectory(entry);
        return;
      }
      handleOpenFile(entry);
    },
    [
      commitSelectedEntryPaths,
      selectionMode,
      handleToggleSelection,
      handleOpenFile,
      handleToggleDirectory,
      hasWorkspaceScope,
      selectExplorerEntry,
    ],
  );

  const [entryRowHeight, setEntryRowHeight] = useState(0);
  const [inputRowHeight, setInputRowHeight] = useState(0);
  const handleEntryRowLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    // Move mode removes the action rail from files, so its rows are not uniform.
    if (height > 0 && !moveEntriesRef.current) setEntryRowHeight(height);
  }, []);
  const handleInputRowLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setInputRowHeight(height);
  }, []);

  const showInitialLoading = resolveShowInitialLoading({
    directories,
    isExplorerLoading,
    pendingRequest,
  });
  const showBackFromError = Boolean(error && selectedEntryPath);

  const renderTreeRow = useCallback(
    (info: ListRenderItemInfo<ExplorerListRow>) => {
      if (info.item.type === "draft") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.kind}
            onCommit={handleDraftCommit}
            onCancel={handleEditCancel}
            onLayout={handleInputRowLayout}
          />
        );
      }
      if (info.item.type === "rename") {
        return (
          <EntryNameInputRow
            depth={info.item.depth}
            kind={info.item.entry.kind}
            initialName={info.item.entry.name}
            onCommit={handleRenameCommit}
            onCancel={handleEditCancel}
            onLayout={handleInputRowLayout}
          />
        );
      }
      return (
        <TreeRowDispatcher
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={normalizedWorkspaceRoot}
          row={info.item.row}
          index={info.index}
          expandedPaths={expandedPathsRef.current}
          selectedEntryPaths={selectedEntryPathsRef.current}
          isDirectoryLoading={isDirectoryLoading}
          onEntryPress={handleEntryPress}
          onSelectEntry={handleSelectEntry}
          onCopyPath={handleCopyPath}
          onCopyRelativePath={handleCopyRelativePath}
          onRevealEntry={fileManagerTarget ? handleRevealEntry : undefined}
          revealTargetName={fileManagerTarget?.label}
          onDownloadEntry={handleDownloadEntry}
          onAddToChat={onAddToChat}
          onAddDirectoryToChat={onAddDirectoryToChat ? handleAddDirectoryToChat : undefined}
          onNewEntry={fsEntryOpsEnabled ? handleNewEntry : undefined}
          onCollapseDirectory={handleCollapseDirectory}
          onRenameEntry={fsEntryOpsEnabled ? handleRenameEntry : undefined}
          onMoveEntry={fsEntryMoveEnabled ? handleMoveEntry : undefined}
          selectedEntries={renderDataRef.current.selectedDragEntries}
          touchControls={touchControls}
          onLayout={handleEntryRowLayout}
          onDuplicateEntry={fsEntryDuplicateEnabled ? handleDuplicateEntry : undefined}
          onDeleteEntry={fsEntryOpsEnabled ? handleDeleteEntry : undefined}
        />
      );
    },
    [
      handleEntryRowLayout,
      handleInputRowLayout,
      fsEntryDuplicateEnabled,
      fsEntryMoveEnabled,
      fsEntryOpsEnabled,
      handleCollapseDirectory,
      handleCopyPath,
      handleCopyRelativePath,
      handleDeleteEntry,
      handleDownloadEntry,
      handleDraftCommit,
      handleDuplicateEntry,
      handleEditCancel,
      handleAddDirectoryToChat,
      handleEntryPress,
      handleNewEntry,
      handleRenameCommit,
      handleMoveEntry,
      handleRenameEntry,
      touchControls,
      handleRevealEntry,
      handleSelectEntry,
      isDirectoryLoading,
      fileManagerTarget,
      onAddToChat,
      onAddDirectoryToChat,
      serverId,
      workspaceId,
      normalizedWorkspaceRoot,
    ],
  );

  const handleBackFromError = useCallback(() => {
    if (!hasWorkspaceScope) {
      return;
    }
    selectExplorerEntry(null);
    void requestDirectoryListing(errorRecoveryPath, {
      recordHistory: false,
      setCurrentPath: true,
    });
  }, [errorRecoveryPath, hasWorkspaceScope, requestDirectoryListing, selectExplorerEntry]);

  const handleRetry = useCallback(() => {
    void requestDirectoryListing(".", {
      recordHistory: false,
      setCurrentPath: false,
    });
  }, [requestDirectoryListing]);

  const toolbarIconButtonStyle = useCallback(
    (state: PressableStateCallbackType) => iconButtonStyle(isCompact, state),
    [isCompact],
  );

  if (!hasWorkspaceScope) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{t("workspace.fileExplorer.states.unavailable")}</Text>
      </View>
    );
  }

  return (
    <View
      {...{
        onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
      }}
      style={styles.container}
    >
      <ExplorerSelectionToolbar
        selectionMode={selectionMode}
        selectedCount={selectedEntryPaths.size}
        selectedDragEntryCount={selectedDragEntries.length}
        moveEntries={moveEntries}
        moveEnabled={Boolean(fsEntryMoveEnabled && workspaceId)}
        moving={isMoving}
        canMoveToRoot={Boolean(resolveMoveToDirectory("."))}
        onToggleSelectionMode={handleToggleSelectionMode}
        onStartMove={handleStartMove}
        onMoveToRoot={handleMoveToRoot}
        onCancelMove={handleCancelMove}
      />
      <FileExplorerPaneContent
        serverId={serverId}
        workspaceRoot={normalizedWorkspaceRoot}
        onOpenFile={onOpenFile}
        workspaceTextSearchEnabled={workspaceTextSearchEnabled}
        error={error}
        isCompact={isCompact}
        showInitialLoading={showInitialLoading}
        showBackFromError={showBackFromError}
        listRows={listRows}
        entryRowHeight={moveEntries ? 0 : entryRowHeight}
        inputRowHeight={inputRowHeight}
        selectedEntryPaths={selectedEntryPaths}
        onNewEntryAtRoot={fsEntryOpsEnabled ? handleNewEntry : undefined}
        rootDropTargetRef={rootDrag.ref}
        isRootDropTarget={rootDrag.isDropTarget}
        currentSortLabel={currentSortLabel}
        isRefreshFetching={isRefreshFetching}
        treeListRef={treeListRef}
        scrollReveal={scrollReveal}
        scrollbar={scrollbar}
        renderTreeRow={renderTreeRow}
        handleSortCycle={handleSortCycle}
        handleToggleHiddenFiles={handleToggleHiddenFiles}
        handleRefresh={handleRefresh}
        handleBackFromError={handleBackFromError}
        handleRetry={handleRetry}
        sortTriggerStyle={sortTriggerStyle}
        iconButtonStyle={toolbarIconButtonStyle}
      />
    </View>
  );
}

interface WebContextMenuEvent {
  nativeEvent: { pageX: number; pageY: number };
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

function isFileExplorerRowTarget(target: unknown): boolean {
  if (!isWeb || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return target.closest(FILE_EXPLORER_ROW_SELECTOR) !== null;
}

function RootCreationContextTarget({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const contextMenu = useContextMenu();
  const handleContextMenu = useCallback(
    (event: WebContextMenuEvent) => {
      if (!enabled || isFileExplorerRowTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      contextMenu.setAnchorRect({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 0,
        height: 0,
      });
      contextMenu.setOpen(true);
    },
    [contextMenu, enabled],
  );

  return (
    <View
      {...{ onContextMenu: handleContextMenu }}
      style={styles.rootContextTarget}
      testID="files-empty-area"
    >
      {children}
    </View>
  );
}

interface FileExplorerPaneContentProps {
  serverId: string;
  workspaceRoot: string;
  onOpenFile?: (location: WorkspaceFileLocation) => void;
  workspaceTextSearchEnabled: boolean;
  error: string | null;
  isCompact: boolean;
  showInitialLoading: boolean;
  showBackFromError: boolean;
  listRows: ExplorerListRow[];
  entryRowHeight: number;
  inputRowHeight: number;
  selectedEntryPaths: ReadonlySet<string>;
  onNewEntryAtRoot?: (parentPath: string, kind: "file" | "directory") => void;
  rootDropTargetRef?: RefCallback<View>;
  isRootDropTarget: boolean;
  currentSortLabel: string;
  isRefreshFetching: boolean;
  treeListRef: RefObject<FlatList<ExplorerListRow> | null>;
  scrollReveal: { path: string; revision: number } | null;
  scrollbar: OverlayFlatListScrollbar;
  renderTreeRow: (info: ListRenderItemInfo<ExplorerListRow>) => ReactElement;
  handleSortCycle: () => void;
  handleToggleHiddenFiles: () => void;
  handleRefresh: () => void;
  handleBackFromError: () => void;
  handleRetry: () => void;
  sortTriggerStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  iconButtonStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
}

function FileExplorerPaneContent(props: FileExplorerPaneContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    serverId,
    workspaceRoot,
    onOpenFile,
    workspaceTextSearchEnabled,
    error,
    isCompact,
    showInitialLoading,
    showBackFromError,
    listRows,
    entryRowHeight,
    inputRowHeight,
    selectedEntryPaths,
    onNewEntryAtRoot,
    rootDropTargetRef,
    isRootDropTarget,
    currentSortLabel,
    isRefreshFetching,
    treeListRef,
    scrollReveal,
    scrollbar,
    renderTreeRow,
    handleSortCycle,
    handleToggleHiddenFiles,
    handleRefresh,
    handleBackFromError,
    handleRetry,
    sortTriggerStyle: sortTriggerStyleProp,
    iconButtonStyle: iconButtonStyleProp,
  } = props;

  const inputRowIndex = useMemo(
    () => listRows.findIndex((row) => row.type !== "entry"),
    [listRows],
  );
  // Measure intrinsic rows instead of assuming desktop font/touch-control sizes.
  // There is at most one create/rename input, whose height differs from the action rail.
  const getItemLayout = useMemo(() => {
    if (entryRowHeight <= 0 || (inputRowIndex >= 0 && inputRowHeight <= 0)) return undefined;
    return (_data: ArrayLike<ExplorerListRow> | null | undefined, index: number) => ({
      index,
      length: index === inputRowIndex ? inputRowHeight : entryRowHeight,
      offset:
        theme.spacing[2] +
        index * entryRowHeight +
        (inputRowIndex >= 0 && index > inputRowIndex ? inputRowHeight - entryRowHeight : 0),
    });
  }, [entryRowHeight, inputRowHeight, inputRowIndex, theme.spacing]);

  const showHiddenFiles = usePanelStore((state) => state.explorerShowHiddenFiles);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (scrollReveal) setSearchOpen(false);
  }, [scrollReveal]);
  const pendingRevealRef = useRef<{ index: number; revision: number } | null>(null);
  const lastRequestedRevealRevision = useRef<number | null>(null);
  const revealFrameRef = useRef<number | null>(null);
  const scrollRevealedRow = useCallback(() => {
    revealFrameRef.current = null;
    const pending = pendingRevealRef.current;
    const list = treeListRef.current;
    if (!pending || !list) return;

    if (isWeb) {
      const scrollNode = list.getScrollableNode();
      if (scrollNode instanceof HTMLElement) {
        const viewport = scrollNode.getBoundingClientRect();
        if (viewport.width === 0 || viewport.height === 0) {
          pendingRevealRef.current = null;
          return;
        }
        const row = scrollNode.querySelector<HTMLElement>(
          `[data-testid="file-explorer-row-${pending.index}"]`,
        );
        if (row) {
          const bounds = row.getBoundingClientRect();
          if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) {
            pendingRevealRef.current = null;
            return;
          }
          scrollNode.scrollTop += bounds.top - viewport.top - (viewport.height - bounds.height) / 2;
        } else {
          // Virtualized rows are not in the DOM until the list reaches them.
          list.scrollToIndex({ index: pending.index, viewPosition: 0.5, animated: false });
        }
      } else {
        list.scrollToIndex({ index: pending.index, viewPosition: 0.5, animated: false });
      }
    } else {
      list.scrollToIndex({ index: pending.index, viewPosition: 0.5, animated: false });
    }
    if (pendingRevealRef.current) {
      revealFrameRef.current = requestAnimationFrame(scrollRevealedRow);
    }
  }, [treeListRef]);
  const handleRevealScrollFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (pendingRevealRef.current?.index !== info.index) return;
      treeListRef.current?.scrollToOffset({
        offset: info.index * info.averageItemLength,
        animated: false,
      });
    },
    [treeListRef],
  );
  const handleRevealViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      if (!isWeb && viewableItems.some((item) => item.index === pendingRevealRef.current?.index)) {
        pendingRevealRef.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    if (!scrollReveal || error) {
      pendingRevealRef.current = null;
      return;
    }
    if (
      showInitialLoading ||
      searchOpen ||
      lastRequestedRevealRevision.current === scrollReveal.revision
    )
      return;
    const index = listRows.findIndex(
      (row) => row.type === "entry" && row.row.entry.path === scrollReveal.path,
    );
    if (index < 0) return;
    lastRequestedRevealRevision.current = scrollReveal.revision;
    pendingRevealRef.current = { index, revision: scrollReveal.revision };
    if (revealFrameRef.current === null) {
      revealFrameRef.current = requestAnimationFrame(scrollRevealedRow);
    }
  }, [error, listRows, scrollReveal, scrollRevealedRow, searchOpen, showInitialLoading]);
  useEffect(
    () => () => {
      if (revealFrameRef.current !== null) cancelAnimationFrame(revealFrameRef.current);
    },
    [],
  );

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);
  const handleOpenLegacySearchFile = useCallback(
    (path: string) => onOpenFile?.({ path }),
    [onOpenFile],
  );

  const handleNewFileAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "file");
  }, [onNewEntryAtRoot]);
  const handleNewFolderAtRoot = useCallback(() => {
    onNewEntryAtRoot?.(".", "directory");
  }, [onNewEntryAtRoot]);

  const hiddenFilesToggleAccessibilityLabel = showHiddenFiles
    ? t("workspace.fileExplorer.actions.hideHiddenFiles")
    : t("workspace.fileExplorer.actions.showHiddenFiles");
  const emptyLabel = showHiddenFiles
    ? t("workspace.fileExplorer.empty.noFiles")
    : t("workspace.fileExplorer.empty.noVisibleFiles");
  const hiddenFilesToggleStyle = useCallback(
    (state: PressableStateCallbackType) => [
      iconButtonStyleProp(state),
      !showHiddenFiles && styles.iconButtonActive,
    ],
    [showHiddenFiles, iconButtonStyleProp],
  );
  const hiddenFilesToggleAccessibilityState = useMemo(
    () => ({ selected: !showHiddenFiles }),
    [showHiddenFiles],
  );

  if (error) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>{error}</Text>
        <View style={styles.errorActions}>
          {showBackFromError ? (
            <Pressable style={styles.retryButton} onPress={handleBackFromError}>
              <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.back")}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryButtonText}>{t("workspace.fileExplorer.actions.retry")}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (showInitialLoading) {
    return (
      <View style={styles.centerState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        <Text style={styles.loadingText}>{t("workspace.fileExplorer.states.loading")}</Text>
      </View>
    );
  }

  if (searchOpen) {
    return workspaceTextSearchEnabled ? (
      <FileExplorerContentSearch
        key={`${serverId}\0${workspaceRoot}`}
        serverId={serverId}
        workspaceRoot={workspaceRoot}
        isCompact={isCompact}
        onOpenFile={onOpenFile}
        onClose={handleCloseSearch}
      />
    ) : (
      <FileExplorerSearch
        key={`${serverId}\0${workspaceRoot}`}
        serverId={serverId}
        workspaceRoot={workspaceRoot}
        isCompact={isCompact}
        onOpenFile={handleOpenLegacySearchFile}
        onClose={handleCloseSearch}
      />
    );
  }

  return (
    <View
      ref={rootDropTargetRef}
      style={[styles.treePane, styles.treePaneFill, isRootDropTarget && styles.rootDropTarget]}
    >
      <PaneContentToolbar style={styles.paneHeader} testID="files-pane-header">
        <Pressable
          onPress={handleSortCycle}
          style={sortTriggerStyleProp}
          testID="files-sort-trigger"
        >
          <Text style={styles.sortTriggerText} testID="files-sort-label">
            {currentSortLabel}
          </Text>
          <ChevronDown size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleOpenSearch}
            hitSlop={8}
            style={iconButtonStyleProp}
            accessibilityRole="button"
            accessibilityLabel={
              workspaceTextSearchEnabled
                ? t("workspace.fileExplorer.contentSearch.placeholder")
                : t("shell.commandCenter.filePlaceholder")
            }
            testID="files-search"
          >
            <Search
              size={paneContentToolbarIconSize(isCompact)}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
          {onNewEntryAtRoot ? (
            <>
              <Pressable
                onPress={handleNewFileAtRoot}
                hitSlop={8}
                style={iconButtonStyleProp}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.fileActions.newFile")}
                testID="files-new-file"
              >
                <FilePlus
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                onPress={handleNewFolderAtRoot}
                hitSlop={8}
                style={iconButtonStyleProp}
                accessibilityRole="button"
                accessibilityLabel={t("workspace.fileActions.newFolder")}
                testID="files-new-folder"
              >
                <FolderPlus
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
            </>
          ) : null}
          <Pressable
            onPress={handleToggleHiddenFiles}
            hitSlop={8}
            style={hiddenFilesToggleStyle}
            accessibilityRole="button"
            accessibilityLabel={hiddenFilesToggleAccessibilityLabel}
            accessibilityState={hiddenFilesToggleAccessibilityState}
            testID="files-hidden-toggle"
          >
            {showHiddenFiles ? (
              <Eye
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundMuted}
              />
            ) : (
              <EyeOff
                size={paneContentToolbarIconSize(isCompact)}
                color={theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
          <Pressable
            onPress={handleRefresh}
            disabled={isRefreshFetching}
            hitSlop={8}
            style={iconButtonStyleProp}
            accessibilityRole="button"
            accessibilityLabel={
              isRefreshFetching
                ? t("workspace.fileExplorer.actions.refreshing")
                : t("workspace.fileExplorer.actions.refresh")
            }
            testID="files-refresh"
          >
            <View style={styles.refreshIcon}>
              {isRefreshFetching ? (
                <LoadingSpinner
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundMuted}
                />
              ) : (
                <RotateCw
                  size={paneContentToolbarIconSize(isCompact)}
                  color={theme.colors.foregroundMuted}
                />
              )}
            </View>
          </Pressable>
        </View>
      </PaneContentToolbar>
      <ContextMenu>
        <RootCreationContextTarget enabled={Boolean(onNewEntryAtRoot)}>
          {listRows.length === 0 ? (
            <View style={styles.centerState}>
              <Text style={styles.emptyText}>{emptyLabel}</Text>
            </View>
          ) : (
            <FlatList
              ref={treeListRef}
              onScrollToIndexFailed={handleRevealScrollFailed}
              onViewableItemsChanged={handleRevealViewableItemsChanged}
              style={styles.treeList}
              data={listRows}
              extraData={selectedEntryPaths}
              renderItem={renderTreeRow}
              strictMode
              keyExtractor={listRowKeyExtractor}
              getItemLayout={getItemLayout}
              testID="file-explorer-tree-scroll"
              contentContainerStyle={styles.entriesContent}
              onLayout={scrollbar.onLayout}
              onScroll={scrollbar.onScroll}
              onContentSizeChange={scrollbar.onContentSizeChange}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={!scrollbar.enabled}
              initialNumToRender={24}
              maxToRenderPerBatch={40}
              windowSize={5}
            />
          )}
          {listRows.length > 0 ? scrollbar.overlay : null}
        </RootCreationContextTarget>
        {onNewEntryAtRoot ? (
          <FileActionsContextMenuContent
            fileKind="directory"
            onNewFile={handleNewFileAtRoot}
            onNewFolder={handleNewFolderAtRoot}
            testIDPrefix="files-empty-area"
          />
        ) : null}
      </ContextMenu>
    </View>
  );
}

function deriveExplorerFields(state: AgentFileExplorerState | undefined) {
  return {
    directories:
      state?.directories ?? new Map<string, { path: string; entries: ExplorerEntry[] }>(),
    pendingRequest: state?.pendingRequest ?? null,
    isExplorerLoading: state?.isLoading ?? false,
    error: state?.lastError ?? null,
    selectedEntryPath: state?.selectedEntryPath ?? null,
  };
}

function isPendingListForPath({
  isExplorerLoading,
  pendingRequest,
  path,
}: {
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
  path: string;
}): boolean {
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === path,
  );
}

function resolveShowInitialLoading({
  directories,
  isExplorerLoading,
  pendingRequest,
}: {
  directories: Map<string, unknown>;
  isExplorerLoading: boolean;
  pendingRequest: AgentFileExplorerState["pendingRequest"] | null;
}): boolean {
  if (directories.has(".")) {
    return false;
  }
  return Boolean(
    isExplorerLoading && pendingRequest?.mode === "list" && pendingRequest?.path === ".",
  );
}

function resolveCurrentSortLabel(
  sortOption: SortOption,
  labels: Record<SortOption, string>,
): string {
  return labels[sortOption] ?? labels.name;
}

function toggleDirectory({
  entry,
  workspaceStateKey,
  expandedPaths,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  entry: ExplorerEntry;
  workspaceStateKey: string | null;
  expandedPaths: Set<string>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): void {
  if (!workspaceStateKey) {
    return;
  }
  const isExpanded = expandedPaths.has(entry.path);
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    setExpandedDirectoryPath({
      currentExpandedPaths: currentPaths,
      directoryPath: entry.path,
      expanded: !isExpanded,
    }),
  );
  // Cached children may have changed while this directory was collapsed.
  if (!isExpanded) {
    void requestDirectoryListing(entry.path, {
      recordHistory: false,
      setCurrentPath: false,
    });
  }
}

function TreeRowDispatcher({
  serverId,
  workspaceId,
  workspaceRoot,
  row,
  index,
  expandedPaths,
  selectedEntryPaths,
  isDirectoryLoading,
  onEntryPress,
  onSelectEntry,
  onCopyPath,
  onCopyRelativePath,
  onRevealEntry,
  revealTargetName,
  onDownloadEntry,
  onAddToChat,
  onAddDirectoryToChat,
  onNewEntry,
  onCollapseDirectory,
  onRenameEntry,
  onDuplicateEntry,
  onDeleteEntry,
  onMoveEntry,
  selectedEntries,
  touchControls,
  onLayout,
}: {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  row: ExplorerTreeRow;
  index: number;
  expandedPaths: Set<string>;
  selectedEntryPaths: ReadonlySet<string>;
  isDirectoryLoading: (path: string) => boolean;
  onEntryPress: (entry: ExplorerEntry, event: GestureResponderEvent) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onCopyPath: (path: string) => void | Promise<void>;
  onCopyRelativePath: (path: string) => void | Promise<void>;
  onRevealEntry?: (entry: ExplorerEntry) => void;
  revealTargetName?: string;
  onDownloadEntry: (entry: ExplorerEntry) => void;
  onAddToChat?: (path: string) => void;
  onAddDirectoryToChat?: (path: string) => void;
  onNewEntry?: (parentPath: string, kind: "file" | "directory") => void;
  onCollapseDirectory?: (path: string) => void;
  onRenameEntry?: (entry: ExplorerEntry) => void;
  onDuplicateEntry?: (entry: ExplorerEntry) => void;
  onDeleteEntry?: (entry: ExplorerEntry) => void;
  onMoveEntry?: (requests: ExplorerEntryMoveRequest[]) => void;
  selectedEntries?: readonly ExplorerEntryDragItem[];
  touchControls: ExplorerTouchControls;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const entry = row.entry;
  const depth = row.depth;
  const isDirectory = entry.kind === "directory";
  const isExpanded = isDirectory && expandedPaths.has(entry.path);
  const isSelected = selectedEntryPaths.has(entry.path);
  const loading = isDirectory && isDirectoryLoading(entry.path);

  return (
    <TreeRowItem
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      entry={entry}
      depth={depth}
      isExpanded={isExpanded}
      isSelected={isSelected}
      loading={loading}
      onEntryPress={onEntryPress}
      onSelectEntry={onSelectEntry}
      onCopyPath={onCopyPath}
      onCopyRelativePath={onCopyRelativePath}
      onRevealEntry={onRevealEntry}
      revealTargetName={revealTargetName}
      onDownloadEntry={onDownloadEntry}
      onAddToChat={onAddToChat}
      onAddDirectoryToChat={onAddDirectoryToChat}
      onNewEntry={onNewEntry}
      onCollapseDirectory={onCollapseDirectory}
      onRenameEntry={onRenameEntry}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
      onMoveEntry={onMoveEntry}
      selectedEntries={selectedEntries}
      touchControls={touchControls}
      onLayout={onLayout}
      testID={`file-explorer-row-${index}`}
    />
  );
}

function isExplorerPathWithin(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function replaceExplorerPathPrefix(
  candidatePath: string,
  previousPrefix: string,
  nextPrefix: string,
): string {
  return `${nextPrefix}${candidatePath.slice(previousPrefix.length)}`;
}

async function initializeExplorer({
  isCancelled,
  workspaceStateKey,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
  setExpandedPathsForWorkspace,
}: {
  isCancelled: () => boolean;
  workspaceStateKey: string | null;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
  setExpandedPathsForWorkspace: (workspaceStateKey: string, paths: ExpandedPathsUpdate) => void;
}): Promise<boolean> {
  if (!workspaceStateKey || isCancelled()) return false;
  const rootDirectory = await requestDirectoryListing(".", {
    recordHistory: false,
    setCurrentPath: false,
  });
  if (isCancelled() || !rootDirectory) return false;

  const restoredPaths = await restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles,
    requestDirectoryListing: (path) =>
      isCancelled()
        ? Promise.resolve(null)
        : requestDirectoryListing(path, {
            recordHistory: false,
            setCurrentPath: false,
          }),
  });
  if (isCancelled()) return false;
  const hiddenPersistedPaths = showHiddenFiles
    ? []
    : Array.from(persistedExpandedPaths).filter(isHiddenExplorerPath);
  const restoredPathsWithHidden = [...restoredPaths, ...hiddenPersistedPaths];
  setExpandedPathsForWorkspace(workspaceStateKey, (currentPaths) =>
    reconcileRestoredExpandedPaths({
      persistedExpandedPaths,
      currentExpandedPaths: new Set(currentPaths),
      restoredExpandedPaths: restoredPathsWithHidden,
    }),
  );
  return true;
}

async function refreshExplorerDirectories({
  hasWorkspaceScope,
  expandedPaths,
  requestDirectoryListing,
}: {
  hasWorkspaceScope: boolean;
  expandedPaths: Set<string>;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<ExplorerDirectory | null>;
}): Promise<null> {
  if (!hasWorkspaceScope) {
    return null;
  }
  const showHiddenFiles = usePanelStore.getState().explorerShowHiddenFiles;
  const directoryPaths = Array.from(expandedPaths).filter(
    (path) => showHiddenFiles || !isHiddenExplorerPath(path),
  );
  if (!directoryPaths.includes(".")) {
    directoryPaths.unshift(".");
  }
  await Promise.all(
    directoryPaths.map((path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
    ),
  );
  return null;
}

function getErrorRecoveryPath(state: AgentFileExplorerState | undefined): string {
  if (!state) {
    return ".";
  }

  const currentHistoryPath =
    state.history.length > 0 ? state.history[state.history.length - 1] : null;
  const candidate = currentHistoryPath ?? state.lastVisitedPath ?? state.currentPath;

  if (!candidate || candidate.length === 0) {
    return ".";
  }
  return candidate;
}

const styles = StyleSheet.create((theme) => ({
  selectionToolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  selectionAction: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  rowAction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  compactRowAction: {
    minWidth: 28,
    minHeight: 20,
  },
  disabledAction: {
    opacity: 0.4,
  },
  container: {
    flex: 1,
  },
  desktopSplit: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  treePane: {
    minWidth: 0,
    position: "relative",
  },
  treePaneFill: {
    flex: 1,
  },
  treePaneWithPreview: {
    flex: 0,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  splitResizeHandle: {
    position: "absolute",
    left: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 20,
  },
  previewPane: {
    flex: 1,
    minWidth: 0,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[3],
  },
  sortTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    marginLeft: theme.spacing[3] - theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    height: 24,
    borderRadius: theme.borderRadius.base,
  },
  sortTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  sortTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  treeList: {
    flex: 1,
    minHeight: 0,
  },
  entriesContent: {
    flexGrow: 1,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  rootContextTarget: {
    flex: 1,
    minHeight: 0,
  },
  rootDropTarget: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    outlineColor: theme.colors.accent,
    outlineOffset: -2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  retryButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  errorActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  binaryMetaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  entryPressTarget: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    alignItems: "center",
    flexDirection: "row",
  },
  entryInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    minWidth: 0,
  },
  entryIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  entryName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    userSelect: "none",
  },
  entryDropTarget: {
    backgroundColor: theme.colors.surface2,
  },
  draftInput: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  draftPlaceholder: {
    color: theme.colors.foregroundExtraMuted,
  },
  contextMetaBlock: {
    paddingVertical: theme.spacing[1],
  },
  contextMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
  },
  contextMetaLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  contextMetaValue: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  previewHeaderText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  refreshIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  previewContent: {
    flex: 1,
  },
  previewScrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  previewCodeScrollContent: {
    paddingTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3] + theme.spacing[2],
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    flexShrink: 0,
  },
  previewImageScrollContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[3],
  },
  previewImage: {
    width: "100%",
    aspectRatio: 1,
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface2,
  },
  handleIndicator: {
    backgroundColor: theme.colors.palette.zinc[600],
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flex: 1,
  },
  sheetCloseButton: {
    padding: theme.spacing[2],
  },
  sheetCenterState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
}));
