import { createElement, useState, useCallback, useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { TreeRail } from "@/components/tree-rail";
import { TreeRailToggle } from "@/components/tree-rail-toggle";
import {
  View,
  Text,
  Pressable,
  FlatList,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  AlignJustify,
  ChevronDown,
  ChevronLeft,
  Columns2,
  GitCompareArrows,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Minus,
  Pilcrow,
  RotateCw,
  Plus,
  WrapText,
  Undo2,
} from "lucide-react-native";
import { useCheckoutDiffQuery, type ParsedDiffFile } from "@/git/use-diff-query";
import type { ChangesState } from "@/panels/changes/state";
import { defaultChangesState } from "@/panels/changes/state";
import { DiffDocument, type WorkingDiffMode } from "@/git/diff-document";
import { FileHeader } from "@/git/file-header";
import {
  buildDiffTree,
  collectDirPaths,
  compressSingleChildChains,
  flattenDiffTree,
  type DiffTreeRow,
} from "@/git/diff-tree";
import { DiffFolderRow } from "@/git/diff-folder-row";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { CommitsSection } from "@/git/commits-section/commits-section";
import { useAppSettings } from "@/hooks/use-settings";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import * as Clipboard from "expo-clipboard";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import type { GitActions } from "@/git/policy";
import { BranchSwitcher } from "@/components/branch-switcher";
import { useGitActions } from "@/git/use-actions";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { buildForgeSignInCommand, getForgePresentation, type Forge } from "@/git/forge";
import { GitHubAuthCallout } from "@/git/github-auth-callout";
import { isGitHubHost, parseGitRemoteLocation } from "@omp-desktop/protocol/git-remote";
import type { ForgeAuthState } from "@omp-desktop/protocol/messages";
import { resolvePrStatusErrorMessage } from "@/git/pr-status";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import {
  PaneContentToolbar,
  paneContentToolbarIconButtonStyle,
} from "@/components/ui/pane-content-toolbar";
import { FOCUSED_PANE_PLACEMENT, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveProjectLayoutKey } from "@/workspace-tabs/project-scope";
import { isWeb } from "@/constants/platform";
import { usePublishWorkingDiffAttachment, useWorkingDiff } from "@/git/use-working-diff";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { DiffTooLargeState } from "@/git/diff-too-large-state";
import { CommitComposer } from "@/git/commit-composer";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useWorkspaceFocusKey } from "@/workspace/focus";

export type { GitActionId, GitAction, GitActions } from "@/git/policy";

export function resolveDiffLayout(
  layout: "unified" | "split",
  canUseSplitLayout: boolean,
): "unified" | "split" {
  return canUseSplitLayout ? layout : "unified";
}

type DiscardPathsAction = (paths: string[], name: string) => void;

interface DiscardChangesActions {
  discardAll: ((path: string, oldPath?: string) => void) | undefined;
  discardUnstaged: DiscardPathsAction | undefined;
  pending: boolean;
}

function useDiscardChangesActions({
  serverId,
  cwd,
  diffMode,
}: {
  serverId: string;
  cwd: string;
  diffMode: "uncommitted" | "base";
}): DiscardChangesActions {
  const { t } = useTranslation();
  const toast = useToast();
  const discardChanges = useCheckoutGitActionsStore((state) => state.discardChanges);
  const pending =
    useCheckoutGitActionsStore((state) =>
      state.getStatus({ serverId, cwd, actionId: "discard-changes" }),
    ) === "pending";
  // COMPAT(checkoutDiscardChanges): added in v0.3.0, remove gate after 2027-02-08.
  const discardSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.checkoutDiscardChanges === true,
  );
  const discardUnstagedSupported = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.checkoutDiscardUnstagedChanges === true,
  );
  const discardPaths = useCallback(
    async (paths: string[], name: string, scope: "all" | "unstaged") => {
      if (paths.length === 0 || pending) return;
      const confirmed = await confirmDialog({
        title: t("workspace.fileActions.confirmRevert.title"),
        message: t("workspace.fileActions.confirmRevert.message", { name }),
        confirmLabel: t("workspace.fileActions.confirmRevert.confirm"),
        cancelLabel: t("workspace.fileActions.confirmRevert.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await discardChanges({
          serverId,
          cwd,
          paths,
          ...(scope === "unstaged" ? { scope } : {}),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileActions.confirmRevert.failed"),
        );
      }
    },
    [cwd, discardChanges, pending, serverId, t, toast],
  );
  const discardAll = useCallback(
    (path: string, oldPath?: string) => {
      void discardPaths(oldPath ? [path, oldPath] : [path], path, "all");
    },
    [discardPaths],
  );
  const discardUnstaged = useCallback<DiscardPathsAction>(
    (paths, name) => {
      void discardPaths(paths, name, "unstaged");
    },
    [discardPaths],
  );
  return useMemo(
    () => ({
      discardAll: discardSupported && diffMode === "uncommitted" ? discardAll : undefined,
      discardUnstaged:
        discardSupported && discardUnstagedSupported && diffMode === "uncommitted"
          ? discardUnstaged
          : undefined,
      pending,
    }),
    [diffMode, discardAll, discardSupported, discardUnstaged, discardUnstagedSupported, pending],
  );
}

interface ChangesSurfaceProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  enabled?: boolean;
  host: "explorer" | "panel";
  modeScope: string;
  focusPath?: string;
  focusRequestId?: number;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
  onAddToChat?: (path: string) => void;
  state?: ChangesState;
  onStateChange?: (state: ChangesState) => void;
}

