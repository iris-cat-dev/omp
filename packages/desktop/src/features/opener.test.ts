import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ipcMain, shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAllowedExternalUrl, registerOpenerHandlers } from "./opener";
import { createDesktopSettingsStore, DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createExternalAppRuntime,
  type ExternalAppRuntime,
  type ExternalSpawnedProcess,
} from "./external-app-runtime";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

function getRegisteredOpenUrlHandler(
  options: Parameters<typeof registerOpenerHandlers>[0] = {},
): (_event: unknown, url: unknown) => Promise<void> {
  registerOpenerHandlers({
    settingsStore: { get: async () => DEFAULT_DESKTOP_SETTINGS },
    ...options,
  });
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
    return channel === "paseo:opener:openUrl";
  })?.[1];
  if (typeof handler !== "function") {
    throw new Error("open URL handler was not registered");
  }
  return handler as (_event: unknown, url: unknown) => Promise<void>;
}

function getRegisteredPathHandler(
  action: "openPath" | "revealPath" = "openPath",
  options: Parameters<typeof registerOpenerHandlers>[0] = {},
): (_event: unknown, input: unknown) => Promise<void> {
  registerOpenerHandlers({
    settingsStore: { get: async () => DEFAULT_DESKTOP_SETTINGS },
    ...options,
  });
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
    return channel === `paseo:opener:${action}`;
  })?.[1];
  if (typeof handler !== "function") {
    throw new Error(`${action} handler was not registered`);
  }
  return handler as (_event: unknown, input: unknown) => Promise<void>;
}

