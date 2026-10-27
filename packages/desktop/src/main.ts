process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";
import type * as AppUpdater from "./features/auto-updater.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  Tray,
  type NativeImage,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  setupDragDropPrevention,
} from "./window/window-manager.js";
import { wallpaperMediaRegistry } from "./wallpaper/media-registry.js";
import { registerWallpaperWindow } from "./wallpaper/commands.js";
import { createWallpaperMediaResponse } from "./wallpaper/media-response.js";
import { BackgroundModeController } from "./window/background-mode.js";
import { CloseChoiceRequestBroker } from "./window/close-choice-request.js";
import {
  getRendererRecoveryRoute,
  RendererLossRecoveryController,
  showRendererLossPrompt,
  showRendererRecoveryFailure,
} from "./window/renderer-loss-recovery.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { resolveAppIconPath } from "./features/stamped-icon.js";
import { registerRemoteSshHandlers } from "./features/remote-ssh/ipc.js";
import { registerScreenshotHandler } from "./features/screenshot.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  getDesktopContextMenuLabels,
  onDesktopContextMenuLabelsChange,
} from "./features/context-menu-labels.js";
import { clearRetiredBrowserProfiles } from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { PendingOpenProjectStore } from "./pending-open-project-store.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@omp-desktop/protocol/agent-deep-link";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";
import {
  getMainWindows,
  getOrCreateMainWindow,
  isMainWindowSender,
  registerMainWindow,
  selectMainWindow,
  getMainWindowDocumentVersion,
  markMainWindowDocumentLoaded,
  markMainWindowContentReady,
  showMainWindow,
  beginMainWindowShutdown,
  markMainWindowLoading,
} from "./window/main-windows.js";
import { DesktopPetController } from "./pets/controller.js";
import { PET_HTML } from "./pets/html.js";
import { getPetLibrary } from "./pets/library.js";
import { tryRunPetCreationCli } from "./pets/creation-cli.js";
import { OmpMonitorController } from "./monitor/controller.js";
import { MONITOR_HTML } from "./monitor/html.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "omp-desktop";
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "OMP Desktop";
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const isPetCreationCli = process.argv.includes("--desktop-pet-install");
const agentNavigationInbox = new AgentNavigationInbox();
const closeChoiceRequests = new CloseChoiceRequestBroker();
let petController: DesktopPetController | null = null;
let monitorController: OmpMonitorController | null = null;
let ownsDesktopInstance = false;
let mainWindowsQuitting = false;
const presentedMainWindows = new WeakSet<BrowserWindow>();
const restoreWindowStateByWindow = new WeakMap<BrowserWindow, boolean>();

function failInitialWindowPresentation(window: BrowserWindow, error: unknown): void {
  if (mainWindowsQuitting || window.isDestroyed() || window.isVisible()) return;
  const details = error instanceof Error ? error.message : String(error);
  log.error("[window] Initial presentation failed", error);
  window.destroy();
  dialog.showErrorBox("OMP Desktop could not open", details);
}

// A second-instance launch can arrive before the packaged protocol handler,
// IPC handlers, and first window exist. Wait for full bootstrap, not just
// app.whenReady(), before delivering navigation to the renderer.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});
let bootstrapIsComplete = false;