type PressableStyleFn = (
  state: PressableStateCallbackType & { hovered?: boolean; open?: boolean },
) => StyleProp<ViewStyle>;

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedAlignJustify = withUnistyles(AlignJustify);
const ThemedColumns2 = withUnistyles(Columns2);
const ThemedGitCompareArrows = withUnistyles(GitCompareArrows);
const ThemedPilcrow = withUnistyles(Pilcrow);
const ThemedWrapText = withUnistyles(WrapText);
const ThemedListChevronsDownUp = withUnistyles(ListChevronsDownUp);
const ThemedListChevronsUpDown = withUnistyles(ListChevronsUpDown);
const noopStateChange = () => {};
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);
const ThemedUndo2 = withUnistyles(Undo2);
const DIFF_OPTIONS_MODE_ICON = (
  <ThemedGitCompareArrows size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_WHITESPACE_ICON = (
  <ThemedPilcrow size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_WRAP_ICON = (
  <ThemedWrapText size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_SPLIT_ICON = (
  <ThemedColumns2 size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_COLLAPSE_ICON = (
  <ThemedListChevronsDownUp size={14} uniProps={foregroundMutedIconColorMapping} />
);
const DIFF_OPTIONS_EXPAND_ICON = (
  <ThemedListChevronsUpDown size={14} uniProps={foregroundMutedIconColorMapping} />
);

interface DiffLayoutToggleProps {
  layout: "unified" | "split";
  isMobile: boolean;
  testID?: string;
  toggleStyle?: PressableStyleFn;
  onToggle: () => void;
}
export function DiffLayoutToggle({
  layout,
  isMobile,
  testID = "changes-toggle-layout",
  toggleStyle,
  onToggle,
}: DiffLayoutToggleProps) {
  const defaultToggleStyle = useMemo(
    () => buildToggleButtonStyle(false, undefined, isMobile),
    [isMobile],
  );
  const { t } = useTranslation();
  const label =
    layout === "unified"
      ? t("workspace.git.diff.switchToSplit")
      : t("workspace.git.diff.switchToUnified");
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
          onPress={onToggle}
          style={toggleStyle ?? defaultToggleStyle}
        >
          {layout === "unified" ? (
            <ThemedColumns2 size={isMobile ? 18 : 14} uniProps={foregroundMutedIconColorMapping} />
          ) : (
            <ThemedAlignJustify
              size={isMobile ? 18 : 14}
              uniProps={foregroundMutedIconColorMapping}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

interface ChangesToolbarProps {
  branchName: string | null;
  baseRefLabel: string;
  allFilesCollapsed: boolean;
  canUseSplitLayout: boolean;
  cwd: string;
  desktopTreeVisible: boolean;
  diffMode: "uncommitted" | "base";
  treeToggleAvailable: boolean;
  gitActions: GitActions;
  hasFiles: boolean;
  hideWhitespace: boolean;
  host: "explorer" | "panel";
  isMobile: boolean;
  isRefreshing: boolean;
  layout: "unified" | "split";
  refreshSupported: boolean;
  serverId: string;
  workspaceId?: string | null;
  wrapLines: boolean;
  onRefresh: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onSelectUncommitted: () => void;
  onSelectBase: () => void;
  onToggleDesktopTree: () => void;
  onToggleHideWhitespace: () => void;
  onToggleLayout: () => void;
  onToggleWrapLines: () => void;
}

function ChangesToolbar(props: ChangesToolbarProps) {
  const {
    branchName,
    baseRefLabel,
    cwd,
    desktopTreeVisible,
    diffMode,
    treeToggleAvailable,
    gitActions,
    hasFiles,
    host,
    isMobile,
    serverId,
    workspaceId,
    onToggleDesktopTree,
    onSelectUncommitted,
    onSelectBase,
  } = props;
  const { t } = useTranslation();
  const modeLabel = t("workspace.git.diff.diffMode");
  const uncommittedLabel = t("workspace.git.diff.uncommitted");
  const baseModeLabel = t("panels.diff.baseSubtitle", { baseRef: baseRefLabel });
  const menuPages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: "diff-mode",
        title: modeLabel,
        content: (
          <>
            <DropdownMenuItem
              selected={diffMode === "uncommitted"}
              testID="changes-select-uncommitted"
              onSelect={onSelectUncommitted}
            >
              {uncommittedLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              selected={diffMode === "base"}
              testID="changes-select-base"
              onSelect={onSelectBase}
            >
              {baseModeLabel}
            </DropdownMenuItem>
          </>
        ),
      },
    ],
    [baseModeLabel, diffMode, modeLabel, onSelectBase, onSelectUncommitted, uncommittedLabel],
  );
  return (
    <PaneContentToolbar style={styles.changesToolbar} testID="changes-header">
      <View style={styles.changesToolbarIdentity}>
        <BranchSwitcher
          currentBranchName={branchName}
          serverId={serverId}
          workspaceId={workspaceId ?? cwd}
          workspaceDirectory={cwd}
          isGitCheckout
          testID="changes-branch-switcher"
        />
      </View>
      <View style={styles.changesToolbarControls}>
        {!isMobile && host === "panel" && treeToggleAvailable && hasFiles ? (
          <TreeRailToggle
            visible={desktopTreeVisible}
            testID="changes-toggle-tree"
            onToggle={onToggleDesktopTree}
          />
        ) : null}
        <GitActionsSplitButton gitActions={gitActions} menuOnly menuPages={menuPages}>
          <ChangesOptionsMenuItems {...props} />
        </GitActionsSplitButton>
      </View>
    </PaneContentToolbar>
  );
}

type ChangesOptionsMenuItemsProps = Pick<
  ChangesToolbarProps,
  | "allFilesCollapsed"
  | "canUseSplitLayout"
  | "baseRefLabel"
  | "diffMode"
  | "hasFiles"
  | "hideWhitespace"
  | "isRefreshing"
  | "layout"
  | "refreshSupported"
  | "wrapLines"
  | "onCollapseAll"
  | "onExpandAll"
  | "onRefresh"
  | "onToggleHideWhitespace"
  | "onToggleLayout"
  | "onToggleWrapLines"
>;

function ChangesOptionsMenuItems({
  allFilesCollapsed,
  canUseSplitLayout,
  baseRefLabel,
  diffMode,
  hasFiles,
  hideWhitespace,
  isRefreshing,
  layout,
  refreshSupported,
  wrapLines,
  onCollapseAll,
  onExpandAll,
  onRefresh,
  onToggleHideWhitespace,
  onToggleLayout,
  onToggleWrapLines,
}: ChangesOptionsMenuItemsProps) {
  const { t } = useTranslation();
  const collapseLabel = t(
    allFilesCollapsed ? "workspace.git.diff.expandAllFiles" : "workspace.git.diff.collapseAllFiles",
  );
  const whitespaceLabel = hideWhitespace
    ? t("workspace.git.diff.showWhitespace")
    : t("workspace.git.diff.hideWhitespace");
  const wrapLinesLabel = wrapLines
    ? t("workspace.git.diff.scrollLongLines")
    : t("workspace.git.diff.wrapLongLines");
  const refreshLabel = isRefreshing
    ? t("workspace.git.diff.refreshing")
    : t("workspace.git.diff.refresh");
  const refreshIcon = useMemo(
    () =>
      isRefreshing ? (
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ) : (
        <ThemedRotateCw size={ICON_SIZE.sm} uniProps={foregroundMutedIconColorMapping} />
      ),
    [isRefreshing],
  );

  return (
    <>
      <DropdownMenuSubTrigger
        id="diff-mode"
        leading={DIFF_OPTIONS_MODE_ICON}
        value={
          diffMode === "uncommitted"
            ? t("workspace.git.diff.uncommitted")
            : t("panels.diff.baseSubtitle", { baseRef: baseRefLabel })
        }
        testID="changes-diff-mode-trigger"
      >
        {t("workspace.git.diff.diffMode")}
      </DropdownMenuSubTrigger>
      {hasFiles ? (
        <DropdownMenuItem
          leading={allFilesCollapsed ? DIFF_OPTIONS_EXPAND_ICON : DIFF_OPTIONS_COLLAPSE_ICON}
          testID="changes-toggle-collapse-all"
          onSelect={allFilesCollapsed ? onExpandAll : onCollapseAll}
        >
          {collapseLabel}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      {canUseSplitLayout ? (
        <DropdownMenuItem
          leading={DIFF_OPTIONS_SPLIT_ICON}
          selected={layout === "split"}
          testID="changes-toggle-layout"
          onSelect={onToggleLayout}
        >
          {t("workspace.git.diff.split")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        leading={DIFF_OPTIONS_WHITESPACE_ICON}
        selected={hideWhitespace}
        testID="changes-toggle-whitespace"
        onSelect={onToggleHideWhitespace}
      >
        {whitespaceLabel}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={DIFF_OPTIONS_WRAP_ICON}
        selected={wrapLines}
        testID="changes-toggle-wrap-lines"
        onSelect={onToggleWrapLines}
      >
        {wrapLinesLabel}
      </DropdownMenuItem>
      {refreshSupported ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={refreshIcon}
            disabled={isRefreshing}
            testID="changes-refresh"
            onSelect={onRefresh}
          >
            {refreshLabel}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);

function computeEmptyMessage(
  hideWhitespace: boolean,
  diffMode: "uncommitted" | "base",
  baseRefLabel: string,
  labels: {
    hiddenWhitespace: string;
    uncommitted: string;
    againstBase: (baseRefLabel: string) => string;
  },
): string {
  if (hideWhitespace) {
    return labels.hiddenWhitespace;
  }
  if (diffMode === "uncommitted") {
    return labels.uncommitted;
  }
  return labels.againstBase(baseRefLabel);
}

interface DiffBodyContentProps {
  isStatusLoading: boolean;
  statusErrorMessage: string | null;
  notGit: boolean;
  isDiffLoading: boolean;
  diffErrorMessage: string | null;
  diffTooLarge: boolean;
  hasChanges: boolean;
  emptyMessage: string;
  emptyAction: ChangesEmptyAction | null;
  children: ReactElement;
  checkingRepositoryLabel: string;
  notRepositoryLabel: string;
}

function DiffBodyContent({
  isStatusLoading,
  statusErrorMessage,
  notGit,
  isDiffLoading,
  diffErrorMessage,
  diffTooLarge,
  hasChanges,
  emptyMessage,
  emptyAction,
  children,
  checkingRepositoryLabel,
  notRepositoryLabel,
}: DiffBodyContentProps) {
  if (isStatusLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
        <Text style={styles.loadingText}>{checkingRepositoryLabel}</Text>
      </View>
    );
  }
  if (statusErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{statusErrorMessage}</Text>
      </View>
    );
  }
  if (notGit) {
    return (
      <View style={styles.emptyContainer} testID="changes-not-git">
        <Text style={styles.emptyText}>{notRepositoryLabel}</Text>
      </View>
    );
  }
  if (isDiffLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedIconColorMapping} />
      </View>
    );
  }
  if (diffTooLarge) {
    return <DiffTooLargeState />;
  }
  if (diffErrorMessage) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{diffErrorMessage}</Text>
      </View>
    );
  }
  if (!hasChanges) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{emptyMessage}</Text>
        {emptyAction ? (
          <Button
            variant="ghost"
            size="xs"
            testID="changes-empty-switch-mode"
            onPress={emptyAction.onPress}
          >
            {emptyAction.label}
          </Button>
        ) : null}
      </View>
    );
  }
  return children;
}

function computeBaseRefLabel(baseRef: string | undefined, fallbackLabel: string): string {
  if (!baseRef) return fallbackLabel;
  const trimmed = baseRef.replace(/^refs\/(heads|remotes)\//, "").trim();
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

interface ChangesEmptyAction {
  label: string;
  onPress: () => void;
}

function computeChangesEmptyAction(input: {
  hideWhitespace: boolean;
  diffMode: "uncommitted" | "base";
  status: CheckoutStatusPayload | null;
  seeUncommittedLabel: string;
  seeCommittedLabel: string;
  selectUncommitted: () => void;
  selectBase: () => void;
}): ChangesEmptyAction | null {
  if (input.hideWhitespace || !input.status?.isGit) {
    return null;
  }
  if (input.diffMode === "base" && input.status.isDirty) {
    return {
      label: input.seeUncommittedLabel,
      onPress: input.selectUncommitted,
    };
  }
  if (input.diffMode === "uncommitted" && (input.status.aheadBehind?.ahead ?? 0) > 0) {
    return { label: input.seeCommittedLabel, onPress: input.selectBase };
  }
  return null;
}

// The precise setup step a workspace needs before its forge features work, or
// null when nothing is actionable (authenticated, or no forge remote at all).
type ForgeSetupAction = "install_cli" | "sign_in" | null;

// Drive the onboarding callout from the forge's auth state so the message names
// the exact next step (install the CLI vs sign in) for whichever forge backs the
// workspace — GitHub included. GitLab additionally requires the host to advertise
// GitLab support, matching the rest of the GitLab UI.
function computeForgeSetupAction(input: {
  forge: Forge;
  forgeProvidersSupported: boolean;
  nativeAuthSupported: boolean;
  authState: ForgeAuthState | undefined;
}): ForgeSetupAction {
  // A daemon without pluggable forge support can't operate any non-GitHub forge,
  // so don't offer a setup action for one it can't drive.
  if (input.forge !== "github" && !input.forgeProvidersSupported) {
    return null;
  }
  switch (input.authState) {
    case "cli_missing":
      return input.forge === "github" && input.nativeAuthSupported ? "sign_in" : "install_cli";
    case "unauthenticated":
      return "sign_in";
    case "authenticated":
    case "no_remote":
    case "error":
      return null;
    default:
      return null;
  }
}

function parseForgeHost(url: string | null | undefined): string | null {
  return url ? (parseGitRemoteLocation(url)?.host ?? null) : null;
}

function buildForgeSetupMessage(input: {
  action: ForgeSetupAction;
  forge: Forge;
  host: string | null;
  nativeAuthConfigured: boolean;
  t: TFunction;
}): string | null {
  if (!input.action) {
    return null;
  }
  const { brandLabel, signInCli, signInKind } = getForgePresentation(input.forge);
  if (input.action === "sign_in" && signInKind === "native") {
    return input.t(
      input.nativeAuthConfigured
        ? "workspace.git.forgeSetup.nativeSignIn"
        : "workspace.git.forgeSetup.oauthNotConfigured",
      { brand: brandLabel },
    );
  }
  if (signInCli === null) {
    return input.t("workspace.git.forgeSetup.generic", { brand: brandLabel });
  }
  if (input.action === "install_cli") {
    return input.t("workspace.git.forgeSetup.installCli", {
      cli: signInCli,
      brand: brandLabel,
    });
  }
  const command = buildForgeSignInCommand(input.forge, input.host);
  return input.t("workspace.git.forgeSetup.signIn", {
    command,
    brand: brandLabel,
  });
}

function buildToggleButtonStyle(
  selected: boolean,
  baseStyles?: StyleProp<ViewStyle> | StyleProp<ViewStyle>[],
  isMobile = false,
): PressableStyleFn {
  return (state) => [baseStyles, paneContentToolbarIconButtonStyle(state, selected, isMobile)];
}

type ChangeStageOperation = "stage" | "unstage";

interface ChangeStageAction {
  operation: ChangeStageOperation;
  disabled: boolean;
  onPress: (paths: string[]) => void;
}

interface ChangeDiscardAction {
  disabled: boolean;
  onPress: DiscardPathsAction;
}

function changePathspecs(file: ParsedDiffFile): string[] {
  return file.oldPath ? [file.path, file.oldPath] : [file.path];
}

function allChangePathspecs(files: ParsedDiffFile[]): string[] {
  return [
    ...new Set(files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))),
  ];
}

function folderChangePathspecs(files: ParsedDiffFile[], dirPath: string): string[] {
  const prefix = `${dirPath}/`;
  return allChangePathspecs(files.filter((file) => file.path.startsWith(prefix)));
}

function StageChangeButton({
  operation,
  disabled,
  onPress,
  testID,
}: {
  operation: ChangeStageOperation;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const label = t(
    operation === "stage"
      ? "workspace.git.diff.staging.stage"
      : "workspace.git.diff.staging.unstage",
  );
  const Icon = operation === "stage" ? ThemedPlus : ThemedMinus;
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  const pressableStyle = useMemo<PressableStyleFn>(
    () =>
      ({ hovered, pressed }) => [
        styles.stageAction,
        (Boolean(hovered) || pressed) && styles.stageActionHovered,
        disabled && styles.stageActionDisabled,
      ],
    [disabled],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={handlePress}
          style={pressableStyle}
          testID={testID}
        >
          <Icon size={14} uniProps={foregroundMutedIconColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function DiscardChangeButton({
  disabled,
  onPress,
  testID,
}: {
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const label = t("workspace.fileActions.revert");
  const handlePress = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );
  const pressableStyle = useMemo<PressableStyleFn>(
    () =>
      ({ hovered, pressed }) => [
        styles.stageAction,
        (Boolean(hovered) || pressed) && styles.stageActionHovered,
        disabled && styles.stageActionDisabled,
      ],
    [disabled],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={handlePress}
          style={pressableStyle}
          testID={testID}
        >
          <ThemedUndo2 size={14} uniProps={foregroundMutedIconColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function FolderChangeButtons({
  stageAction,
  discardAction,
  files,
  dirPath,
  testID,
}: {
  stageAction?: ChangeStageAction;
  discardAction?: ChangeDiscardAction;
  files: ParsedDiffFile[];
  dirPath: string;
  testID: string;
}) {
  // Resolve descendants only when invoked, not for every mounted folder row.
  const handleStage = useCallback(
    () => stageAction?.onPress(folderChangePathspecs(files, dirPath)),
    [dirPath, files, stageAction],
  );
  const handleDiscard = useCallback(
    () => discardAction?.onPress(folderChangePathspecs(files, dirPath), dirPath),
    [dirPath, discardAction, files],
  );
  return (
    <View style={styles.changeRowActions}>
      {discardAction ? (
        <DiscardChangeButton
          disabled={discardAction.disabled}
          onPress={handleDiscard}
          testID={`${testID}-discard`}
        />
      ) : null}
      {stageAction ? (
        <StageChangeButton
          operation={stageAction.operation}
          disabled={stageAction.disabled}
          onPress={handleStage}
          testID={`${testID}-${stageAction.operation}`}
        />
      ) : null}
    </View>
  );
}

function FileChangeButtons({
  stageAction,
  discardAction,
  file,
  testID,
}: {
  stageAction?: ChangeStageAction;
  discardAction?: ChangeDiscardAction;
  file: ParsedDiffFile;
  testID: string;
}) {
  const pathspecs = useMemo(() => changePathspecs(file), [file]);
  const handleStage = useCallback(() => stageAction?.onPress(pathspecs), [pathspecs, stageAction]);
  const handleDiscard = useCallback(
    () => discardAction?.onPress(pathspecs, file.path),
    [discardAction, file.path, pathspecs],
  );
  return (
    <View style={styles.changeRowActions}>
      {discardAction ? (
        <DiscardChangeButton
          disabled={discardAction.disabled}
          onPress={handleDiscard}
          testID={`${testID}-discard`}
        />
      ) : null}
      {stageAction ? (
        <StageChangeButton
          operation={stageAction.operation}
          disabled={stageAction.disabled}
          onPress={handleStage}
          testID={`${testID}-${stageAction.operation}`}
        />
      ) : null}
    </View>
  );
}

function StagingSectionHeader({
  operation,
  title,
  count,
  collapsed,
  disabled,
  onToggle,
  onApplyAll,
  onDiscardAll,
  testID,
}: {
  operation: ChangeStageOperation;
  title: string;
  count: number;
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
  onApplyAll: () => void;
  onDiscardAll?: () => void;
  testID: string;
}) {
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  return (
    <View style={styles.stagingSectionHeader} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={onToggle}
        style={styles.stagingSectionToggle}
        testID={`${testID}-toggle`}
      >
        <View
          style={[styles.stagingSectionChevron, !collapsed && styles.stagingSectionChevronOpen]}
        >
          <ThemedChevronDown size={14} uniProps={foregroundMutedIconColorMapping} />
        </View>
        <Text style={styles.stagingSectionTitle}>{title}</Text>
        <View style={styles.changesCountBadge}>
          <Text style={styles.changesCountText}>{count}</Text>
        </View>
      </Pressable>
      {count > 0 ? (
        <View style={styles.changeRowActions}>
          {onDiscardAll ? (
            <DiscardChangeButton
              disabled={disabled}
              onPress={onDiscardAll}
              testID={`${testID}-discard-all`}
            />
          ) : null}
          <StageChangeButton
            operation={operation}
            disabled={disabled}
            onPress={onApplyAll}
            testID={`${testID}-all`}
          />
        </View>
      ) : null}
    </View>
  );
}

interface ChangedFilesTreeModel {
  items: DiffTreeRow[];
  allFolderPaths: string[];
  collapsedFolders: Set<string>;
}

const EMPTY_DIFF_TREE_ROWS: DiffTreeRow[] = [];
const EMPTY_FOLDER_PATHS: string[] = [];
const EMPTY_COLLAPSED_FOLDERS = new Set<string>();
// Keep the Changes pane as the only scroll owner. Nesting these rows in a
// ScrollView eagerly mounted every path in large worktrees.
const DIFF_TREE_ROW_HEIGHT = 24;
const STAGING_SECTION_ROW_HEIGHT = 35;
const DIFF_TREE_INITIAL_NUM_TO_RENDER = 20;
const DIFF_TREE_MAX_TO_RENDER_PER_BATCH = 40;
const DIFF_TREE_WINDOW_SIZE = 5;

function useChangedFilesTreeModel(
  files: ParsedDiffFile[],
  collapsedFolderPaths: string[],
  enabled = true,
): ChangedFilesTreeModel {
  const compressedTree = useMemo(
    () => (enabled ? compressSingleChildChains(buildDiffTree(files)) : null),
    [enabled, files],
  );
  const allFolderPaths = useMemo(
    () => (compressedTree ? collectDirPaths(compressedTree) : EMPTY_FOLDER_PATHS),
    [compressedTree],
  );
  const collapsedFolders = useMemo(
    () => (enabled ? new Set(collapsedFolderPaths) : EMPTY_COLLAPSED_FOLDERS),
    [collapsedFolderPaths, enabled],
  );
  const items = useMemo(
    () =>
      compressedTree ? flattenDiffTree(compressedTree, collapsedFolders) : EMPTY_DIFF_TREE_ROWS,
    [collapsedFolders, compressedTree],
  );
  return { items, allFolderPaths, collapsedFolders };
}

function useChangedFilesTreeInteractions({
  allFolderPaths,
  collapsedFolders,
  onSelectFile,
  onCollapsedFolderPathsChange,
}: {
  allFolderPaths: string[];
  collapsedFolders: Set<string>;
  onSelectFile: (path: string) => void;
  onCollapsedFolderPathsChange: (paths: string[]) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const handleSelectPath = useCallback((path: string) => setSelectedPath(path), []);
  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedPath(path);
      onSelectFile(path);
    },
    [onSelectFile],
  );
  const handleToggleFolder = useCallback(
    (dirPath: string) => {
      const next = collapsedFolders.has(dirPath)
        ? Array.from(collapsedFolders).filter((path) => path !== dirPath)
        : [...collapsedFolders, dirPath];
      onCollapsedFolderPathsChange(next);
    },
    [collapsedFolders, onCollapsedFolderPathsChange],
  );
  const handleCollapseFolder = useCallback(
    (dirPath: string) => {
      const prefix = `${dirPath}/`;
      onCollapsedFolderPathsChange([
        ...new Set([
          ...collapsedFolders,
          ...allFolderPaths.filter(
            (folderPath) => folderPath === dirPath || folderPath.startsWith(prefix),
          ),
        ]),
      ]);
    },
    [allFolderPaths, collapsedFolders, onCollapsedFolderPathsChange],
  );
  return {
    selectedPath,
    handleSelectPath,
    handleSelectFile,
    handleToggleFolder,
    handleCollapseFolder,
  };
}

interface ChangedFilesTreeRowRenderInput {
  item: DiffTreeRow;
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  selectedPath: string | null;
  collapsedFolders: Set<string>;
  stageAction?: ChangeStageAction;
  discardAction?: ChangeDiscardAction;
  testID: string;
  onSelectPath: (path: string) => void;
  onSelectFile: (path: string) => void;
  onToggleFolder: (dirPath: string) => void;
  onCollapseFolder: (dirPath: string) => void;
}

function renderChangedFilesTreeRow({
  item,
  files,
  mode,
  selectedPath,
  collapsedFolders,
  stageAction,
  discardAction,
  testID,
  onSelectPath,
  onSelectFile,
  onToggleFolder,
  onCollapseFolder,
}: ChangedFilesTreeRowRenderInput): ReactElement {
  let trailingAction: ReactElement | undefined;
  if ((stageAction || discardAction) && item.kind === "folder") {
    trailingAction = createElement(FolderChangeButtons, {
      stageAction,
      discardAction,
      files,
      dirPath: item.dirPath,
      testID: `${testID}-folder-${item.dirPath}`,
    });
  }
  if (item.kind === "folder") {
    return (
      <DiffFolderRow
        dirPath={item.dirPath}
        displayName={item.displayName}
        depth={item.depth}
        collapsed={collapsedFolders.has(item.dirPath)}
        isSelected={selectedPath === item.dirPath}
        compact
        additions={item.additions}
        deletions={item.deletions}
        onToggle={onToggleFolder}
        onCollapse={onCollapseFolder}
        onSelect={onSelectPath}
        onCopyPath={mode.onCopyPath}
        onCopyRelativePath={mode.onCopyRelativePath}
        onReveal={mode.onReveal}
        revealTargetName={mode.revealTargetName}
        onDuplicate={mode.onDuplicate}
        onRevert={mode.onRevert}
        trailingAction={trailingAction}
        testID={`diff-folder-${item.dirPath}`}
      />
    );
  }
  if (stageAction || discardAction) {
    trailingAction = createElement(FileChangeButtons, {
      stageAction,
      discardAction,
      file: item.file,
      testID: `${testID}-file-${item.fileIndex}`,
    });
  }
  return (
    <FileHeader
      file={item.file}
      workspaceFileDragScope={mode.workspaceFileDragScope}
      bodyVisible={false}
      showsBodyState={false}
      compact
      isSelected={selectedPath === item.file.path}
      depth={item.depth}
      showDir={false}
      onActivate={onSelectFile}
      onSelect={onSelectPath}
      onOpenFile={mode.onOpenFile}
      onAddToChat={mode.onAddToChat}
      onCopyPath={mode.onCopyPath}
      onCopyRelativePath={mode.onCopyRelativePath}
      onReveal={mode.onReveal}
      revealTargetName={mode.revealTargetName}
      onDownload={mode.onDownload}
      onDuplicate={mode.onDuplicate}
      onRevert={mode.onRevert}
      trailingAction={trailingAction}
      testID={`diff-tree-file-${item.fileIndex}`}
    />
  );
}

function diffTreeRowKey(item: DiffTreeRow): string {
  return item.kind === "folder" ? `folder-${item.dirPath}` : `file-${item.file.path}`;
}

function getDiffTreeItemLayout(_data: ArrayLike<DiffTreeRow> | null | undefined, index: number) {
  return {
    length: DIFF_TREE_ROW_HEIGHT,
    offset: DIFF_TREE_ROW_HEIGHT * index,
    index,
  };
}

function ChangedFilesTree({
  files,
  mode,
  onSelectFile,
  collapsedFolderPaths,
  onCollapsedFolderPathsChange,
  stageAction,
  discardAction,
  testID = "changes-file-tree",
}: {
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
  collapsedFolderPaths: string[];
  onCollapsedFolderPathsChange: (paths: string[]) => void;
  stageAction?: ChangeStageAction;
  discardAction?: ChangeDiscardAction;
  testID?: string;
}) {
  const model = useChangedFilesTreeModel(files, collapsedFolderPaths);
  const interactions = useChangedFilesTreeInteractions({
    allFolderPaths: model.allFolderPaths,
    collapsedFolders: model.collapsedFolders,
    onSelectFile,
    onCollapsedFolderPathsChange,
  });
  const renderItem = useCallback(
    ({ item }: { item: DiffTreeRow }) =>
      renderChangedFilesTreeRow({
        item,
        files,
        mode,
        selectedPath: interactions.selectedPath,
        collapsedFolders: model.collapsedFolders,
        stageAction,
        discardAction,
        testID,
        onSelectPath: interactions.handleSelectPath,
        onSelectFile: interactions.handleSelectFile,
        onToggleFolder: interactions.handleToggleFolder,
        onCollapseFolder: interactions.handleCollapseFolder,
      }),
    [
      discardAction,
      files,
      interactions.handleCollapseFolder,
      interactions.handleSelectFile,
      interactions.handleSelectPath,
      interactions.handleToggleFolder,
      interactions.selectedPath,
      mode,
      model.collapsedFolders,
      stageAction,
      testID,
    ],
  );
  return (
    <FlatList
      data={model.items}
      renderItem={renderItem}
      keyExtractor={diffTreeRowKey}
      getItemLayout={getDiffTreeItemLayout}
      initialNumToRender={DIFF_TREE_INITIAL_NUM_TO_RENDER}
      maxToRenderPerBatch={DIFF_TREE_MAX_TO_RENDER_PER_BATCH}
      updateCellsBatchingPeriod={16}
      windowSize={DIFF_TREE_WINDOW_SIZE}
      style={styles.scrollView}
      contentContainerStyle={styles.contentContainer}
      testID={testID}
    />
  );
}

interface StagingTreeSectionRow {
  kind: "section";
  section: "staged" | "unstaged";
}

type StagingTreeRow = DiffTreeRow | StagingTreeSectionRow;

const STAGED_SECTION_ROW: StagingTreeSectionRow = {
  kind: "section",
  section: "staged",
};
const UNSTAGED_SECTION_ROW: StagingTreeSectionRow = {
  kind: "section",
  section: "unstaged",
};

function StagingChangesTree({
  stagedFiles,
  unstagedFiles,
  mode,
  onSelectFile,
  collapsedFolderPaths,
  onCollapsedFolderPathsChange,
  mutationPending,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
}: {
  stagedFiles: ParsedDiffFile[];
  unstagedFiles: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
  collapsedFolderPaths: string[];
  onCollapsedFolderPathsChange: (paths: string[]) => void;
  mutationPending: boolean;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onDiscardPaths?: DiscardPathsAction;
}) {
  const { t } = useTranslation();
  const [stagedCollapsed, setStagedCollapsed] = useState(true);
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false);
  const stagedModel = useChangedFilesTreeModel(
    stagedFiles,
    collapsedFolderPaths,
    !stagedCollapsed && stagedFiles.length > 0,
  );
  const unstagedModel = useChangedFilesTreeModel(
    unstagedFiles,
    collapsedFolderPaths,
    !unstagedCollapsed,
  );
  const allFolderPaths = useMemo(
    () => [...new Set([...stagedModel.allFolderPaths, ...unstagedModel.allFolderPaths])],
    [stagedModel.allFolderPaths, unstagedModel.allFolderPaths],
  );
  const collapsedFolders = useMemo(() => new Set(collapsedFolderPaths), [collapsedFolderPaths]);
  const interactions = useChangedFilesTreeInteractions({
    allFolderPaths,
    collapsedFolders,
    onSelectFile,
    onCollapsedFolderPathsChange,
  });
  const stageAction = useMemo<ChangeStageAction>(
    () => ({
      operation: "stage",
      disabled: mutationPending,
      onPress: onStagePaths,
    }),
    [mutationPending, onStagePaths],
  );
  const unstageAction = useMemo<ChangeStageAction>(
    () => ({
      operation: "unstage",
      disabled: mutationPending,
      onPress: onUnstagePaths,
    }),
    [mutationPending, onUnstagePaths],
  );
  const discardAction = useMemo<ChangeDiscardAction | undefined>(
    () =>
      onDiscardPaths
        ? {
            disabled: mutationPending,
            onPress: onDiscardPaths,
          }
        : undefined,
    [mutationPending, onDiscardPaths],
  );
  const stageAll = useCallback(
    () => onStagePaths(allChangePathspecs(unstagedFiles)),
    [onStagePaths, unstagedFiles],
  );
  const unstageAll = useCallback(
    () => onUnstagePaths(allChangePathspecs(stagedFiles)),
    [onUnstagePaths, stagedFiles],
  );
  const discardAll = useCallback(
    () =>
      onDiscardPaths?.(allChangePathspecs(unstagedFiles), t("workspace.git.diff.staging.changes")),
    [onDiscardPaths, t, unstagedFiles],
  );
  const toggleStaged = useCallback(() => setStagedCollapsed((current) => !current), []);
  const toggleUnstaged = useCallback(() => setUnstagedCollapsed((current) => !current), []);
  const items = useMemo<StagingTreeRow[]>(() => {
    const next: StagingTreeRow[] = [];
    if (stagedFiles.length > 0) {
      next.push(STAGED_SECTION_ROW, ...stagedModel.items);
    }
    next.push(UNSTAGED_SECTION_ROW, ...unstagedModel.items);
    return next;
  }, [stagedFiles.length, stagedModel.items, unstagedModel.items]);
  const unstagedSectionIndex = (stagedFiles.length > 0 ? 1 : 0) + stagedModel.items.length;
  const getItemLayout = useCallback(
    (data: ArrayLike<StagingTreeRow> | null | undefined, index: number) => {
      const stagedSectionRowsBefore = stagedFiles.length > 0 && index > 0 ? 1 : 0;
      const unstagedSectionRowsBefore = index > unstagedSectionIndex ? 1 : 0;
      const sectionRowsBefore = stagedSectionRowsBefore + unstagedSectionRowsBefore;
      return {
        length:
          data?.[index]?.kind === "section" ? STAGING_SECTION_ROW_HEIGHT : DIFF_TREE_ROW_HEIGHT,
        offset:
          DIFF_TREE_ROW_HEIGHT * index +
          (STAGING_SECTION_ROW_HEIGHT - DIFF_TREE_ROW_HEIGHT) * sectionRowsBefore,
        index,
      };
    },
    [stagedFiles.length, unstagedSectionIndex],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: StagingTreeRow; index: number }) => {
      if (item.kind === "section") {
        if (item.section === "staged") {
          return (
            <StagingSectionHeader
              operation="unstage"
              title={t("workspace.git.diff.staging.stagedChanges")}
              count={stagedFiles.length}
              collapsed={stagedCollapsed}
              disabled={mutationPending}
              onToggle={toggleStaged}
              onApplyAll={unstageAll}
              testID="staged-changes-header"
            />
          );
        }
        return (
          <StagingSectionHeader
            operation="stage"
            title={t("workspace.git.diff.staging.changes")}
            count={unstagedFiles.length}
            collapsed={unstagedCollapsed}
            disabled={mutationPending}
            onToggle={toggleUnstaged}
            onApplyAll={stageAll}
            onDiscardAll={onDiscardPaths ? discardAll : undefined}
            testID="unstaged-changes-header"
          />
        );
      }
      const isStaged = index < unstagedSectionIndex;
      return renderChangedFilesTreeRow({
        item,
        files: isStaged ? stagedFiles : unstagedFiles,
        mode,
        selectedPath: interactions.selectedPath,
        collapsedFolders,
        stageAction: isStaged ? unstageAction : stageAction,
        discardAction: isStaged ? undefined : discardAction,
        testID: isStaged ? "staged-changes-tree" : "unstaged-changes-tree",
        onSelectPath: interactions.handleSelectPath,
        onSelectFile: interactions.handleSelectFile,
        onToggleFolder: interactions.handleToggleFolder,
        onCollapseFolder: interactions.handleCollapseFolder,
      });
    },
    [
      collapsedFolders,
      discardAction,
      discardAll,
      interactions.handleCollapseFolder,
      interactions.handleSelectFile,
      interactions.handleSelectPath,
      interactions.handleToggleFolder,
      interactions.selectedPath,
      mode,
      mutationPending,
      onDiscardPaths,
      stageAction,
      stageAll,
      stagedCollapsed,
      stagedFiles,
      t,
      toggleStaged,
      toggleUnstaged,
      unstagedCollapsed,
      unstagedFiles,
      unstagedSectionIndex,
      unstageAction,
      unstageAll,
    ],
  );
  const keyExtractor = useCallback(
    (item: StagingTreeRow, index: number) => {
      if (item.kind === "section") return `section-${item.section}`;
      const section = index < unstagedSectionIndex ? "staged" : "unstaged";
      return `${section}-${diffTreeRowKey(item)}`;
    },
    [unstagedSectionIndex],
  );

  return (
    <FlatList
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      initialNumToRender={DIFF_TREE_INITIAL_NUM_TO_RENDER}
      maxToRenderPerBatch={DIFF_TREE_MAX_TO_RENDER_PER_BATCH}
      updateCellsBatchingPeriod={16}
      windowSize={DIFF_TREE_WINDOW_SIZE}
      style={styles.stagingTree}
      contentContainerStyle={styles.contentContainer}
      testID="changes-staging-tree"
    />
  );
}

function ChangesTreeRail({
  shown,
  children,
  files,
  mode,
  onSelectFile,
  treeWidth,
  onTreeWidthChange,
  collapsedFolderPaths,
  onCollapsedFolderPathsChange,
}: {
  shown: boolean;
  children: ReactElement;
  files: ParsedDiffFile[];
  mode: WorkingDiffMode;
  onSelectFile: (path: string) => void;
  treeWidth?: number;
  onTreeWidthChange: (width: number) => void;
  collapsedFolderPaths: string[];
  onCollapsedFolderPathsChange: (paths: string[]) => void;
}) {
  if (!shown) return children;
  return (
    <TreeRail testID="changes-tree-rail" width={treeWidth ?? 220} onWidthChange={onTreeWidthChange}>
      {children}
      <ChangedFilesTree
        files={files}
        mode={mode}
        onSelectFile={onSelectFile}
        collapsedFolderPaths={collapsedFolderPaths}
        onCollapsedFolderPathsChange={onCollapsedFolderPathsChange}
      />
    </TreeRail>
  );
}

function useDiffTabNavigation({
  serverId,
  workspaceId,
  layoutWorkspaceKey,
}: {
  serverId: string;
  workspaceId?: string | null;
  layoutWorkspaceKey?: string | null;
}) {
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openWorkspaceTabInFocusedPane = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget, placement?: WorkspaceTabPlacement) =>
      openTab({
        workspaceKey,
        target: { ...target, ...(workspaceId ? { workspaceId } : {}) },
        intent: "reveal",
        placement,
      }),
    [openTab, workspaceId],
  );
  const persistenceKey = useMemo(
    () =>
      layoutWorkspaceKey ??
      (workspaceId ? resolveProjectLayoutKey({ serverId, workspaceId }) : null),
    [layoutWorkspaceKey, serverId, workspaceId],
  );
  const openChanges = useCallback(
    (path?: string) => {
      if (!persistenceKey) {
        return;
      }
      openWorkspaceTabInFocusedPane(
        persistenceKey,
        {
          kind: "working_diff",
          ...(path ? { focusPath: path, focusRequestId: Date.now() } : {}),
        },
        FOCUSED_PANE_PLACEMENT,
      );
    },
    [openWorkspaceTabInFocusedPane, persistenceKey],
  );
  const openCommit = useCallback(
    (sha: string) => {
      if (persistenceKey) {
        openWorkspaceTabInFocusedPane(
          persistenceKey,
          { kind: "commit_diff", sha },
          FOCUSED_PANE_PLACEMENT,
        );
      }
    },
    [openWorkspaceTabInFocusedPane, persistenceKey],
  );
  return {
    openCommit,
    onChangesFilePress: openChanges,
  };
}

function resolveCanUseSplitLayout(isMobile: boolean): boolean {
  return isWeb && !isMobile;
}

function resolveChangesState(state: ChangesSurfaceProps["state"]) {
  return state ?? defaultChangesState;
}

function resolveChangesStateChange(onStateChange: ChangesSurfaceProps["onStateChange"]) {
  return onStateChange ?? noopStateChange;
}

function resolveNativeAuthConfigured(
  forgeHost: string | null,
  githubOAuthConfigured: boolean,
): boolean {
  if (!forgeHost || isGitHubHost(forgeHost)) {
    return githubOAuthConfigured;
  }
  return true;
}

function resolveNativeGitHubSignIn(
  isGitHub: boolean,
  isSignInAction: boolean,
  githubNativeAuthSupported: boolean,
  nativeAuthConfigured: boolean,
  usesNativeSignIn: boolean,
): boolean {
  return (
    isGitHub &&
    isSignInAction &&
    githubNativeAuthSupported &&
    nativeAuthConfigured &&
    usesNativeSignIn
  );
}

function selectDocumentFocusRequest(
  localFocusRequest: { path: string; revision: number } | null,
  externalFocusRequest: { path: string; revision: number } | null,
) {
  if (
    localFocusRequest &&
    (!externalFocusRequest || localFocusRequest.revision >= externalFocusRequest.revision)
  ) {
    return localFocusRequest;
  }
  return externalFocusRequest;
}

function canQueryStagingDiffs(
  stagingSupported: boolean,
  diffMode: "uncommitted" | "base",
  isGit: boolean,
  enabled: boolean | undefined,
): boolean {
  return stagingSupported && diffMode === "uncommitted" && isGit && enabled !== false;
}

function resolveDiffError(
  workingError: { message: string } | null | undefined,
  stagedError: { message: string } | null | undefined,
  unstagedError: { message: string } | null | undefined,
): string | null {
  return workingError?.message ?? stagedError?.message ?? unstagedError?.message ?? null;
}

function shouldShowChangesTree(host: ChangesSurfaceProps["host"], panelView: "tree" | "diff") {
  return host === "explorer" || panelView === "tree";
}

function hasCommittableChanges(stagingSupported: boolean, stagedFiles: ParsedDiffFile[]): boolean {
  return !stagingSupported || stagedFiles.length > 0;
}

interface ChangesViewState {
  displayedFiles: ParsedDiffFile[];
  isStagingDiffLoading: boolean;
  allFilesCollapsed: boolean;
  showChangesTreeRail: boolean;
}

function resolveChangesViewState({
  files,
  focusPath,
  documentOnly,
  stagingQueriesEnabled,
  stagedLoading,
  unstagedLoading,
  collapsedFilePaths,
  host,
  panelView,
  desktopTreeVisible,
  isMobile,
}: {
  files: ParsedDiffFile[];
  focusPath: string | undefined;
  documentOnly: boolean;
  stagingQueriesEnabled: boolean;
  stagedLoading: boolean;
  unstagedLoading: boolean;
  collapsedFilePaths: string[];
  host: ChangesSurfaceProps["host"];
  panelView: "tree" | "diff";
  desktopTreeVisible: boolean;
  isMobile: boolean;
}): ChangesViewState {
  const displayedFiles = documentOnly ? files.filter((file) => file.path === focusPath) : files;
  const isStagingDiffLoading = stagingQueriesEnabled && (stagedLoading || unstagedLoading);
  const allFilesCollapsed =
    files.length > 0 && files.every((file) => collapsedFilePaths.includes(file.path));
  const showChangesTreeRail =
    host === "panel" && panelView === "diff" && desktopTreeVisible && !isMobile && files.length > 0;
  return {
    displayedFiles,
    isStagingDiffLoading,
    allFilesCollapsed,
    showChangesTreeRail,
  };
}
type ChangesDiffQuery = ReturnType<typeof useCheckoutDiffQuery>;

interface ChangesStagingOptions {
  serverId: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean | undefined;
  modeScope: string;
  summarySupported: boolean;
  stagingSupported: boolean;
  diffMode: "uncommitted" | "base";
  isGit: boolean;
  documentOnly: boolean;
  staging: ChangesDiffQuery["staging"];
}

function useChangesStagingData({
  serverId,
  cwd,
  ignoreWhitespace,
  enabled,
  modeScope,
  summarySupported,
  stagingSupported,
  diffMode,
  isGit,
  documentOnly,
  staging,
}: ChangesStagingOptions) {
  const queriesEnabled = canQueryStagingDiffs(stagingSupported, diffMode, isGit, enabled);
  const legacyEnabled = queriesEnabled && !summarySupported;
  const stagedDiff = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: "staged",
    ignoreWhitespace,
    enabled: legacyEnabled,
    queryScope: `${modeScope}:staged`,
  });
  const unstagedDiff = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: "unstaged",
    ignoreWhitespace,
    enabled: legacyEnabled,
    queryScope: `${modeScope}:unstaged`,
  });
  const commitSummary = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: "uncommitted",
    detail: "summary",
    ignoreWhitespace,
    enabled:
      summarySupported &&
      stagingSupported &&
      diffMode === "base" &&
      isGit &&
      enabled !== false &&
      !documentOnly,
    queryScope: `${modeScope}:commit-summary`,
  });
  if (!summarySupported) {
    return {
      queriesEnabled,
      stagedFiles: stagedDiff.files,
      unstagedFiles: unstagedDiff.files,
      stagedLoading: stagedDiff.isLoading,
      unstagedLoading: unstagedDiff.isLoading,
      payloadError: stagedDiff.payloadError ?? unstagedDiff.payloadError,
      diffTooLarge: stagedDiff.diffTooLarge || unstagedDiff.diffTooLarge,
    };
  }
  let snapshot = staging;
  let payloadError: ChangesDiffQuery["payloadError"] = null;
  if (diffMode === "base") {
    snapshot = commitSummary.staging;
    payloadError = commitSummary.payloadError;
  }
  return {
    queriesEnabled,
    stagedFiles: snapshot?.stagedFiles ?? [],
    unstagedFiles: snapshot?.unstagedFiles ?? [],
    stagedLoading: false,
    unstagedLoading: false,
    payloadError,
    diffTooLarge: false,
  };
}

