import { describe, expect, it, vi } from "vitest";
import type { ExplorerEntry } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store/state";
import {
  flattenExplorerTree,
  reconcileRestoredExpandedPaths,
  restoreExpandedDirectories,
  setExpandedDirectoryPath,
  showHiddenFilesAndRestoreExpandedDirectories,
} from "./tree";

function makeDirectoryEntry(name: string, path: string): ExplorerEntry {
  return {
    name,
    path,
    kind: "directory",
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("file explorer tree", () => {
  it("flattens a deeply expanded tree without consuming the call stack", () => {
    const depth = 10_000;
    const directories = new Map<string, { path: string; entries: ExplorerEntry[] }>();
    const expandedPaths = new Set<string>(["."]);
    let parentPath = ".";

    for (let index = 1; index <= depth; index += 1) {
      const childPath = `directory-${index}`;
      directories.set(parentPath, {
        path: parentPath,
        entries: [makeDirectoryEntry(childPath, childPath)],
      });
      expandedPaths.add(childPath);
      parentPath = childPath;
    }
    directories.set(parentPath, { path: parentPath, entries: [] });

    const rows = flattenExplorerTree({
      directories,
      expandedPaths,
      sortOption: "name",
      showHiddenFiles: true,
    });

    expect(rows).toHaveLength(depth);
    expect(rows[0]).toEqual({
      entry: makeDirectoryEntry("directory-1", "directory-1"),
      depth: 0,
    });
    expect(rows.at(-1)).toEqual({
      entry: makeDirectoryEntry(`directory-${depth}`, `directory-${depth}`),
      depth: depth - 1,
    });
  });

  it("flattens entries when Array.prototype.toReversed is unavailable", () => {
    const toReversedDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toReversed");
    Reflect.deleteProperty(Array.prototype, "toReversed");

    try {
      const directories = new Map([
        [
          ".",
          {
            path: ".",
            entries: [makeDirectoryEntry("bravo", "bravo"), makeDirectoryEntry("alpha", "alpha")],
          },
        ],
      ]);

      const rows = flattenExplorerTree({
        directories,
        expandedPaths: new Set(["."]),
        sortOption: "name",
        showHiddenFiles: true,
      });

      expect(rows.map(({ entry }) => entry.name)).toEqual(["alpha", "bravo"]);
    } finally {
      if (toReversedDescriptor) {
        Reflect.defineProperty(Array.prototype, "toReversed", toReversedDescriptor);
      } else {
        Reflect.deleteProperty(Array.prototype, "toReversed");
      }
    }
  });

  it("flattens a large expanded directory without spreading its rows into the parent", () => {
    const fileCount = 150_000;
    const files = Array.from(
      { length: fileCount },
      (_, index): ExplorerEntry => ({
        name: `file-${index.toString().padStart(6, "0")}`,
        path: `generated/file-${index}`,
        kind: "file",
        size: index,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const child = makeDirectoryEntry("generated", "generated");
    const directories = new Map([
      [".", { path: ".", entries: [child] }],
      ["generated", { path: "generated", entries: files }],
    ]);

    const rows = flattenExplorerTree({
      directories,
      expandedPaths: new Set([".", "generated"]),
      sortOption: "name",
      showHiddenFiles: true,
    });

    expect(rows).toHaveLength(fileCount + 1);
    expect(rows[0]).toEqual({ entry: child, depth: 0 });
    expect(rows.at(-1)).toEqual({ entry: files[fileCount - 1], depth: 1 });
  });

  it("preserves directories-first ordering, stable ties and hidden filtering across cached modes", () => {
    const file = (name: string, size: number, day: string): ExplorerEntry => ({
      ...makeDirectoryEntry(name, name),
      kind: "file",
      size,
      modifiedAt: `2026-01-${day}T00:00:00.000Z`,
    });
    const root = {
      path: ".",
      entries: [
        file("z", 2, "02"),
        makeDirectoryEntry("folder-b", "folder-b"),
        file("a", 2, "02"),
        file(".hidden", 3, "03"),
        makeDirectoryEntry("folder-a", "folder-a"),
        file("b", 1, "01"),
      ],
    };
    const directories = new Map([[".", root]]);
    const paths = (sortOption: SortOption, showHiddenFiles: boolean) =>
      flattenExplorerTree({
        directories,
        expandedPaths: new Set(["."]),
        sortOption,
        showHiddenFiles,
      }).map(({ entry }) => entry.path);

    for (let pass = 0; pass < 2; pass += 1) {
      expect(paths("name", false)).toEqual(["folder-a", "folder-b", "a", "b", "z"]);
      expect(paths("name", true)).toEqual(["folder-a", "folder-b", ".hidden", "a", "b", "z"]);
      for (const sort of ["size", "modified"] as const) {
        expect(paths(sort, false)).toEqual(["folder-b", "folder-a", "z", "a", "b"]);
        expect(paths(sort, true)).toEqual(["folder-b", "folder-a", ".hidden", "z", "a", "b"]);
      }
    }
    expect(root.entries.map((entry) => entry.path)).toEqual([
      "z",
      "folder-b",
      "a",
      ".hidden",
      "folder-a",
      "b",
    ]);
    directories.set(".", { path: ".", entries: [file("replacement", 0, "01")] });
    expect(paths("name", false)).toEqual(["replacement"]);
  });

  it("does not sort unchanged directories again when another listing is replaced", () => {
    const directories = new Map([
      [
        ".",
        {
          path: ".",
          entries: [makeDirectoryEntry("bravo", "bravo"), makeDirectoryEntry("alpha", "alpha")],
        },
      ],
      [
        "alpha",
        {
          path: "alpha",
          entries: [makeDirectoryEntry("two", "alpha/two"), makeDirectoryEntry("one", "alpha/one")],
        },
      ],
    ]);
    const input = {
      directories,
      expandedPaths: new Set([".", "alpha"]),
      sortOption: "name" as const,
      showHiddenFiles: true,
    };
    flattenExplorerTree(input);
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      directories.set("alpha", {
        path: "alpha",
        entries: [makeDirectoryEntry("new", "alpha/new")],
      });
      expect(flattenExplorerTree(input).map(({ entry }) => entry.path)).toEqual([
        "alpha",
        "alpha/new",
        "bravo",
      ]);
      expect(compare).not.toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });

  it.each([
    { maxDepth: undefined, restoredDepth: 5 },
    { maxDepth: Number.POSITIVE_INFINITY, restoredDepth: 6 },
  ])(
    "restores $restoredDepth rendered levels with maxDepth=$maxDepth",
    async ({ maxDepth, restoredDepth }) => {
      const paths = [
        "generated/cache/level-1",
        "generated/cache/level-1/level-2",
        "generated/cache/level-1/level-2/level-3",
        "generated/cache/level-1/level-2/level-3/level-4",
        "generated/cache/level-1/level-2/level-3/level-4/level-5",
        "generated/cache/level-1/level-2/level-3/level-4/level-5/level-6",
      ];
      const directories = new Map<string, { path: string; entries: ExplorerEntry[] }>();
      const rootDirectory = {
        path: ".",
        entries: [makeDirectoryEntry("level-1", paths[0])],
      };
      directories.set(".", rootDirectory);
      for (let index = 0; index < paths.length - 1; index += 1) {
        directories.set(paths[index], {
          path: paths[index],
          entries: [makeDirectoryEntry(`level-${index + 2}`, paths[index + 1])],
        });
      }
      directories.set(paths[5], { path: paths[5], entries: [] });

      const expandedPaths = await restoreExpandedDirectories({
        rootDirectory,
        persistedExpandedPaths: new Set(paths),
        showHiddenFiles: true,
        maxDepth,
        requestDirectoryListing: async (path) => directories.get(path) ?? null,
      });

      expect(expandedPaths).toEqual([".", ...paths.slice(0, restoredDepth)]);
    },
  );

  it("does not restore persisted descendants beneath a collapsed rendered directory", async () => {
    const rootDirectory = {
      path: ".",
      entries: [makeDirectoryEntry("parent", "parent")],
    };
    const requestedPaths: string[] = [];

    const expandedPaths = await restoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: new Set(["parent/child", "parent/child/grandchild"]),
      showHiddenFiles: true,
      requestDirectoryListing: async (path) => {
        requestedPaths.push(path);
        return null;
      },
    });

    expect(requestedPaths).toEqual([]);
    expect(expandedPaths).toEqual(["."]);
  });

  it("preserves expansion changes made while persisted directories are restoring", () => {
    const paths = reconcileRestoredExpandedPaths({
      persistedExpandedPaths: new Set([".", "parent", "parent/child"]),
      currentExpandedPaths: new Set([".", "parent/child", "manual"]),
      restoredExpandedPaths: [".", "parent"],
    });

    expect(paths).toEqual([".", "manual"]);
  });

  it("applies a directory click to the latest restored expansion paths", () => {
    const expanded = setExpandedDirectoryPath({
      currentExpandedPaths: [".", "restored"],
      directoryPath: "manual",
      expanded: true,
    });
    const collapsed = setExpandedDirectoryPath({
      currentExpandedPaths: expanded,
      directoryPath: "manual",
      expanded: false,
    });

    expect(expanded).toEqual([".", "restored", "manual"]);
    expect(collapsed).toEqual([".", "restored"]);
  });

  it("shows hidden files before waiting for expanded directories to restore", async () => {
    const rootDirectory = {
      path: ".",
      entries: [makeDirectoryEntry(".hidden", ".hidden")],
    };
    let resolveDirectory!: (directory: { path: string; entries: ExplorerEntry[] }) => void;
    const directoryListing = new Promise<{ path: string; entries: ExplorerEntry[] }>((resolve) => {
      resolveDirectory = resolve;
    });
    let hiddenFilesAreShown = false;

    const restoration = showHiddenFilesAndRestoreExpandedDirectories({
      rootDirectory,
      persistedExpandedPaths: new Set([".hidden"]),
      showHiddenFiles: () => {
        hiddenFilesAreShown = true;
      },
      requestDirectoryListing: () => directoryListing,
    });

    expect(hiddenFilesAreShown).toBe(true);
    resolveDirectory({ path: ".hidden", entries: [] });
    await expect(restoration).resolves.toEqual([".", ".hidden"]);
  });
});