function createSpawnedProcess(): EventEmitter & ExternalSpawnedProcess {
  const child = new EventEmitter() as EventEmitter & ExternalSpawnedProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

describe("desktop opener", () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
    vi.mocked(shell.openExternal).mockReset();
    vi.mocked(shell.openPath).mockReset();
    vi.mocked(shell.openPath).mockResolvedValue("");
    vi.mocked(shell.showItemInFolder).mockReset();
  });

  it("allows only http and https external URLs", () => {
    expect(isAllowedExternalUrl("https://example.com/path")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:8081")).toBe(true);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("paseo://settings")).toBe(false);
    expect(isAllowedExternalUrl("/relative/path")).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl("sandbox:/workspace/file.ts")).toBe(false);
  });

  it("opens allowed URLs through Electron shell", async () => {
    const handler = getRegisteredOpenUrlHandler();

    await handler({}, "https://example.com");

    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("uses the browser selected in desktop settings", async () => {
    const spawnDetached = vi.fn(async () => {});
    const runtime: ExternalAppRuntime = {
      platform: "linux",
      env: {},
      pathExists: () => false,
      resolveCommand: (commands) => (commands.includes("firefox") ? "/usr/bin/firefox" : null),
      spawnDetached,
      hasMacApplication: () => false,
      openMacApplication: vi.fn(async () => {}),
    };
    const handler = getRegisteredOpenUrlHandler({
      runtime,
      settingsStore: {
        get: async () => ({
          ...DEFAULT_DESKTOP_SETTINGS,
          browser: { ...DEFAULT_DESKTOP_SETTINGS.browser, target: "firefox" },
        }),
      },
    });

    await handler({}, "https://example.com/a%20b");

    expect(spawnDetached).toHaveBeenCalledWith({
      command: "/usr/bin/firefox",
      args: ["https://example.com/a%20b"],
    });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("uses reloaded custom settings at the existing opener with exact argv and no shell", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "desktop-custom-browser-"));
    try {
      const executable = path.join(userDataPath, 'Browser "one" & 中文', "browser.exe");
      const args = ["", "--profile", 'a profile "quoted" & 中文', "{url}", ""];
      await createDesktopSettingsStore({ userDataPath }).patch({
        browser: { target: "custom", custom: { executable, args } },
      });
      const spawn = vi.fn(createSpawnedProcess);
      const settingsStore = createDesktopSettingsStore({ userDataPath });
      const handler = getRegisteredOpenUrlHandler({
        settingsStore,
        runtime: createExternalAppRuntime({ platform: process.platform, env: {}, spawn }),
      });
      const url = 'https://example.com/a b?q="quoted"&other=中文#é';

      await handler({}, url);
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        executable,
        ["", "--profile", 'a profile "quoted" & 中文', url, ""],
        expect.objectContaining({ shell: false, detached: true }),
      );
      expect(shell.openExternal).not.toHaveBeenCalled();
      await settingsStore.patch({ browser: { target: "system" } });
      await handler({}, url);
      expect(shell.openExternal).toHaveBeenCalledWith(url);
      await settingsStore.patch({ browser: { target: "custom" } });
      await handler({}, url);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(shell.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects non-HTTP URLs before reading or launching custom settings", async () => {
    const spawn = vi.fn();
    const get = vi.fn(async () => ({
      ...DEFAULT_DESKTOP_SETTINGS,
      browser: {
        target: "custom" as const,
        custom: { executable: process.execPath, args: ["{url}"] },
      },
    }));
    const handler = getRegisteredOpenUrlHandler({
      settingsStore: { get },
      runtime: createExternalAppRuntime({ spawn }),
    });

    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "paseo://settings",
      "/relative",
      null,
    ]) {
      await expect(handler({}, url)).rejects.toThrow("Unsupported external URL");
    }
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("revalidates an invalid saved custom launch instead of falling back to the system", async () => {
    const spawn = vi.fn();
    const handler = getRegisteredOpenUrlHandler({
      runtime: createExternalAppRuntime({ spawn }),
      settingsStore: {
        get: async () => ({
          ...DEFAULT_DESKTOP_SETTINGS,
          browser: {
            target: "custom",
            custom: { executable: process.execPath, args: ["--url={url}"] },
          },
        }),
      },
    });

    await expect(handler({}, "https://example.com")).rejects.toThrow("embedded {url}");
    expect(spawn).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("rejects blocked URLs before invoking Electron shell", async () => {
    const handler = getRegisteredOpenUrlHandler();

    await expect(handler({}, "file:///etc/passwd")).rejects.toThrow("Unsupported external URL");
    await expect(handler({}, "sandbox:/workspace/file.ts")).rejects.toThrow(
      "Unsupported external URL",
    );

    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("workspace path opener", () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let filePath: string;
  let directoryPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    vi.mocked(ipcMain.handle).mockReset();
    vi.mocked(shell.openPath).mockReset();
    vi.mocked(shell.openPath).mockResolvedValue("");
    vi.mocked(shell.showItemInFolder).mockReset();
    vi.mocked(shell.openExternal).mockReset();

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "desktop-opener-"));
    workspaceRoot = path.join(temporaryDirectory, "workspace");
    directoryPath = path.join(workspaceRoot, "directory");
    filePath = path.join(directoryPath, "inside.txt");
    outsidePath = path.join(temporaryDirectory, "outside.txt");
    await mkdir(directoryPath, { recursive: true });
    await writeFile(filePath, "inside");
    await writeFile(outsidePath, "outside");
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("opens existing files and directories inside the resolved workspace", async () => {
    const handler = getRegisteredPathHandler();

    await handler({}, { path: filePath, workspaceRoot });
    await handler({}, { path: directoryPath, workspaceRoot });
    await handler({}, { path: workspaceRoot, workspaceRoot });

    expect(shell.openPath).toHaveBeenNthCalledWith(1, await realpath(filePath));
    expect(shell.openPath).toHaveBeenNthCalledWith(2, await realpath(directoryPath));
    expect(shell.openPath).toHaveBeenNthCalledWith(3, await realpath(workspaceRoot));
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("reveals regular files, directories, and executables without opening them", async () => {
    const handler = getRegisteredPathHandler("revealPath");
    const executablePath = path.join(workspaceRoot, "untrusted.exe");
    await writeFile(executablePath, "untrusted");

    await handler({}, { path: filePath, workspaceRoot });
    await handler({}, { path: directoryPath, workspaceRoot });
    await handler({}, { path: workspaceRoot, workspaceRoot });
    await handler({}, { path: executablePath, workspaceRoot });

    expect(shell.showItemInFolder).toHaveBeenNthCalledWith(1, await realpath(filePath));
    expect(shell.showItemInFolder).toHaveBeenNthCalledWith(2, await realpath(directoryPath));
    expect(shell.showItemInFolder).toHaveBeenNthCalledWith(3, await realpath(workspaceRoot));
    expect(shell.showItemInFolder).toHaveBeenNthCalledWith(4, await realpath(executablePath));
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("openPath rejects outside paths, traversal, and sibling prefixes", async () => {
    const handler = getRegisteredPathHandler();
    const sibling = path.join(temporaryDirectory, "workspace-neighbor");
    await mkdir(sibling);

    for (const target of [outsidePath, path.join(workspaceRoot, "..", "outside.txt"), sibling]) {
      await expect(handler({}, { path: target, workspaceRoot })).rejects.toThrow(
        "Path is outside workspace",
      );
    }
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("revealPath permits existing Downloads files without opening or executing them", async () => {
    const handler = getRegisteredPathHandler("revealPath");
    const downloads = path.join(temporaryDirectory, "Downloads");
    await mkdir(downloads);
    for (const name of ["report.zip", "中文 维护者说明.md", "untrusted.exe"]) {
      const target = path.join(downloads, name);
      await writeFile(target, "outside workspace");
      await handler({}, { path: target, workspaceRoot });
      expect(shell.showItemInFolder).toHaveBeenLastCalledWith(await realpath(target));
    }
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("openPath rejects symlink escapes but opens contained targets", async () => {
    const handler = getRegisteredPathHandler();
    const escapeLink = path.join(workspaceRoot, "escape");
    const insideLink = path.join(workspaceRoot, "inside-link");
    await symlink(
      temporaryDirectory,
      escapeLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(directoryPath, insideLink, process.platform === "win32" ? "junction" : "dir");

    await expect(handler({}, { path: escapeLink, workspaceRoot })).rejects.toThrow(
      "Path is outside workspace",
    );
    await handler({}, { path: insideLink, workspaceRoot });
    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(await realpath(directoryPath));
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("revealPath resolves an outside symlink without launching its target", async () => {
    const handler = getRegisteredPathHandler("revealPath");
    const escapeLink = path.join(workspaceRoot, "escape");
    await symlink(
      temporaryDirectory,
      escapeLink,
      process.platform === "win32" ? "junction" : "dir",
    );

    await handler({}, { path: escapeLink, workspaceRoot });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(await realpath(temporaryDirectory));
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it.each(["openPath", "revealPath"] as const)(
    "%s rejects absent paths and workspace roots",
    async (action) => {
      const handler = getRegisteredPathHandler(action);

      await expect(
        handler({}, { path: path.join(workspaceRoot, "missing"), workspaceRoot }),
      ).rejects.toThrow();
      await expect(
        handler({}, { path: filePath, workspaceRoot: path.join(temporaryDirectory, "missing") }),
      ).rejects.toThrow();
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it.each(["openPath", "revealPath"] as const)(
    "%s rejects malformed inputs, URL schemes, and foreign-platform paths",
    async (action) => {
      const handler = getRegisteredPathHandler(action);
      const malformed = [
        null,
        {},
        [],
        { path: filePath },
        { path: filePath, workspaceRoot: null },
        { path: 42, workspaceRoot },
        { path: "relative/path", workspaceRoot },
        { path: "sandbox:/file.txt", workspaceRoot },
        { path: "file:///etc/passwd", workspaceRoot },
        { path: "https://example.com", workspaceRoot },
        { path: `${filePath}\0`, workspaceRoot },
        { path: filePath, workspaceRoot: "sandbox:/workspace" },
        { path: filePath, workspaceRoot: "relative/workspace" },
        {
          path: process.platform === "win32" ? "/etc/passwd" : "C:\\Windows\\win.ini",
          workspaceRoot,
        },
        { path: "\\\\server\\share\\file", workspaceRoot },
      ];

      for (const input of malformed) {
        await expect(handler({}, input)).rejects.toThrow("Invalid workspace path");
      }
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it("reveals executable files and app bundles instead of launching them", async () => {
    const handler = getRegisteredPathHandler();
    const executablePaths = [".exe", ".msi", ".bat", ".cmd", ".ps1"].map((extension) =>
      path.join(workspaceRoot, `untrusted${extension}`),
    );
    const appBundle = path.join(workspaceRoot, "Untrusted.app");
    for (const executablePath of executablePaths) {
      await writeFile(executablePath, "untrusted");
      await handler({}, { path: executablePath, workspaceRoot });
    }
    await mkdir(appBundle);
    await handler({}, { path: appBundle, workspaceRoot });

    expect(shell.showItemInFolder).toHaveBeenCalledTimes(executablePaths.length + 1);
    for (const [index, executablePath] of executablePaths.entries()) {
      expect(shell.showItemInFolder).toHaveBeenNthCalledWith(
        index + 1,
        await realpath(executablePath),
      );
    }
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(await realpath(appBundle));
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  if (process.platform !== "win32") {
    it("reveals extensionless Unix executable files instead of launching them", async () => {
      const handler = getRegisteredPathHandler();
      const executablePath = path.join(workspaceRoot, "untrusted-program");
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
      await chmod(executablePath, 0o755);

      await handler({}, { path: executablePath, workspaceRoot });

      expect(shell.showItemInFolder).toHaveBeenCalledWith(await realpath(executablePath));
      expect(shell.openPath).not.toHaveBeenCalled();
    });
  }

  it.each(["中文 demo.html", "demo.htm", "demo.HTML"])(
    "opens %s as an encoded file URL using the configured browser",
    async (name) => {
      const target = path.join(workspaceRoot, name);
      await writeFile(target, "<!doctype html><h1>local page</h1>");
      const spawn = vi.fn(createSpawnedProcess);
      const executable = path.join(temporaryDirectory, "Browser.exe");
      const handler = getRegisteredPathHandler("openPath", {
        runtime: createExternalAppRuntime({ spawn }),
        settingsStore: {
          get: async () => ({
            ...DEFAULT_DESKTOP_SETTINGS,
            browser: {
              target: "custom",
              custom: { executable, args: ["--profile", "中文 profile", "{url}"] },
            },
          }),
        },
      });

      await handler({}, { path: target, workspaceRoot });
      expect(spawn).toHaveBeenCalledWith(
        executable,
        ["--profile", "中文 profile", pathToFileURL(await realpath(target)).href],
        expect.objectContaining({ shell: false }),
      );
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
    },
  );

  it("does not open disguised executables or outside HTML through a browser", async () => {
    const browser = vi.fn(async () => {});
    const handler = getRegisteredPathHandler("openPath", { openSystemUrl: browser });
    const executable = path.join(workspaceRoot, "program.exe");
    const link = path.join(workspaceRoot, "disguised.html");
    const outsideHtml = path.join(temporaryDirectory, "outside.html");
    await writeFile(executable, "untrusted");
    await writeFile(outsideHtml, "<h1>outside</h1>");
    await symlink(executable, link);

    await handler({}, { path: link, workspaceRoot });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(await realpath(executable));
    await expect(handler({}, { path: outsideHtml, workspaceRoot })).rejects.toThrow(
      "Path is outside workspace",
    );
    expect(browser).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("propagates shell.openPath failures", async () => {
    const handler = getRegisteredPathHandler();
    vi.mocked(shell.openPath).mockResolvedValue("Cannot open path");

    await expect(handler({}, { path: filePath, workspaceRoot })).rejects.toThrow(
      "Cannot open path",
    );
  });
});