function resolveChangesAvailability({
  files,
  diffMode,
  stagingSupported,
  summarySupported,
  stagingData,
  diffPayloadError,
  diffTooLarge,
}: {
  files: ParsedDiffFile[];
  diffMode: "uncommitted" | "base";
  stagingSupported: boolean;
  summarySupported: boolean;
  stagingData: ReturnType<typeof useChangesStagingData>;
  diffPayloadError: ChangesDiffQuery["payloadError"];
  diffTooLarge: boolean;
}) {
  const hasStagingChanges =
    stagingData.stagedFiles.length > 0 || stagingData.unstagedFiles.length > 0;
  const hasChanges =
    files.length > 0 || (diffMode === "uncommitted" && stagingSupported && hasStagingChanges);
  const canCommit =
    (diffMode === "uncommitted" || (summarySupported && stagingSupported)) &&
    hasCommittableChanges(stagingSupported, stagingData.stagedFiles);
  return {
    hasChanges,
    canCommit,
    diffErrorMessage: resolveDiffError(diffPayloadError, stagingData.payloadError, undefined),
    bodyDiffTooLarge: diffTooLarge || stagingData.diffTooLarge,
  };
}

function WorkingReviewFeedback({
  summarySupported,
  ready,
  reviewActions,
  reviewDiff,
}: {
  summarySupported: boolean;
  ready: boolean;
  reviewActions: WorkingDiffMode["reviewActions"];
  reviewDiff: ChangesDiffQuery;
}) {
  const { t } = useTranslation();
  if (!summarySupported || ready || !reviewActions || reviewActions.commentsByTarget.size === 0) {
    return null;
  }
  let message = t("common.states.loading");
  if (reviewDiff.diffTooLarge || reviewDiff.files.some((file) => file.status === "too_large")) {
    message = t("workspace.git.diff.previewTooLargeDescription");
  }
  if (reviewDiff.payloadError) message = reviewDiff.payloadError.message;
  return (
    <View style={styles.forgeSetupCallout} testID="changes-review-pending">
      <Text style={styles.forgeSetupCalloutText}>
        {t("message.attachments.review")}: {message}
      </Text>
    </View>
  );
}

