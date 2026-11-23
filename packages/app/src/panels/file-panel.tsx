import { Text, View } from "react-native";
import { useCallback, useMemo } from "react";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { FilePane } from "@/file-pane/pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { createMaterialFileIcon } from "@/components/material-file-icon";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { TreeRail } from "@/components/tree-rail";
import { useIsCompactFormFactor } from "@/constants/layout";
import { defaultFileState, fileStateSchema } from "@/panels/file/state";
import { usePanelState } from "@/panels/use-panel-state";
import { resolvePluginFilePanel, type ResolvedPluginFilePanel } from "@/plugins/file-panel";
import { usePluginContributions } from "@/plugins/hooks";
import { PluginView, usePluginHostProps } from "@/plugins/view";
import type { WorkspaceFileLocation } from "@/workspace/file-open";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useFilePanelDescriptor(target: { kind: "file"; path: string }) {
  const fileName = target.path.split("/").findLast(Boolean) ?? target.path;
  const icon = useMemo(() => createMaterialFileIcon(fileName), [fileName]);
  return {
    label: fileName,
    subtitle: target.path,
    tooltip: target.path,
    titleState: "ready" as const,
    icon,
    statusBucket: null,
  };
}

function PluginFileEditor({ editor }: { editor: ResolvedPluginFilePanel }) {
  const { serverId, workspaceId } = usePaneContext();
  const host = usePluginHostProps(serverId);
  const {
    instance,
    contribution: { Component },
    filePath,
  } = editor;
  return (
    <PluginView instance={instance} hostId={serverId}>
      <Component
        key={filePath}
        {...host}
        context="workspace"
        workspaceId={workspaceId}
        filePath={filePath}
      />
    </PluginView>
  );
}

function FilePanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, fileNavigationRevision, retargetCurrentTab } =
    usePaneContext();
  const [fileState, setFileState] = usePanelState(fileStateSchema, defaultFileState);
  const isCompact = useIsCompactFormFactor();
  const treeVisible = fileState.treeVisible;
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const pluginPanels = usePluginContributions("panel");
  const handleOpenFile = useCallback(
    (location: WorkspaceFileLocation) => retargetCurrentTab({ kind: "file", ...location }),
    [retargetCurrentTab],
  );
  const handleTreeWidthChange = useCallback(
    (treeWidth: number) => setFileState({ ...fileState, treeWidth }),
    [fileState, setFileState],
  );
  invariant(target.kind === "file", "FilePanel requires file target");
  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  const editor = resolvePluginFilePanel(pluginPanels, serverId, {
    path: target.path,
    workspaceRoot: workspaceDirectory,
  });
  const content = editor ? (
    <PluginFileEditor key={editor.key} editor={editor} />
  ) : (
    <FilePane
      serverId={serverId}
      workspaceRoot={workspaceDirectory}
      location={target}
      navigationRevision={fileNavigationRevision ?? 0}
    />
  );
  // Branch around the whole rail rather than making the tree slot conditional —
  // see the `TreeRail` children contract.
  if (isCompact || !treeVisible) {
    return content;
  }
  return (
    <TreeRail
      testID="file-tree-rail"
      width={fileState.treeWidth ?? 220}
      onWidthChange={handleTreeWidthChange}
      minimumWidth={160}
    >
      {content}
      <FileExplorerPane
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceRoot={workspaceDirectory}
        onOpenFile={handleOpenFile}
      />
    </TreeRail>
  );
}

export const filePanelRegistration: PanelRegistration<"file"> = {
  kind: "file",
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
  resourceKey: (target) => target.path,
};
