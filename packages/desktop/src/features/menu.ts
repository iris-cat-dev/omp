import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { getActivePaseoBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";
import { isAllowedExternalUrl } from "./opener.js";
import { getDesktopContextMenuLabels, setDesktopContextMenuLabels } from "./context-menu-labels.js";

interface TerminalContextMenuInput {
  kind: "terminal";
  hasSelection?: boolean;
  clearLabel?: string;
}

interface LinkContextMenuInput {
  kind: "assistant-http-link";
  url: string;
  openInDesktopLabel: string;
  openExternalLabel: string;
  copyAddressLabel: string;
}

type ShowContextMenuInput = TerminalContextMenuInput | LinkContextMenuInput;

export type TerminalContextMenuAction = "clear";
export type LinkContextMenuAction = "open-in-desktop";
type ContextMenuAction = TerminalContextMenuAction | LinkContextMenuAction;

export function buildTerminalContextMenuTemplate(
  input: Omit<TerminalContextMenuInput, "kind">,
  onAction: (action: TerminalContextMenuAction) => void,
): Electron.MenuItemConstructorOptions[] {
  const labels = getDesktopContextMenuLabels();
  return [
    {
      label: labels.copy,
      role: "copy",
      enabled: input.hasSelection === true,
    },
    {
      label: labels.paste,
      role: "paste",
    },
    {
      type: "separator",
    },
    {
      label: labels.selectAll,
      role: "selectAll",
    },
    {
      type: "separator",
    },
    {
      label: input.clearLabel?.trim() || labels.clear,
      click: () => onAction("clear"),
    },
  ];
}

interface LinkContextMenuCallbacks {
  onOpenInDesktop: () => void;
  onOpenExternal: () => void;
  onCopyAddress: () => void;
}

export function buildLinkContextMenuTemplate(
  input: LinkContextMenuInput,
  callbacks: LinkContextMenuCallbacks,
): Electron.MenuItemConstructorOptions[] {
  const labels = getDesktopContextMenuLabels();
  return [
    {
      label: input.openInDesktopLabel.trim() || labels.openInDesktop,
      click: callbacks.onOpenInDesktop,
    },
    {
      label: input.openExternalLabel.trim() || labels.openExternal,
      click: callbacks.onOpenExternal,
    },
    {
      label: input.copyAddressLabel.trim() || labels.copyAddress,
      click: callbacks.onCopyAddress,
    },
  ];
}

interface ApplicationMenuOptions {
  onNewWindow: () => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win = baseWin instanceof BrowserWindow ? baseWin : BrowserWindow.getFocusedWindow();
    if (win) callback(win);
  };
}

interface ReloadableWebContents {
  isLoadingMainFrame(): boolean;
  stop(): void;
  reload(): void;
  reloadIgnoringCache(): void;
}

interface ReloadableWindow {
  webContents: ReloadableWebContents & { id: number };
}

interface ReloadActiveBrowserOrWindowInput {
  win: ReloadableWindow;
  getActiveBrowserContentsForHostWindow: (
    hostWebContentsId: number,
  ) => ReloadableWebContents | null;
  ignoreCache?: boolean;
}

export function reloadActiveBrowserOrWindow({
  win,
  getActiveBrowserContentsForHostWindow,
  ignoreCache = false,
}: ReloadActiveBrowserOrWindowInput): void {
  const browserContents = getActiveBrowserContentsForHostWindow(win.webContents.id);
  if (browserContents) {
    if (ignoreCache) {
      browserContents.reloadIgnoringCache();
      return;
    }
    if (browserContents.isLoadingMainFrame()) {
      browserContents.stop();
      return;
    }
    browserContents.reload();
    return;
  }

  if (ignoreCache) {
    win.webContents.reloadIgnoringCache();
    return;
  }
  win.webContents.reload();
}

function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  capturing: boolean,
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  const zoomEnabled = !capturing;

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            options.onNewWindow();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
          }),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
          }),
        },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(0);
          }),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActivePaseoBrowserWebContentsForHostWindow,
            });
          }),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActivePaseoBrowserWebContentsForHostWindow,
              ignoreCache: true,
            });
          }),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];
}

let applicationMenuOptions: ApplicationMenuOptions | null = null;
let capturingShortcut = false;

function rebuildApplicationMenu(): void {
  if (!applicationMenuOptions) return;
  const menu = Menu.buildFromTemplate(
    buildApplicationMenuTemplate(applicationMenuOptions, capturingShortcut),
  );
  Menu.setApplicationMenu(menu);
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  applicationMenuOptions = options;
  rebuildApplicationMenu();

  ipcMain.handle(
    "paseo:menu:showContextMenu",
    (event, input?: ShowContextMenuInput): Promise<ContextMenuAction | null> | undefined => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !input) {
        return;
      }

      let selectedAction: ContextMenuAction | null = null;
      let template: Electron.MenuItemConstructorOptions[];
      if (input.kind === "terminal") {
        template = buildTerminalContextMenuTemplate(input, (action) => {
          selectedAction = action;
        });
      } else if (input.kind === "assistant-http-link" && isAllowedExternalUrl(input.url)) {
        template = buildLinkContextMenuTemplate(input, {
          onOpenInDesktop: () => {
            selectedAction = "open-in-desktop";
          },
          onOpenExternal: () => {
            void shell.openExternal(input.url);
          },
          onCopyAddress: () => {
            clipboard.writeText(input.url);
          },
        });
      } else {
        return;
      }

      const contextMenu = Menu.buildFromTemplate(template);
      const { promise, resolve } = Promise.withResolvers<ContextMenuAction | null>();
      contextMenu.popup({
        window: win,
        callback: () => resolve(selectedAction),
      });
      return promise;
    },
  );

  ipcMain.handle("paseo:menu:set-context-menu-labels", (_event, labels: unknown) => {
    if (!setDesktopContextMenuLabels(labels)) {
      throw new Error("Invalid context menu labels");
    }
  });

  // Disable the zoom accelerators while capturing a shortcut so combos like
  // Cmd+- / Cmd+= reach the renderer instead of zooming the window.
  ipcMain.handle("paseo:menu:set-capturing-shortcut", (_event, capturing?: boolean) => {
    capturingShortcut = capturing === true;
    rebuildApplicationMenu();
  });

  // If the renderer reloads mid-capture (e.g. Cmd+R) the renderer-side effect
  // never gets to send `false`, so reset the flag from the main process when a
  // main window finishes loading. Workspace browser webviews are not
  // BrowserWindows, so they don't trigger this.
  app.on("browser-window-created", (_event, win) => {
    win.webContents.on("did-finish-load", () => {
      if (!capturingShortcut) return;
      capturingShortcut = false;
      rebuildApplicationMenu();
    });
  });
}