app.setName(APP_NAME);

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
if (forcedUserDataDir) {
  app.setPath("userData", forcedUserDataDir);
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "OMP Desktop mini-electron"));
} else {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "paseo") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (isWorktree) {
      app.setPath("userData", path.join(app.getPath("appData"), `OMP-Desktop-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// AppImage runtimes mount the app from /tmp under the user's UID, so the SUID
// chrome-sandbox helper we ship in .deb/.rpm cannot work there. Disable the
// sandbox only in that case; .deb/.rpm keep the sandbox on, matching VS Code.
if (process.platform === "linux" && process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Allow users to pass Chromium flags via PASEO_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});
let pendingAgentNavigation = parseAgentDeepLinkFromArgv(process.argv);

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
const pendingOpenProjectStore = new PendingOpenProjectStore();

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = pendingOpenProjectStore.take(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("paseo:agent-navigation:ready", (event) => {
  return agentNavigationInbox.windowReady(event.sender.id);
});
ipcMain.handle("paseo:window:content-ready", async (event) => {
  if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Content readiness requires a main application window");
  }
  const window = getMainWindows().find((candidate) => candidate.webContents === event.sender);
  if (!window) return;
  const documentVersion = getMainWindowDocumentVersion(window);
  try {
    if (process.platform === "darwin") {
      const contents = event.sender as Electron.WebContents & { prepareToShow(): Promise<void> };
      await contents.prepareToShow();
    }
    if (mainWindowsQuitting || documentVersion !== getMainWindowDocumentVersion(window)) return;
    if (isMainWindowSender(event.sender) && event.senderFrame === event.sender.mainFrame) {
      markMainWindowContentReady(window);
      presentedMainWindows.add(window);
    }
  } catch (error) {
    if (documentVersion === getMainWindowDocumentVersion(window)) {
      failInitialWindowPresentation(window, error);
    }
    throw error;
  }
});
ipcMain.handle("paseo:pet:startup-ready", async (event) => {
  if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Startup readiness requires a main application window");
  }
  await bootstrapComplete;
  if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) return;
  await petController?.start();
});
ipcMain.handle("paseo:window:closeChoiceReady", (event) => {
  return closeChoiceRequests.getPending(event.sender.id);
});

ipcMain.handle("paseo:window:respondCloseChoice", (event, response: unknown) => {
  return closeChoiceRequests.respond(event.sender.id, response);
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getAppDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }

  return path.resolve(__dirname, "../../app/dist");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon-dev.png"),
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [
    path.resolve(__dirname, "../assets/icon-dev.png"),
    path.resolve(__dirname, "../assets/icon.png"),
  ];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
function getTrayIconPath(): string | null {
  if (process.platform !== "darwin") {
    return getWindowIconPath();
  }
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "trayTemplate.png")
    : path.resolve(__dirname, "../assets/trayTemplate.png");
  return existsSync(candidate) ? candidate : null;
}

function getDevBuildLabel(): string | null {
  if (app.isPackaged) {
    return null;
  }
  return process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;
}

let cachedEffectiveIconPath: string | null = null;

async function getEffectiveAppIconPath(): Promise<string | null> {
  if (cachedEffectiveIconPath !== null) {
    return cachedEffectiveIconPath;
  }
  const baseIconPath = getWindowIconPath();
  if (app.isPackaged || !baseIconPath) {
    cachedEffectiveIconPath = baseIconPath;
    return baseIconPath;
  }
  const devLabel = getDevBuildLabel();
  cachedEffectiveIconPath = await resolveAppIconPath({
    isPackaged: false,
    baseIconPath,
    devLabel,
    cacheDir: app.getPath("userData"),
  });
  return cachedEffectiveIconPath;
}

async function applyAppIcon(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const iconPath = await getEffectiveAppIconPath();
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

function getInitialWindowUrl(initialRoute?: string | null): string {
  if (app.isPackaged) return `${APP_SCHEME}://app${initialRoute ?? "/"}`;
  return initialRoute ? new URL(initialRoute, `${DEV_SERVER_URL}/`).toString() : DEV_SERVER_URL;
}

function assertWindowCreationAllowed(canCreate?: () => boolean): void {
  if (mainWindowsQuitting || (canCreate && !canCreate())) {
    throw new Error("Window creation was canceled because the application is closing");
  }
}

async function createWindow(
  options: {
    initialRoute?: string | null;
    pendingOpenProjectPath?: string | null;
    restoreWindowState?: boolean;
  } = {},
  canCreate?: () => boolean,
): Promise<BrowserWindow> {
  const iconPath = await getEffectiveAppIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;
  assertWindowCreationAllowed(canCreate);

  const title = devWorktreeName ? `${APP_NAME} (${devWorktreeName})` : APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: app.isPackaged ? "#181818" : getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      platform: process.platform,
      theme: systemTheme,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  if (APP_NAME !== "OMP Desktop") {
    mainWindow.on("page-title-updated", (event) => event.preventDefault());
  }
  registerMainWindow(mainWindow);
  restoreWindowStateByWindow.set(mainWindow, restoreWindowState);
  mainWindow.on("show", () => presentedMainWindows.add(mainWindow));
  registerWallpaperWindow(mainWindow);
  backgroundModeController.registerWindow(mainWindow);

  const webContentsId = mainWindow.webContents.id;
  let initialDocumentVersion: number | undefined;
  let captureInitialNavigation = false;
  mainWindow.webContents.once("destroyed", () => petController?.clearActivity(webContentsId));
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    petController?.clearActivity(webContentsId);
    if (!presentedMainWindows.has(mainWindow)) {
      failInitialWindowPresentation(mainWindow, new Error(`Renderer exited: ${details.reason}`));
      return;
    }
    backgroundModeController.markWindowRendererUnavailable(mainWindow);
    void rendererLossRecoveryController.handleRendererLoss(mainWindow, details);
  });
  if (PASEO_DEBUG) {
    mainWindow.webContents.on("did-fail-load", (...args: unknown[]) => {
      log.error("[renderer] page load failed", args);
    });
  }
  pendingOpenProjectStore.set(webContentsId, options.pendingOpenProjectPath);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      markMainWindowLoading(mainWindow);
      // Keep the initial request's generation, never a replacement navigation's.
      if (captureInitialNavigation) {
        initialDocumentVersion = getMainWindowDocumentVersion(mainWindow);
        captureInitialNavigation = false;
      }
      agentNavigationInbox.windowLoading(webContentsId);
      petController?.clearActivity(webContentsId);
    }
  });
  mainWindow.on("closed", () => {
    pendingOpenProjectStore.delete(webContentsId);
    agentNavigationInbox.removeWindow(webContentsId);
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  try {
    const initialUrl = getInitialWindowUrl(options.initialRoute);
    initialDocumentVersion = getMainWindowDocumentVersion(mainWindow);
    captureInitialNavigation = process.platform === "win32";
    await mainWindow.loadURL(initialUrl);
    captureInitialNavigation = false;
    if (process.platform === "win32") {
      markMainWindowDocumentLoaded(mainWindow, initialDocumentVersion);
    }
    return mainWindow;
  } catch (error) {
    failInitialWindowPresentation(mainWindow, error);
    throw error;
  }
}
let backgroundTray: Tray | null = null;
let backgroundTrayActions: { restore: () => void; quit: () => void } | null = null;

function updateBackgroundTrayContextMenu(): void {
  if (!backgroundTray || !backgroundTrayActions) {
    return;
  }
  const labels = getDesktopContextMenuLabels();
  backgroundTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.showApp, click: backgroundTrayActions.restore },
      {
        label: app.getLocale().startsWith("zh") ? "OMP 本地监控" : "OMP Local Monitor",
        click: () => {
          void bootstrapComplete
            .then(() => monitorController?.open())
            .catch((error: unknown) => log.error("[local-monitor] Failed to open", error));
        },
      },
      { type: "separator" },
      { label: labels.quitApp, click: backgroundTrayActions.quit },
    ]),
  );
}