function useWorkingFileStatus({
  summarySupported,
  fullFiles,
  displayedFiles,
  detailDiff,
  emptyMessage,
}: {
  summarySupported: boolean;
  fullFiles: ParsedDiffFile[];
  displayedFiles: ParsedDiffFile[];
  detailDiff: ChangesDiffQuery;
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!summarySupported) return undefined;
    let message = emptyMessage;
    if (detailDiff.isLoading || !detailDiff.hasSnapshot) message = t("common.states.loading");
    if (detailDiff.diffTooLarge) message = t("workspace.git.diff.previewTooLargeDescription");
    if (detailDiff.payloadError) message = detailDiff.payloadError.message;
    const loadedPaths = new Set(fullFiles.map((file) => file.path));
    const fileStatuses: Record<string, string> = Object.create(null);
    for (const file of displayedFiles) {
      if (loadedPaths.has(file.path) && !detailDiff.payloadError && !detailDiff.diffTooLarge)
        continue;
      fileStatuses[file.path] = message;
    }
    return fileStatuses;
  }, [
    summarySupported,
    fullFiles,
    displayedFiles,
    detailDiff.payloadError,
    detailDiff.diffTooLarge,
    detailDiff.isLoading,
    detailDiff.hasSnapshot,
    emptyMessage,
    t,
  ]);
}

