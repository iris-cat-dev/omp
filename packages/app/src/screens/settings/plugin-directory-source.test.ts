import type {
  DaemonClient,
  FileExplorerDirectoryPayload,
  FileReadResult,
} from "@omp-desktop/client/internal/daemon-client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inspectPluginDirectorySource } from "./plugin-directory-source";
import { i18n } from "@/i18n/i18next";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const directory = "/project/plugins/example";
const desktopMetadata = {
  apiVersion: 1,
  id: "declared-plugin",
  owner: "desktop",
  entries: { client: "./dist/client.js" },
  capabilities: [],
};

function sourceClient(files: Record<string, string>, folders: string[] = []) {
  const listing: FileExplorerDirectoryPayload = {
    path: ".",
    entries: [
      ...Object.keys(files).map((name) => ({
        name,
        path: name,
        kind: "file" as const,
        size: files[name]!.length,
        modifiedAt: "2026-11-01T00:00:00Z",
      })),
      ...folders.map((name) => ({
        name,
        path: name,
        kind: "directory" as const,
        size: 0,
        modifiedAt: "2026-11-01T00:00:00Z",
      })),
    ],
  };
  return {
    listDirectory: vi.fn(async (): Promise<FileExplorerDirectoryPayload> => listing),
    readFile: vi.fn(async (_cwd: string, path: string): Promise<FileReadResult> => {
      if (!Object.hasOwn(files, path)) throw new Error(`Missing file: ${path}`);
      const bytes = new TextEncoder().encode(files[path]);
      return {
        bytes,
        path,
        mime: "application/json",
        size: bytes.length,
        kind: "text",
        modifiedAt: "2026-11-01T00:00:00Z",
      };
    }),
  } satisfies Pick<DaemonClient, "listDirectory" | "readFile">;
}

function pkg(value: unknown) {
  return { "package.json": JSON.stringify(value) };
}

describe("inspectPluginDirectorySource", () => {
  it.each(["desktop", "daemon"] as const)(
    "uses the declared %s owner and Desktop id",
    async (owner) => {
      const client = sourceClient(
        pkg({
          name: "different-package-name",
          version: "1.0.0",
          ompDesktop: { ...desktopMetadata, owner },
        }),
      );
      await expect(inspectPluginDirectorySource(directory, client)).resolves.toEqual({
        kind: "desktop",
        owner,
        id: "declared-plugin",
      });
      expect(client.listDirectory).toHaveBeenCalledWith(directory, ".");
      expect(client.readFile).toHaveBeenCalledWith(directory, "package.json");
    },
  );

  it("classifies legacy service manifests as daemon-owned", async () => {
    const client = sourceClient({
      ...pkg({ name: "ordinary-package" }),
      "omp-plugin.json": JSON.stringify({ id: "legacy-plugin" }),
      "index.ts": "throw new Error('must never execute')",
    });
    await expect(inspectPluginDirectorySource(directory, client)).resolves.toEqual({
      kind: "desktop",
      owner: "daemon",
      id: "legacy-plugin",
    });
    expect(client.readFile.mock.calls.map(([, path]) => path)).toEqual([
      "package.json",
      "omp-plugin.json",
    ]);
  });

  it.each(["omp", "pi"])(
    "detects native %s metadata using the exact package name",
    async (field) => {
      const client = sourceClient(
        pkg({
          name: "@example/native-plugin",
          version: "1.0.0",
          [field]: { extensions: ["./extension.ts"] },
        }),
      );
      await expect(inspectPluginDirectorySource(directory, client)).resolves.toEqual({
        kind: "native",
        id: "@example/native-plugin",
      });
    },
  );

  it.each([null, {}, { ...desktopMetadata, owner: "native" }, { ...desktopMetadata, entries: {} }])(
    "rejects malformed Desktop metadata %j",
    async (ompDesktop) => {
      await expect(
        inspectPluginDirectorySource(directory, sourceClient(pkg({ name: "example", ompDesktop }))),
      ).rejects.toThrow();
    },
  );

  it.each([null, true, "./extension.ts", [], 12])(
    "rejects nonobject native metadata %j",
    async (omp) => {
      await expect(
        inspectPluginDirectorySource(directory, sourceClient(pkg({ name: "example", omp }))),
      ).rejects.toThrow();
    },
  );

  it.each([undefined, "", "../../escape", 12])(
    "requires a valid native package name %j",
    async (name) => {
      await expect(
        inspectPluginDirectorySource(directory, sourceClient(pkg({ name, pi: {} }))),
      ).rejects.toThrow();
    },
  );

  const ambiguousSources: Record<string, string>[] = [
    { ...pkg({ name: "example", ompDesktop: desktopMetadata, omp: {} }) },
    {
      ...pkg({ name: "example", pi: {} }),
      "omp-plugin.json": JSON.stringify({ id: "legacy-plugin" }),
    },
    {
      ...pkg({ ompDesktop: desktopMetadata }),
      "omp-plugin.json": JSON.stringify({ id: "legacy-plugin" }),
    },
  ];
  it.each(ambiguousSources)("rejects ambiguous plugin formats", async (files) => {
    await expect(inspectPluginDirectorySource(directory, sourceClient(files))).rejects.toThrow();
  });

  it("requires the existing strict legacy manifest format", async () => {
    await expect(
      inspectPluginDirectorySource(
        directory,
        sourceClient({
          "omp-plugin.json": JSON.stringify({ id: "legacy-plugin", owner: "desktop" }),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects an ordinary package instead of falling back to native", async () => {
    await expect(
      inspectPluginDirectorySource(directory, sourceClient(pkg({ name: "ordinary-package" }))),
    ).rejects.toThrow();
  });

  it("rejects invalid JSON without falling back to native", async () => {
    await expect(
      inspectPluginDirectorySource(
        directory,
        sourceClient({
          "package.json": "{bad json",
          "omp-plugin.json": JSON.stringify({ id: "legacy-plugin" }),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects directories posing as manifests", async () => {
    await expect(
      inspectPluginDirectorySource(directory, sourceClient({}, ["package.json"])),
    ).rejects.toThrow();
  });

  it("propagates read failures instead of changing the plugin kind", async () => {
    const client = sourceClient(pkg({ ompDesktop: desktopMetadata }));
    client.readFile.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(inspectPluginDirectorySource(directory, client)).rejects.toThrow(
      "Permission denied",
    );
  });
});