const backgroundModeController = new BackgroundModeController({
  promptForCloseChoice: async (window) => {
    const settingsStore = getDesktopSettingsStore();
    const closeBehavior = (await settingsStore.get()).window.closeBehavior;
    if (closeBehavior !== "ask") {
      return closeBehavior;
    }

    const result = await closeChoiceRequests.request((window as BrowserWindow).webContents);
    if (result.remember && result.choice !== "cancel") {
      try {
        await settingsStore.patch({ window: { closeBehavior: result.choice } });
      } catch (error) {
        log.error("[background mode] failed to remember close choice", error);
      }
    }
    return result.choice;
  },
  createTray: ({ restore, quit }) => {
    backgroundTrayActions = { restore, quit };
    const iconPath = getTrayIconPath();
    if (!iconPath) {
      throw new Error("Cannot create the system tray without a tray icon");
    }
    const sourceIcon = nativeImage.createFromPath(iconPath);
    if (sourceIcon.isEmpty()) {
      throw new Error(`Cannot create the system tray from invalid icon: ${iconPath}`);
    }
    if (process.platform === "darwin") {
      sourceIcon.setTemplateImage(true);
    }
    let trayIcon: string | NativeImage;
    if (process.platform === "win32") {
      trayIcon = iconPath;
    } else if (process.platform === "darwin") {
      trayIcon = sourceIcon;
    } else {
      trayIcon = sourceIcon.resize({ width: 16, height: 16, quality: "best" });
    }
    backgroundTray = new Tray(trayIcon);
    backgroundTray.setToolTip(APP_NAME);
    backgroundTray.on("click", restore);
    updateBackgroundTrayContextMenu();
    log.info("[background mode] system tray created", { iconPath });
  },
  getWindows: getMainWindows,
  createWindow: async () => {
    await bootstrapComplete;
    return getOrCreateMainWindow(() => createWindow({ restoreWindowState: true }));
  },
  showWindow: (window, focus) => showMainWindow(window as BrowserWindow, focus),
  quitApp: () => app.quit(),
  onError: (error) => log.error("[background mode] operation failed", error),
});

