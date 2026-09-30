import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { shell, ipcMain } from "electron";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);
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
    return ALLOWED_EXTERNAL_URL_PROTOCOLS.has(url.protocol);
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

export function registerOpenerHandlers(): void {
  ipcMain.handle("paseo:opener:openUrl", async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error("Unsupported external URL");
    }
    await shell.openExternal(url);
  });

  ipcMain.handle("paseo:opener:openPath", async (_event, input: unknown) => {
    const { target, revealOnly } = await resolveWorkspacePath(input);
    if (revealOnly) {
      shell.showItemInFolder(target);
      return;
    }
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
  });

  ipcMain.handle("paseo:opener:revealPath", async (_event, input: unknown) => {
    const { target } = await resolveWorkspacePath(input);
    shell.showItemInFolder(target);
  });
}
