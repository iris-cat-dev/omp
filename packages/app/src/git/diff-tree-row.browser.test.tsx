import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileActionsMenuButton } from "@/components/file-actions-menu";
import {
  WORKSPACE_TREE_ROW_HEIGHT,
  WORKSPACE_TREE_ROW_HEIGHT_TOUCH,
} from "@/components/tree-primitives";
import { FILE_HEADER_HEIGHT } from "@/git/diff-document/model";
import { DiffFolderRow } from "./diff-folder-row";
import { FileHeader } from "./file-header";
import type { ParsedDiffFile } from "./use-diff-query";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const sampleFile: ParsedDiffFile = {
  path: "src/components/example.tsx",
  isNew: false,
  isDeleted: false,
  additions: 12,
  deletions: 4,
  hunks: [],
};

const trailingButton = <FileActionsMenuButton />;
const noop = () => {};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("diff tree row heights", () => {
  it("matches the shared tree row height across folder rows, file tree rows, and touch mode", async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    container.style.cssText = "width:320px";
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          <View>
            <DiffFolderRow
              dirPath="src/components"
              displayName="src/components"
              depth={0}
              collapsed={false}
              isSelected={false}
              additions={12}
              deletions={4}
              onToggle={noop}
              onCollapse={noop}
              onSelect={noop}
              testID="folder-plain"
            />
            <DiffFolderRow
              dirPath="src/components"
              displayName="src/components"
              depth={0}
              collapsed={false}
              isSelected={false}
              additions={12}
              deletions={4}
              onToggle={noop}
              onCollapse={noop}
              onSelect={noop}
              trailingAction={trailingButton}
              testID="folder-with-action"
            />
            <FileHeader
              file={sampleFile}
              bodyVisible={false}
              showsBodyState={false}
              depth={1}
              showDir={false}
              testID="file-tree-plain"
            />
            <FileHeader
              file={sampleFile}
              bodyVisible={false}
              showsBodyState={false}
              depth={1}
              showDir={false}
              trailingAction={trailingButton}
              testID="file-tree-with-action"
            />
            <FileHeader file={sampleFile} bodyVisible showsBodyState testID="file-document" />
          </View>,
        ),
      );

      const heightOf = (testId: string) =>
        container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.getBoundingClientRect()
          .height;

      expect(heightOf("folder-plain")).toBe(WORKSPACE_TREE_ROW_HEIGHT);
      expect(heightOf("folder-with-action")).toBe(WORKSPACE_TREE_ROW_HEIGHT);
      expect(heightOf("file-tree-plain")).toBe(WORKSPACE_TREE_ROW_HEIGHT);
      expect(heightOf("file-tree-with-action")).toBe(WORKSPACE_TREE_ROW_HEIGHT);
      expect(heightOf("file-document")).toBe(FILE_HEADER_HEIGHT);

      await act(async () => {
        window.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
        );
      });

      expect(heightOf("folder-plain")).toBe(WORKSPACE_TREE_ROW_HEIGHT_TOUCH);
      expect(heightOf("folder-with-action")).toBe(WORKSPACE_TREE_ROW_HEIGHT_TOUCH);
      expect(heightOf("file-tree-plain")).toBe(WORKSPACE_TREE_ROW_HEIGHT_TOUCH);
      expect(heightOf("file-tree-with-action")).toBe(WORKSPACE_TREE_ROW_HEIGHT_TOUCH);
      expect(heightOf("file-document")).toBe(FILE_HEADER_HEIGHT);
    } finally {
      await act(async () => {
        window.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
        );
      });
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