const rendererLossRecoveryController = new RendererLossRecoveryController<BrowserWindow>({
  getReplacementOptions: (window) => ({
    initialRoute: getRendererRecoveryRoute(window.webContents.getURL()),
    pendingOpenProjectPath: pendingOpenProjectStore.take(window.webContents.id),
    restoreWindowState: restoreWindowStateByWindow.get(window) ?? false,
  }),
  showRecoveryPrompt: (window, details) =>
    showRendererLossPrompt(window, (options) => dialog.showMessageBox(window, options), details),
  showRecoveryFailure: (window, error) =>
    showRendererRecoveryFailure(window, (options) => dialog.showMessageBox(window, options), error),
  createWindow: (options, failedWindow) =>
    createWindow(options, () => !mainWindowsQuitting && !failedWindow.isDestroyed()),
  closeWindow: (window) => backgroundModeController.closeWindow(window),
  onRendererLoss: (_window, details) => {
    const rendererDetails: { reason: string; exitCode?: number } = { reason: details.reason };
    if (typeof details.exitCode === "number") rendererDetails.exitCode = details.exitCode;
    log.error("[renderer] process gone", rendererDetails);
  },
  onError: (error) => log.error("[renderer] recovery failed", error),
});

onDesktopContextMenuLabelsChange(updateBackgroundTrayContextMenu);

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function focusExistingWindow(): BrowserWindow | null {
  const mainWindow = selectMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  showMainWindow(mainWindow);
  return mainWindow;
}

async function focusOrCreateWindow(): Promise<void> {
  const window = await getOrCreateMainWindow(() => createWindow({ restoreWindowState: true }));
  showMainWindow(window);
}

function focusExistingWindowOnAgent(target: AgentDeepLinkTarget): void {
  const mainWindow = focusExistingWindow();
  if (!mainWindow) {
    let createdForTarget = false;
    void getOrCreateMainWindow(() => {
      createdForTarget = true;
      return createWindow({
        initialRoute: buildAgentDeepLinkRoute(target),
        restoreWindowState: true,
      });
    })
      .then(() => {
        if (!createdForTarget) focusExistingWindowOnAgent(target);
        return undefined;
      })
      .catch((error) => log.error("[window] failed to open window for agent link", error));
    return;
  }

  const deliverable = agentNavigationInbox.deliverOrQueue(mainWindow.webContents.id, target);
  if (deliverable) {
    mainWindow.webContents.send("paseo:event:open-agent", deliverable);
  }
}