export function ChangesSurface({
  serverId,
  workspaceId,
  cwd,
  enabled,
  host,
  modeScope,
  focusPath,
  focusRequestId,
  onOpenFile,
  onOpenDiff,
  onAddToChat,
  state: changesState,
  onStateChange,
}: ChangesSurfaceProps) {
  const { settings: appSettings } = useAppSettings();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const canUseSplitLayout = resolveCanUseSplitLayout(isMobile);
  const instanceState = resolveChangesState(changesState);
  const updateState = resolveChangesStateChange(onStateChange);
  const wrapLines = instanceState.wrapLines;
  const desktopTreeVisible = instanceState.treeVisible;
  const effectiveLayout = resolveDiffLayout(instanceState.layout, canUseSplitLayout);
  const collapsedFilePaths = instanceState.collapsedFilePaths;
  const documentOnly = host === "panel" && Boolean(focusPath);
  const [panelView, setPanelView] = useState<"tree" | "diff">(() =>
    host === "panel" && focusPath ? "diff" : "tree",
  );
  const showTreeAsPrimaryContent = shouldShowChangesTree(host, panelView);
  const updateCollapsedFilePaths = useCallback(
    (paths: string[]) => updateState({ ...instanceState, collapsedFilePaths: paths }),
    [instanceState, updateState],
  );
  const updateCollapsedFolderPaths = useCallback(
    (paths: string[]) => updateState({ ...instanceState, collapsedFolderPaths: paths }),
    [instanceState, updateState],
  );
  const collapseState = useMemo(
    () => ({ paths: collapsedFilePaths, onChange: updateCollapsedFilePaths }),
    [collapsedFilePaths, updateCollapsedFilePaths],
  );

  const handleToggleWrapLines = useCallback(() => {
    updateState({ ...instanceState, wrapLines: !wrapLines });
  }, [instanceState, updateState, wrapLines]);

  const handleToggleHideWhitespace = useCallback(() => {
    updateState({
      ...instanceState,
      hideWhitespace: !instanceState.hideWhitespace,
    });
  }, [instanceState, updateState]);

  const handleToggleLayout = useCallback(() => {
    updateState({
      ...instanceState,
      layout: instanceState.layout === "unified" ? "split" : "unified",
    });
  }, [instanceState, updateState]);
  const codeFontSize = appSettings.codeFontSize;

  const toast = useToast();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets: desktopOpenTargets } = useDesktopOpenTargets({
    isLocalExecution: isLocalDaemon,
  });
  const fileManagerTarget = desktopOpenTargets.find((target) => target.kind === "file-manager");
  // Tool panels may follow a conversation whose workspace differs from the
  // route that owns the visible tab layout. Diff documents must use that host
  // layout or they are opened successfully into an invisible workspace.
  const layoutWorkspaceKey = useWorkspaceFocusKey();
  const { openCommit: handleCommitPress, onChangesFilePress: workspaceOnChangesFilePress } =
    useDiffTabNavigation({ serverId, workspaceId, layoutWorkspaceKey });
  const onChangesFilePress =
    host === "explorer" ? (onOpenDiff ?? workspaceOnChangesFilePress) : undefined;
  const refreshSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutRefresh === true,
  );
  const stagingSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutStageChanges === true,
  );
  const summarySupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.checkoutDiffSummary === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
  const fsEntryDuplicateEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsEntryDuplicate === true,
  );
  const runRefresh = useCheckoutGitActionsStore((s) => s.refresh);
  const isRefreshing =
    useCheckoutGitActionsStore((s) => s.getStatus({ serverId, cwd, actionId: "refresh" })) ===
    "pending";

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    void runRefresh({ serverId, cwd }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [cwd, isRefreshing, runRefresh, serverId, t, toast]);

  const {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted: handleSelectUncommitted,
    selectBase: handleSelectBase,
    files,
    staging,
    documentFiles,
    detailDiff,
    fullFiles,
    reviewDiff,
    reviewReady,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
  } = useWorkingDiff({
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    ignoreWhitespace: instanceState.hideWhitespace,
    enabled: enabled !== false,
    modeScope,
    summarySupported,
    detailsEnabled: !showTreeAsPrimaryContent,
    focusPath: documentOnly ? focusPath : undefined,
    collapsedFilePaths,
  });
  const discardActions = useDiscardChangesActions({ serverId, cwd, diffMode });
  const stagingData = useChangesStagingData({
    serverId,
    cwd,
    ignoreWhitespace: instanceState.hideWhitespace,
    enabled,
    modeScope,
    summarySupported,
    stagingSupported,
    diffMode,
    isGit,
    documentOnly,
    staging,
  });
  const runStageChanges = useCheckoutGitActionsStore((s) => s.stageChanges);
  const runUnstageChanges = useCheckoutGitActionsStore((s) => s.unstageChanges);
  const stageStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "stage-changes" }),
  );
  const unstageStatus = useCheckoutGitActionsStore((s) =>
    s.getStatus({ serverId, cwd, actionId: "unstage-changes" }),
  );
  const changeMutationPending =
    stageStatus === "pending" || unstageStatus === "pending" || discardActions.pending;
  const handleStagePaths = useCallback(
    (paths: string[]) => {
      if (changeMutationPending || paths.length === 0) return;
      void runStageChanges({ serverId, cwd, paths }).catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t("workspace.git.diff.staging.failedStage"),
        );
      });
    },
    [changeMutationPending, cwd, runStageChanges, serverId, t, toast],
  );
  const handleUnstagePaths = useCallback(
    (paths: string[]) => {
      if (changeMutationPending || paths.length === 0) return;
      void runUnstageChanges({ serverId, cwd, paths }).catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t("workspace.git.diff.staging.failedUnstage"),
        );
      });
    },
    [changeMutationPending, cwd, runUnstageChanges, serverId, t, toast],
  );
  usePublishWorkingDiffAttachment({
    serverId,
    workspaceId: workspaceId ?? undefined,
    cwd,
    attachment: reviewAttachment,
    enabled: true,
    ready: reviewReady,
  });
  const {
    githubFeaturesEnabled,
    forge,
    authState,
    payloadError: prPayloadError,
  } = useCheckoutPrStatusQuery({
    serverId,
    cwd,
    enabled: isGit,
  });
  const forgeProvidersSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.forgeProviders === true,
  );
  const githubNativeAuthSupported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.githubNativeAuth === true,
  );
  const githubOAuthConfigured = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.githubOAuthConfigured === true,
  );
  const forgeSetupAction = computeForgeSetupAction({
    forge,
    forgeProvidersSupported,
    nativeAuthSupported: githubNativeAuthSupported,
    authState,
  });
  const forgeHost = parseForgeHost(status?.remoteUrl);
  const nativeAuthConfigured = resolveNativeAuthConfigured(forgeHost, githubOAuthConfigured);
  const forgeSetupMessage = useMemo(
    () =>
      buildForgeSetupMessage({
        action: forgeSetupAction,
        forge,
        host: parseForgeHost(status?.remoteUrl),
        t,
        nativeAuthConfigured,
      }),
    [forgeSetupAction, forge, nativeAuthConfigured, status?.remoteUrl, t],
  );
  const nativeGitHubSignIn = resolveNativeGitHubSignIn(
    forge === "github",
    forgeSetupAction === "sign_in",
    githubNativeAuthSupported,
    nativeAuthConfigured,
    getForgePresentation(forge).signInKind === "native",
  );
  const handleToggleDesktopTree = useCallback(() => {
    updateState({ ...instanceState, treeVisible: !desktopTreeVisible });
  }, [desktopTreeVisible, instanceState, updateState]);
  const handleCommitsCollapsedChange = useCallback(
    (commitsCollapsed: boolean) => updateState({ ...instanceState, commitsCollapsed }),
    [instanceState, updateState],
  );
  const handleCommitsHeightChange = useCallback(
    (commitsHeight: number) => updateState({ ...instanceState, commitsHeight }),
    [instanceState, updateState],
  );
  const [changesAndCommitsHeight, setChangesAndCommitsHeight] = useState(0);
  const handleChangesAndCommitsLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      setChangesAndCommitsHeight(event.nativeEvent.layout.height);
    },
    [],
  );
  const handleChangesTreeWidth = useCallback(
    (treeWidth: number) => updateState({ ...instanceState, treeWidth }),
    [instanceState, updateState],
  );
  const sharedDisplayPreferences = useMemo(
    () => ({
      layout: effectiveLayout,
      wrapLines,
      codeFontSize,
      monoFontFamily: appSettings.monoFontFamily,
    }),
    [appSettings.monoFontFamily, codeFontSize, effectiveLayout, wrapLines],
  );
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: cwd,
  });
  const handleCopyPath = useCallback(
    (path: string) => {
      void Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: path }),
      );
    },
    [cwd],
  );
  const handleCopyRelativePath = useCallback((path: string) => {
    void Clipboard.setStringAsync(path);
  }, []);
  const handleRevealPath = useCallback(
    async (path: string) => {
      if (!fileManagerTarget) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManagerTarget.id,
          workspacePath: cwd,
          filePath: buildAbsoluteExplorerPath({
            workspaceRoot: cwd,
            entryPath: path,
          }),
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    },
    [cwd, fileManagerTarget, t, toast],
  );
  const handleDownloadPath = useCallback(
    (path: string) => {
      downloadFile({ fileName: path.split("/").pop() ?? path, path });
    },
    [downloadFile],
  );
  const handleDuplicatePath = useCallback(
    async (path: string) => {
      if (!client) {
        return;
      }
      try {
        const payload = await client.duplicateFileEntry({ cwd, path });
        if (!payload.success) {
          toast.error(payload.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, cwd, t, toast],
  );
  const onRevertPath = discardActions.discardAll;
  useEffect(() => {
    if (host === "panel" && focusPath) {
      setPanelView("diff");
    }
  }, [focusPath, focusRequestId, host]);
  const [localFocusRequest, setLocalFocusRequest] = useState<{
    path: string;
    revision: number;
  } | null>(null);
  const externalFocusRequest = useMemo(
    () => (focusPath ? { path: focusPath, revision: focusRequestId ?? 0 } : null),
    [focusPath, focusRequestId],
  );
  const documentFocusRequest = selectDocumentFocusRequest(localFocusRequest, externalFocusRequest);
  const handleSelectTreeFile = useCallback(
    (path: string) => {
      if (host === "explorer" && onChangesFilePress) {
        onChangesFilePress(path);
        return;
      }
      setPanelView("diff");
      updateCollapsedFilePaths(collapsedFilePaths.filter((entry) => entry !== path));
      setLocalFocusRequest((current) => ({
        path,
        revision: Math.max(Date.now(), (current?.revision ?? 0) + 1),
      }));
    },
    [host, onChangesFilePress, collapsedFilePaths, updateCollapsedFilePaths],
  );
  const handleShowTree = useCallback(() => setPanelView("tree"), []);
  const workingMode = useMemo(
    () => ({
      kind: "working" as const,
      reviewActions,
      onFilePress: onChangesFilePress,
      focusPath: documentFocusRequest?.path,
      focusRequestId: documentFocusRequest?.revision,
      workspaceFileDragScope: workspaceId ? { serverId, workspaceId } : undefined,
      onOpenFile,
      onAddToChat,
      onCopyPath: handleCopyPath,
      onCopyRelativePath: handleCopyRelativePath,
      onReveal: fileManagerTarget ? handleRevealPath : undefined,
      revealTargetName: fileManagerTarget?.label,
      onDownload: handleDownloadPath,
      onDuplicate: fsEntryDuplicateEnabled ? handleDuplicatePath : undefined,
      onRevert: onRevertPath,
    }),
    [
      reviewActions,
      onChangesFilePress,
      documentFocusRequest?.path,
      documentFocusRequest?.revision,
      serverId,
      workspaceId,
      onOpenFile,
      onAddToChat,
      handleCopyPath,
      handleCopyRelativePath,
      handleDownloadPath,
      handleDuplicatePath,
      handleRevealPath,
      fileManagerTarget,
      fsEntryDuplicateEnabled,
      onRevertPath,
    ],
  );

  const { stagedFiles, unstagedFiles } = stagingData;
  const { hasChanges, canCommit, diffErrorMessage, bodyDiffTooLarge } = resolveChangesAvailability({
    files,
    diffMode,
    stagingSupported,
    summarySupported,
    stagingData,
    diffPayloadError,
    diffTooLarge,
  });
  const { displayedFiles, isStagingDiffLoading, allFilesCollapsed, showChangesTreeRail } = useMemo(
    () =>
      resolveChangesViewState({
        files: showTreeAsPrimaryContent ? files : documentFiles,
        focusPath,
        documentOnly,
        stagingQueriesEnabled: stagingData.queriesEnabled,
        stagedLoading: stagingData.stagedLoading,
        unstagedLoading: stagingData.unstagedLoading,
        collapsedFilePaths,
        host,
        panelView,
        desktopTreeVisible,
        isMobile,
      }),
    [
      collapsedFilePaths,
      desktopTreeVisible,
      documentOnly,
      files,
      documentFiles,
      showTreeAsPrimaryContent,
      focusPath,
      host,
      isMobile,
      panelView,
      stagingData.stagedLoading,
      stagingData.queriesEnabled,
      stagingData.unstagedLoading,
    ],
  );
  const handleCollapseAllFiles = useCallback(
    () => updateCollapsedFilePaths(files.map((file) => file.path)),
    [files, updateCollapsedFilePaths],
  );
  const handleExpandAllFiles = useCallback(
    () => updateCollapsedFilePaths([]),
    [updateCollapsedFilePaths],
  );
  const reviewFeedback = (
    <WorkingReviewFeedback
      summarySupported={summarySupported}
      ready={reviewReady}
      reviewActions={reviewActions}
      reviewDiff={reviewDiff}
    />
  );
  const prErrorMessage = resolvePrStatusErrorMessage({
    featuresEnabled: githubFeaturesEnabled,
    error: prPayloadError,
    repositoryAccessMessage: t("workspace.git.diff.repositoryAccessError", {
      brand: getForgePresentation(forge).brandLabel,
    }),
  });
  const baseRefLabel = useMemo(
    () => computeBaseRefLabel(baseRef, t("workspace.git.diff.base")),
    [baseRef, t],
  );
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const emptyMessage = computeEmptyMessage(instanceState.hideWhitespace, diffMode, baseRefLabel, {
    hiddenWhitespace: t("workspace.git.diff.emptyHiddenWhitespace"),
    uncommitted: t("workspace.git.diff.emptyUncommitted"),
    againstBase: (label) => t("workspace.git.diff.emptyAgainstBase", { baseRef: label }),
  });
  const fileStatus = useWorkingFileStatus({
    summarySupported,
    fullFiles,
    displayedFiles,
    detailDiff,
    emptyMessage,
  });
  const emptyAction = computeChangesEmptyAction({
    hideWhitespace: instanceState.hideWhitespace,
    diffMode,
    status,
    seeUncommittedLabel: t("workspace.git.diff.seeUncommittedChanges"),
    seeCommittedLabel: t("workspace.git.diff.seeCommittedChanges"),
    selectUncommitted: handleSelectUncommitted,
    selectBase: handleSelectBase,
  });
  const showStagingTree = canQueryStagingDiffs(
    stagingSupported,
    diffMode,
    isGit,
    showTreeAsPrimaryContent,
  );
  const showGenericChangesHeader = !showStagingTree;

  let primaryChangesContent: ReactElement;
  if (showStagingTree) {
    primaryChangesContent = (
      <StagingChangesTree
        stagedFiles={stagedFiles}
        unstagedFiles={unstagedFiles}
        mode={workingMode}
        onSelectFile={handleSelectTreeFile}
        collapsedFolderPaths={instanceState.collapsedFolderPaths}
        onCollapsedFolderPathsChange={updateCollapsedFolderPaths}
        mutationPending={changeMutationPending}
        onStagePaths={handleStagePaths}
        onUnstagePaths={handleUnstagePaths}
        onDiscardPaths={discardActions.discardUnstaged}
      />
    );
  } else if (showTreeAsPrimaryContent) {
    primaryChangesContent = (
      <ChangedFilesTree
        files={files}
        mode={workingMode}
        onSelectFile={handleSelectTreeFile}
        collapsedFolderPaths={instanceState.collapsedFolderPaths}
        onCollapsedFolderPathsChange={updateCollapsedFolderPaths}
      />
    );
  } else {
    primaryChangesContent = (
      <DiffDocument
        files={displayedFiles}
        fileStatus={fileStatus}
        collapseState={collapseState}
        displayPreferences={sharedDisplayPreferences}
        mode={workingMode}
      />
    );
  }

  const diffContent: ReactElement = (
    <DiffBodyContent
      isStatusLoading={isStatusLoading}
      statusErrorMessage={statusErrorMessage}
      notGit={notGit}
      isDiffLoading={isDiffLoading || isStagingDiffLoading}
      diffErrorMessage={diffErrorMessage}
      diffTooLarge={bodyDiffTooLarge}
      hasChanges={documentOnly ? displayedFiles.length > 0 : hasChanges}
      emptyMessage={emptyMessage}
      emptyAction={emptyAction}
      checkingRepositoryLabel={t("workspace.git.diff.checkingRepository")}
      notRepositoryLabel={t("workspace.git.diff.notRepository")}
    >
      {primaryChangesContent}
    </DiffBodyContent>
  );
  const bodyContent = documentOnly ? (
    diffContent
  ) : (
    <ChangesTreeRail
      shown={showChangesTreeRail}
      files={files}
      mode={workingMode}
      onSelectFile={handleSelectTreeFile}
      treeWidth={instanceState.treeWidth}
      onTreeWidthChange={handleChangesTreeWidth}
      collapsedFolderPaths={instanceState.collapsedFolderPaths}
      onCollapsedFolderPathsChange={updateCollapsedFolderPaths}
    >
      {diffContent}
    </ChangesTreeRail>
  );

  if (documentOnly) {
    return (
      <View
        {...{
          onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
        }}
        style={styles.container}
        testID="working-file-diff"
      >
        {reviewFeedback}
        <View style={styles.diffContainer}>{bodyContent}</View>
      </View>
    );
  }

  function renderContent(): ReactElement {
    let forgeSetupCallout: ReactElement | null = null;
    if (forgeSetupMessage) {
      forgeSetupCallout = nativeGitHubSignIn ? (
        <GitHubAuthCallout
          serverId={serverId}
          cwd={cwd}
          host={forgeHost}
          message={forgeSetupMessage}
          onAuthenticated={handleRefresh}
        />
      ) : (
        <View style={styles.forgeSetupCallout} testID="forge-setup-callout">
          <Text style={styles.forgeSetupCalloutText}>{forgeSetupMessage}</Text>
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
        {isGit ? (
          <ChangesToolbar
            branchName={currentBranchName}
            baseRefLabel={baseRef ?? baseRefLabel}
            allFilesCollapsed={allFilesCollapsed}
            canUseSplitLayout={canUseSplitLayout}
            cwd={cwd}
            desktopTreeVisible={desktopTreeVisible}
            diffMode={diffMode}
            treeToggleAvailable={panelView === "diff"}
            gitActions={gitActions}
            hasFiles={hasChanges}
            hideWhitespace={instanceState.hideWhitespace}
            host={host}
            isMobile={isMobile}
            isRefreshing={isRefreshing}
            layout={instanceState.layout}
            refreshSupported={refreshSupported}
            serverId={serverId}
            workspaceId={workspaceId}
            wrapLines={wrapLines}
            onCollapseAll={handleCollapseAllFiles}
            onExpandAll={handleExpandAllFiles}
            onRefresh={handleRefresh}
            onSelectUncommitted={handleSelectUncommitted}
            onSelectBase={handleSelectBase}
            onToggleDesktopTree={handleToggleDesktopTree}
            onToggleHideWhitespace={handleToggleHideWhitespace}
            onToggleLayout={handleToggleLayout}
            onToggleWrapLines={handleToggleWrapLines}
          />
        ) : null}

        {isGit ? (
          <>
            <CommitComposer
              serverId={serverId}
              cwd={cwd}
              branchName={currentBranchName}
              hasChanges={canCommit}
            />
            {showGenericChangesHeader ? (
              <View style={styles.changesSectionHeader} testID="changes-tree-header">
                {host === "panel" && panelView === "diff" ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t("common.actions.back")}: ${t(
                      "workspace.tabs.sidePanel.changes",
                    )}`}
                    onPress={handleShowTree}
                    style={styles.changesSectionBack}
                    testID="changes-show-file-tree"
                  >
                    <ThemedChevronLeft size={14} uniProps={foregroundMutedIconColorMapping} />
                    <Text style={styles.changesSectionTitle}>
                      {t("workspace.tabs.sidePanel.changes")}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.changesSectionTitle}>
                    {t("workspace.tabs.sidePanel.changes")}
                  </Text>
                )}
                <View style={styles.changesCountBadge}>
                  <Text style={styles.changesCountText}>{files.length}</Text>
                </View>
              </View>
            ) : null}
          </>
        ) : null}

        {forgeSetupCallout}

        {prErrorMessage ? (
          <View style={styles.forgeSetupCallout} testID="forge-status-error-callout">
            <Text style={styles.forgeSetupCalloutText}>{prErrorMessage}</Text>
          </View>
        ) : null}
        {reviewFeedback}

        <View style={styles.changesAndCommitsContainer} onLayout={handleChangesAndCommitsLayout}>
          <View style={styles.diffContainer}>{bodyContent}</View>

          <CommitsSection
            serverId={serverId}
            cwd={cwd}
            currentBranchName={currentBranchName}
            onCommitPress={handleCommitPress}
            collapsed={instanceState.commitsCollapsed}
            onCollapsedChange={handleCommitsCollapsedChange}
            height={instanceState.commitsHeight}
            availableHeight={changesAndCommitsHeight}
            onHeightChange={handleCommitsHeightChange}
          />
        </View>
      </View>
    );
  }

  return renderContent();
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  changesToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderBottomWidth: 0,
  },
  changesToolbarIdentity: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  changesToolbarControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  forgeSetupCallout: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  forgeSetupCalloutText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  stagingTree: {
    flex: 1,
    minHeight: 0,
  },
  stagingSectionHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
  },
  stagingSectionToggle: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stagingSectionChevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-90deg" }],
  },
  stagingSectionChevronOpen: {
    transform: [{ rotate: "0deg" }],
  },
  stagingSectionTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  changeRowActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  stageAction: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
  },
  stageActionHovered: {
    backgroundColor: theme.colors.surface2,
  },
  stageActionDisabled: {
    opacity: 0.5,
  },
  changesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  changesSectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  changesSectionBack: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  changesCountBadge: {
    minWidth: 24,
    height: 20,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  changesCountText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  changesAndCommitsContainer: {
    flex: 1,
    minHeight: 0,
  },
  diffContainer: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
  },
  scrollView: {
    flex: 1,
  },
  scrollContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  contentContainer: {
    paddingBottom: theme.spacing[8],
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[4],
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    paddingHorizontal: theme.spacing[6],
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: theme.spacing[16],
    gap: theme.spacing[2],
  },
  emptyText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
