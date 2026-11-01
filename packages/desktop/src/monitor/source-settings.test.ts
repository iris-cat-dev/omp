import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpLocalMonitor } from "./collector.js";
import {
  canonicalOmpSourcePath,
  defaultOmpMonitorFolder,
  resolveOmpMonitorRoots,
  selectedOmpSourceFolder,
} from "./roots.js";
import {
  readMonitorSourcePreferences,
  writeMonitorSourcePreferences,
} from "./window-preferences.js";

const storage = vi.hoisted(() => ({
  beforeCopy: undefined as ((source: string, target: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((source: string, target: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    async copyFile(...args: Parameters<typeof actual.copyFile>) {
      await storage.beforeCopy?.(String(args[0]), String(args[1]));
      return actual.copyFile(...args);
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      await storage.beforeRename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
  };
});

const directories: string[] = [];
const monitors: OmpLocalMonitor[] = [];
async function fixture(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "omp-source-settings-")));
  directories.push(directory);
  return directory;
}
async function completeSourceSnapshot(monitor: OmpLocalMonitor) {
  for (let attempt = 0; attempt < 2048; attempt++) {
    const snapshot = await monitor.poll();
    if (!snapshot.coverage.issues.includes("scan_pending") && !snapshot.performance.scanning)
      return snapshot;
  }
  throw new Error("Owned source fixture did not finish its finite read budgets");
}
afterEach(async () => {
  storage.beforeCopy = undefined;
  storage.beforeRename = undefined;
  for (const monitor of monitors.splice(0)) monitor.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("OMP source configuration boundaries", () => {
  it("names the actual environment-selected default while automatic discovery keeps only OMP profiles", async () => {
    const home = await fixture(),
      override = path.join(home, "owned-agent");
    await mkdir(path.join(home, ".owned-omp", "profiles", "work", "agent", "sessions"), {
      recursive: true,
    });
    const options = {
      home,
      platform: "win32" as const,
      env: { PI_CONFIG_DIR: ".owned-omp", PI_CODING_AGENT_DIR: override },
    };
    expect(await defaultOmpMonitorFolder(options)).toBe(path.join(override, "sessions"));
    expect((await resolveOmpMonitorRoots(options)).roots).toEqual([
      { path: path.join(override, "sessions"), label: "default" },
      {
        path: path.join(home, ".owned-omp", "profiles", "work", "agent", "sessions"),
        label: "work",
      },
    ]);
  });

  it("accepts only absolute local folder paths and resolves a native selection without following links", async () => {
    const root = await fixture(),
      folder = path.join(root, "sessions");
    await mkdir(folder);
    expect(canonicalOmpSourcePath(path.join(folder, "."))).toBe(folder);
    expect(await selectedOmpSourceFolder(folder)).toBe(await realpath(folder));
    for (const input of [
      "",
      ".",
      "../sessions",
      "C:relative",
      "https://example.com/sessions",
      `${folder}\u0000`,
      1,
      null,
    ])
      expect(() => canonicalOmpSourcePath(input)).toThrow();
    if (process.platform === "win32") {
      for (const remote of [
        "\\\\server\\share\\sessions",
        "\\\\?\\C:\\sessions",
        "\\\\.\\C:\\sessions",
      ])
        expect(() => canonicalOmpSourcePath(remote)).toThrow();
    }
    await writeFile(path.join(root, "not-a-folder"), "not an OMP source");
    await expect(selectedOmpSourceFolder(path.join(root, "not-a-folder"))).rejects.toThrow();
    await expect(selectedOmpSourceFolder(path.join(root, "missing"))).rejects.toThrow();
    const linked = path.join(root, "linked");
    await symlink(folder, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(selectedOmpSourceFolder(linked)).rejects.toThrow();
    await mkdir(path.join(folder, "nested"));
    await expect(selectedOmpSourceFolder(path.join(linked, "nested"))).rejects.toThrow();
  });

  it("atomically persists enabled/custom-folder state under a new owned local-monitor directory", async () => {
    const root = await fixture(),
      file = path.join(root, "local-monitor", "sources.json");
    const folder = path.join(root, "chosen", "sessions");
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: true,
      folder: null,
      invalid: false,
    });
    await writeMonitorSourcePreferences(file, { enabled: false, folder }, false);
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: false,
      folder,
      invalid: false,
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      enabled: false,
      folder,
    });
    await writeMonitorSourcePreferences(file, { enabled: true, folder: null }, false);
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: true,
      folder: null,
      invalid: false,
    });
    expect(await readdir(path.dirname(file))).toEqual(["sources.json"]);
  });

  it("fails closed for corrupt, excessive or arbitrary saved source settings and preserves corrupt evidence", async () => {
    const root = await fixture(),
      file = path.join(root, "sources.json");
    for (const invalid of [
      "not-json",
      "x".repeat(8193),
      JSON.stringify({ version: 1, enabled: "true", folder: null }),
      JSON.stringify({ version: 1, enabled: true, folder: "../outside" }),
      JSON.stringify({ version: 1, enabled: true, folder: null, roots: ["arbitrary"] }),
    ]) {
      await writeFile(file, invalid);
      expect(await readMonitorSourcePreferences(file)).toEqual({
        enabled: false,
        folder: null,
        invalid: true,
      });
    }
    await writeFile(file, "corrupt-original-source-settings");
    await writeMonitorSourcePreferences(file, { enabled: true, folder: null }, true);
    const preserved = (await readdir(root)).find((name) =>
      name.startsWith("sources.json.invalid-"),
    )!;
    expect(await readFile(path.join(root, preserved), "utf8")).toBe(
      "corrupt-original-source-settings",
    );
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: true,
      folder: null,
      invalid: false,
    });
  });

  it("keeps corrupt sources fail-closed during an interrupted replacement and after installation fails", async () => {
    const root = await fixture(),
      file = path.join(root, "sources.json");
    const folder = path.join(root, "chosen", "sessions");
    await writeFile(file, "corrupt-source-permission");
    const staged = Promise.withResolvers<void>(),
      install = Promise.withResolvers<void>();
    storage.beforeRename = async (_source, target) => {
      if (target !== file) return;
      staged.resolve();
      await install.promise;
    };
    const saving = writeMonitorSourcePreferences(file, { enabled: false, folder }, true);
    const failed = expect(saving).rejects.toThrow("owned replacement failure");
    await staged.promise;
    try {
      // A new consumer at the crash boundary must still see invalid/disabled, not first use.
      expect(await readMonitorSourcePreferences(file)).toEqual({
        enabled: false,
        folder: null,
        invalid: true,
      });
      const evidence = (await readdir(root)).find((name) =>
        name.startsWith("sources.json.invalid-"),
      )!;
      expect(await readFile(path.join(root, evidence), "utf8")).toBe("corrupt-source-permission");
    } finally {
      install.reject(new Error("owned replacement failure"));
      await failed;
      storage.beforeRename = undefined;
    }
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: false,
      folder: null,
      invalid: true,
    });
    expect(await readFile(file, "utf8")).toBe("corrupt-source-permission");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await writeMonitorSourcePreferences(file, { enabled: false, folder }, true);
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: false,
      folder,
      invalid: false,
    });
  });

  it("leaves the original source denial authoritative when evidence preservation fails and can retry", async () => {
    const root = await fixture(),
      file = path.join(root, "sources.json");
    await writeFile(file, "corrupt-source-permission");
    storage.beforeCopy = async (source) => {
      if (source === file) throw new Error("owned evidence failure");
    };
    await expect(
      writeMonitorSourcePreferences(file, { enabled: false, folder: null }, true),
    ).rejects.toThrow("owned evidence failure");
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: false,
      folder: null,
      invalid: true,
    });
    expect(await readFile(file, "utf8")).toBe("corrupt-source-permission");
    expect(await readdir(root)).toEqual(["sources.json"]);
    storage.beforeCopy = undefined;
    await writeMonitorSourcePreferences(file, { enabled: false, folder: null }, true);
    expect(await readMonitorSourcePreferences(file)).toEqual({
      enabled: false,
      folder: null,
      invalid: false,
    });
    const evidence = (await readdir(root)).find((name) =>
      name.startsWith("sources.json.invalid-"),
    )!;
    expect(await readFile(path.join(root, evidence), "utf8")).toBe("corrupt-source-permission");
  });

  it("refuses linked storage ancestors and non-regular targets without writing through them", async () => {
    const root = await fixture(),
      target = path.join(root, "target"),
      linked = path.join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const throughLink = path.join(linked, "local-monitor", "sources.json");
    expect(await readMonitorSourcePreferences(throughLink)).toEqual({
      enabled: false,
      folder: null,
      invalid: true,
    });
    await expect(
      writeMonitorSourcePreferences(throughLink, { enabled: true, folder: null }, false),
    ).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
    const directoryTarget = path.join(root, "sources.json");
    await mkdir(directoryTarget);
    await expect(
      writeMonitorSourcePreferences(directoryTarget, { enabled: false, folder: null }, true),
    ).rejects.toThrow();
    expect(await readdir(directoryTarget)).toEqual([]);
  });

  it("projects only the chosen OMP source and excludes disabled usage/history even with a previous numeric cache", async () => {
    const root = await fixture(),
      chosen = path.join(root, "chosen"),
      other = path.join(root, "other");
    const now = new Date(2026, 9, 31, 12).getTime();
    for (const [folder, output] of [
      [chosen, 40],
      [other, 999],
    ] as const) {
      await mkdir(path.join(folder, "bucket"), { recursive: true });
      await writeFile(
        path.join(folder, "bucket", "session.jsonl"),
        [
          {
            type: "session",
            version: 3,
            id: `owned-${output}`,
            timestamp: new Date(now - 60_000).toISOString(),
            cwd: "C:/owned-project",
          },
          {
            type: "message",
            id: `response-${output}`,
            parentId: null,
            timestamp: new Date(now - 1000).toISOString(),
            message: {
              role: "assistant",
              model: "model-a",
              provider: "openai",
              api: "openai-responses",
              timestamp: now - 2000,
              duration: 1000,
              stopReason: "stop",
              usage: {
                input: 10,
                output,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: output + 10,
                cost: { total: 1 },
              },
              content: [{ type: "text", text: "PRIVATE SOURCE CONTENT MUST NOT ENTER THE VIEW" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
    }
    await writeFile(
      path.join(chosen, "bucket", "another-tool.jsonl"),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 99999, output_tokens: 99999 },
      }) + "\n",
    );
    const cache = path.join(root, "local-monitor");
    const selected = new OmpLocalMonitor({
      roots: [{ path: chosen, label: "default" }],
      now: () => now,
      performanceCacheDir: cache,
    });
    monitors.push(selected);
    const current = await completeSourceSnapshot(selected);
    expect(current.today).toMatchObject({ requests: 1, outputTokens: 40 });
    expect(current.days.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
    expect(current.performance.records.reduce((sum, row) => sum + row.n, 0)).toBe(1);
    expect(JSON.stringify(current)).not.toContain("PRIVATE SOURCE CONTENT");
    expect(JSON.stringify(current)).not.toContain(chosen);
    selected.dispose();

    const disabled = new OmpLocalMonitor({ roots: [], now: () => now, performanceCacheDir: cache });
    monitors.push(disabled);
    const off = await disabled.poll();
    expect(off.today.requests).toBe(0);
    expect(off.days.every((day) => day.requests === 0)).toBe(true);
    expect(off.agents).toEqual([]);
    expect(off.performance.records).toEqual([]);
    expect(off.coverage.roots).toEqual([]);
    disabled.dispose();

    const reconfigured = new OmpLocalMonitor({
      roots: [{ path: other, label: "default" }],
      now: () => now,
      performanceCacheDir: cache,
    });
    monitors.push(reconfigured);
    const moved = await completeSourceSnapshot(reconfigured);
    expect(moved.today).toMatchObject({ requests: 1, outputTokens: 999 });
    expect(moved.days.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
    expect(moved.performance.records.reduce((sum, row) => sum + row.n, 0)).toBe(1);
  });
});