function receiveAgentDeepLink(input: string): void {
  const target = parseAgentDeepLink(input);
  if (!target) {
    return;
  }

  if (bootstrapIsComplete) {
    focusExistingWindowOnAgent(target);
    return;
  }

  pendingAgentNavigation = target;
  void bootstrapComplete.then(() => {
    if (pendingAgentNavigation !== target) {
      return undefined;
    }
    pendingAgentNavigation = null;
    focusExistingWindowOnAgent(target);
    return undefined;
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAgentDeepLink(url);
});

function setupSingleInstanceLock(): boolean {
  // Acquire this before app.whenReady() so a concurrent cold start cannot
  // initialize a second desktop process.

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // This process owns no windows or daemon; do not run the primary's quit hooks.
    app.exit(0);
    return false;
  }
  ownsDesktopInstance = true;

  app.on("second-instance", (_event, commandLine) => {
    const agentTarget = parseAgentDeepLinkFromArgv(commandLine);
    if (agentTarget) {
      void bootstrapComplete.then(() => focusExistingWindowOnAgent(agentTarget));
      return;
    }

    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // A normal relaunch foregrounds the existing desktop. An explicit project
    // launch remains a new window inside the already-running app process.
    void bootstrapComplete
      .then(async () => {
        if (openProjectPath) await createWindow({ pendingOpenProjectPath: openProjectPath });
        else await focusOrCreateWindow();
        return undefined;
      })
      .catch((error) => {
        log.error("[window] failed to handle second-instance launch", error);
      });
  });
  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();
  // Load and publish authoritative membership independently of optional pet startup.
  try {
    await getDesktopSettingsStore().getWallpaperLibrary();
  } catch (error) {
    // Keep settings and URL wallpapers usable; getLibrary reports the persisted error.
    log.error("[wallpaper] failed to load candidate library", error);
  }
  try {
    await clearRetiredBrowserProfiles(session, (partition, error) => {
      log.warn("[browser-profile] failed to clear retired partition", { partition, error });
    });
  } catch (error) {
    log.warn("[browser-profile] failed to locate retired partitions", { error });
  }

  const appDistDir = getAppDistDir();
  protocol.handle(APP_SCHEME, async (request) => {
    const { hostname, pathname, search, hash } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);
    if (hostname === "monitor") {
      if (decodedPath !== "/local-monitor") return new Response("Not found", { status: 404 });
      return new Response(MONITOR_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (decodedPath === "/desktop-pet") {
      return new Response(PET_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (decodedPath === "/wallpaper-media") {
      return createWallpaperMediaResponse(
        request,
        wallpaperMediaRegistry,
        app.isPackaged ? null : new URL(DEV_SERVER_URL).origin,
      );
    }
    const petResource = await getPetLibrary().handleResource(decodedPath);
    if (petResource) return petResource;

    // Chromium can occasionally request the exported entrypoint directly.
    // Canonicalize it back to the route URL so Expo Router sees `/`, not `/index.html`.
    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback: serve index.html for routes without a file extension
    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  await applyAppIcon();
  backgroundModeController.initializeTray();
  setupApplicationMenu({
    onNewWindow: () => {
      void createWindow().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  registerEditorTargetHandlers();
  registerRemoteSshHandlers();
  registerScreenshotHandler();
  monitorController = new OmpMonitorController();
  monitorController.initialize();
  petController = new DesktopPetController({
    openApp: async () => {
      await bootstrapComplete;
      await focusOrCreateWindow();
    },
    openTask: async (task) => {
      await bootstrapComplete;
      focusExistingWindowOnAgent({ serverId: task.serverId, agentId: task.agentId });
    },
  });
  try {
    await petController.initialize();
  } catch (error) {
    // A damaged persisted library must remain untouched, not prevent the UI from opening.
    petController.dispose();
    petController = null;
    log.error("[desktop-settings] Companion unavailable; opening the main window", error);
  }

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await createWindow({
      pendingOpenProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The first window of the session restores and persists saved geometry.
  const initialAgentNavigation = pendingAgentNavigation;
  pendingAgentNavigation = null;
  await createWindow({
    initialRoute: initialAgentNavigation ? buildAgentDeepLinkRoute(initialAgentNavigation) : null,
    pendingOpenProjectPath,
    restoreWindowState: true,
  });
  pendingOpenProjectPath = null;

  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  bootstrapIsComplete = true;
  resolveBootstrapComplete();

  if (pendingAgentNavigation) {
    const target = pendingAgentNavigation;
    pendingAgentNavigation = null;
    focusExistingWindowOnAgent(target);
  }

  app.on("activate", () => {
    backgroundModeController.restoreWindows();
  });
}

void (async () => {
  if (await tryRunPetCreationCli()) return;
  await runDesktopStartup({
    hasPendingGuiLaunchRequest: Boolean(pendingOpenProjectPath || pendingAgentNavigation),
    runCliPassthroughIfRequested,
    inheritLoginShellEnv,
    bootstrapGui: bootstrap,
  });
})().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of getMainWindows()) {
    win.webContents.send("paseo:event:quitting", {});
  }
}

// The headless pet installer owns neither the GUI nor its managed daemon.
if (!isPetCreationCli) {
  const quitLifecycle = createQuitLifecycle({
    app,
    closeTransportSessions: closeAllTransportSessions,
    stopDesktopManagedDaemonIfNeeded: async () => {
      await monitorController?.dispose();
      return stopDesktopManagedDaemonOnQuitIfNeeded({
        settingsStore: getDesktopSettingsStore(),
        isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
        stopDaemon: () => stopDesktopDaemonViaCli("quit"),
        showShutdownFeedback: showDaemonShutdownDialog,
      });
    },
    installAppUpdateOnQuit: async (signal) => {
      // Startup exception: updater loading belongs to an update/quit operation,
      // not the first-window critical path.
      const { installAppUpdateOnQuit } = require("./features/auto-updater.js") as typeof AppUpdater;
      const { releaseChannel } = await getDesktopSettingsStore().get();
      return await installAppUpdateOnQuit({
        currentVersion: app.getVersion(),
        releaseChannel,
        signal,
      });
    },
    createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
    onStopError: (error) => {
      log.error("[desktop daemon] failed to stop managed daemon on quit", error);
    },
    onUpdateError: (error) => {
      log.error("[auto-updater] failed to validate downloaded update on quit", error);
    },
  });

  electronAutoUpdater.on("before-quit-for-update", () => {
    quitLifecycle.handleBeforeQuitForUpdate();
  });

  app.on("before-quit", (event) => {
    // A failed-lock relaunch must not stop the primary GUI's daemon or updater.
    if (!ownsDesktopInstance) return;
    mainWindowsQuitting = true;
    rendererLossRecoveryController.beginShutdown();
    beginMainWindowShutdown();
    backgroundModeController.markAppQuitting();
    petController?.beginShutdown();
    void monitorController?.dispose();
    quitLifecycle.handleBeforeQuit(event);
  });
  registerExternalQuitSignals({ signals: process, quit: () => app.quit() });
}

app.on("window-all-closed", () => {
  // The install CLI exits only after conversion and the atomic import finish.
  if (!isPetCreationCli && process.platform !== "darwin") {
    app.quit();
  }
});
