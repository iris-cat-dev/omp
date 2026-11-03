import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { shell, ipcMain } from "electron";

import { listBrowserTargets, openBrowserTarget } from "./browser-targets.js";
import { createExternalAppRuntime, type ExternalAppRuntime } from "./external-app-runtime.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import type { DesktopSettingsStore } from "../settings/desktop-settings.js";
import { openSystemBrowser } from "./system-browser.js";

const ALLOWED_EXTERNAL_URL_PROTOCOLS: Record<string, true> = { "http:": true, "https:": true };
// Electron may launch these targets rather than showing their contents.
const EXECUTABLE_EXTENSIONS: Record<string, true> = {
  ".app": true,
  ".bat": true,
  ".cmd": true,
  ".com": true,
  ".command": true,
  ".desktop": true,
  ".exe": true,
  ".hta": true,
  ".jar": true,
  ".js": true,
  ".jse": true,
  ".lnk": true,
  ".msi": true,
  ".msp": true,
  ".msix": true,
  ".pkg": true,
  ".ps1": true,
  ".py": true,
  ".pyw": true,
  ".reg": true,
  ".run": true,
  ".scpt": true,
  ".scr": true,
  ".sh": true,
  ".url": true,
  ".vbe": true,
  ".vbs": true,
  ".wsf": true,
};

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return ALLOWED_EXTERNAL_URL_PROTOCOLS[url.protocol] === true;
  } catch {
    return false;
  }
}

function isAbsoluteLocalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0")) {
    return false;
  }

  if (process.platform === "win32") {
    // Win32 considers drive-relative and UNC/device paths differently from ordinary local files.
    return /^[a-zA-Z]:[\\/]/.test(value) && path.win32.isAbsolute(value);
  }

  // A POSIX absolute path starts with "/" (which win32 also treats as absolute).
  // Reject UNC-style roots and Windows drive syntax without rejecting normal POSIX roots.
  return (
    path.posix.isAbsolute(value) && !value.startsWith("//") && !/^\/[a-zA-Z]:[\\/]/.test(value)
  );
}

async function resolveWorkspacePath(
  input: unknown,
  action: "open" | "reveal" = "open",
): Promise<{ target: string; revealOnly: boolean }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid workspace path");
  }

  const { path: targetPath, workspaceRoot } = input as Record<string, unknown>;
  if (!isAbsoluteLocalPath(targetPath) || !isAbsoluteLocalPath(workspaceRoot)) {
    throw new Error("Invalid workspace path");
  }

  // realpath requires both paths to exist and resolves symlinks before containment is checked.
  const [root, target] = await Promise.all([realpath(workspaceRoot), realpath(targetPath)]);
  if (!isAbsoluteLocalPath(root) || !isAbsoluteLocalPath(target)) {
    throw new Error("Invalid workspace path");
  }
  // Explicit reveal never reads or launches the target, including outside the workspace.
  if (action === "reveal") return { target, revealOnly: true };
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace");
  }

  const requestedExtension = path.extname(targetPath).toLowerCase();
  const resolvedExtension = path.extname(target).toLowerCase();
  let revealOnly =
    EXECUTABLE_EXTENSIONS[requestedExtension] === true ||
    EXECUTABLE_EXTENSIONS[resolvedExtension] === true;
  // On Unix an extensionless executable/script can also be launched by the file manager.
  if (!revealOnly && process.platform !== "win32") {
    const targetStat = await stat(target);
    revealOnly = targetStat.isFile() && (targetStat.mode & 0o111) !== 0;
  }
  return { target, revealOnly };
}

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface BrowserOpenerOptions {
  ipc?: IpcHandlerRegistry;
  runtime?: ExternalAppRuntime;
  settingsStore?: Pick<DesktopSettingsStore, "get">;
  openSystemUrl?: (url: string) => Promise<void>;
}

const defaultBrowserRuntime = createExternalAppRuntime();
const defaultSystemUrlOpener = (url: string) => shell.openExternal(url);

export async function openExternalUrl(
  url: unknown,
  options: Omit<BrowserOpenerOptions, "ipc"> = {},
): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    throw new Error("Unsupported external URL");
  }
  const settingsStore = options.settingsStore ?? getDesktopSettingsStore();
  const settings = await settingsStore.get();
  await openBrowserTarget(
    settings.browser.target,
    url,
    options.runtime ?? defaultBrowserRuntime,
    options.openSystemUrl ?? defaultSystemUrlOpener,
    settings.browser.custom,
  );
}

export function registerOpenerHandlers(options: BrowserOpenerOptions = {}): void {
  const ipc = options.ipc ?? ipcMain;
  const runtime = options.runtime ?? defaultBrowserRuntime;
  ipc.handle("paseo:opener:listBrowsers", () => listBrowserTargets(runtime));
  ipc.handle("paseo:opener:openUrl", async (_event, url: unknown) => {
    await openExternalUrl(url, {
      runtime,
      settingsStore: options.settingsStore,
      openSystemUrl: options.openSystemUrl,
    });
  });

  ipc.handle("paseo:opener:openPath", async (_event, input: unknown) => {
    const { target, revealOnly } = await resolveWorkspacePath(input);
    if (revealOnly) {
      shell.showItemInFolder(target);
      return;
    }
    if (/\.html?$/i.test(target) && (await stat(target)).isFile()) {
      const settings = await (options.settingsStore ?? getDesktopSettingsStore()).get();
      await openBrowserTarget(
        settings.browser.target,
        pathToFileURL(target).href,
        runtime,
        options.openSystemUrl ?? ((url) => openSystemBrowser(url, runtime)),
        settings.browser.custom,
      );
      return;
    }
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
  });

  ipc.handle("paseo:opener:revealPath", async (_event, input: unknown) => {
    const { target } = await resolveWorkspacePath(input, "reveal");
    shell.showItemInFolder(target);
  });
}
