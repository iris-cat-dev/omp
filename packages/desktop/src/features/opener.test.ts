import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ipcMain, shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAllowedExternalUrl, registerOpenerHandlers } from "./opener";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

function getRegisteredOpenUrlHandler(): (_event: unknown, url: unknown) => Promise<void> {
  registerOpenerHandlers();
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
): (_event: unknown, input: unknown) => Promise<void> {
  registerOpenerHandlers();
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => {
    return channel === `paseo:opener:${action}`;
  })?.[1];
  if (typeof handler !== "function") {
    throw new Error(`${action} handler was not registered`);
  }
  return handler as (_event: unknown, input: unknown) => Promise<void>;
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

  it.each(["openPath", "revealPath"] as const)(
    "%s rejects paths outside the workspace, including traversal and sibling prefixes",
    async (action) => {
      const handler = getRegisteredPathHandler(action);
      const sibling = path.join(temporaryDirectory, "workspace-neighbor");
      await mkdir(sibling);

      await expect(handler({}, { path: outsidePath, workspaceRoot })).rejects.toThrow(
        "Path is outside workspace",
      );
      await expect(
        handler({}, { path: path.join(workspaceRoot, "..", "outside.txt"), workspaceRoot }),
      ).rejects.toThrow("Path is outside workspace");
      await expect(handler({}, { path: sibling, workspaceRoot })).rejects.toThrow(
        "Path is outside workspace",
      );
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it.each(["openPath", "revealPath"] as const)(
    "%s rejects symlink escapes but handles in-workspace symlinks at their resolved target",
    async (action) => {
      const handler = getRegisteredPathHandler(action);
      const outsideDirectory = path.join(temporaryDirectory, "outside-directory");
      const escapeLink = path.join(workspaceRoot, "escape");
      const insideLink = path.join(workspaceRoot, "inside-link");
      await mkdir(outsideDirectory);
      await symlink(
        outsideDirectory,
        escapeLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink(directoryPath, insideLink, process.platform === "win32" ? "junction" : "dir");

      await expect(handler({}, { path: escapeLink, workspaceRoot })).rejects.toThrow(
        "Path is outside workspace",
      );
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      await handler({}, { path: insideLink, workspaceRoot });
      const selectedOperation = action === "openPath" ? shell.openPath : shell.showItemInFolder;
      const otherOperation = action === "openPath" ? shell.showItemInFolder : shell.openPath;
      expect(selectedOperation).toHaveBeenCalledTimes(1);
      expect(selectedOperation).toHaveBeenCalledWith(await realpath(directoryPath));
      expect(otherOperation).not.toHaveBeenCalled();
    },
  );

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

  it("propagates shell.openPath failures", async () => {
    const handler = getRegisteredPathHandler();
    vi.mocked(shell.openPath).mockResolvedValue("Cannot open path");

    await expect(handler({}, { path: filePath, workspaceRoot })).rejects.toThrow(
      "Cannot open path",
    );
  });
});
