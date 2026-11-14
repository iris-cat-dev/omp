import { app, BrowserWindow, clipboard, ipcMain, Menu } from "electron";
import log from "electron-log/main";
import { isAllowedExternalUrl, openExternalUrl } from "./opener.js";
import { getDesktopContextMenuLabels, setDesktopContextMenuLabels } from "./context-menu-labels.js";
import { getMainWindows, isMainWindowSender, selectMainWindow } from "../window/main-windows.js";

interface ComposerContextMenuInput {
  kind: "composer-input";
  hasSelection: boolean;
  isEditable: boolean;
}

interface TerminalContextMenuInput {
  kind: "terminal";
  hasSelection?: boolean;
  clearLabel?: string;
}

interface LinkContextMenuInput {
  kind: "assistant-http-link";
  url: string;
  openExternalLabel: string;
  copyAddressLabel: string;
}

interface FileLinkContextMenuInput {
  kind: "assistant-file-link";
  revealLabel: string;
}

type ShowContextMenuInput =
  | ComposerContextMenuInput
  | TerminalContextMenuInput
  | LinkContextMenuInput
  | FileLinkContextMenuInput;

export type TerminalContextMenuAction = "clear";
type ContextMenuAction = TerminalContextMenuAction | "reveal-in-file-manager";

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
  onOpenExternal: () => void;
  onCopyAddress: () => void;
}

function buildLinkContextMenuTemplate(
  input: LinkContextMenuInput,
  callbacks: LinkContextMenuCallbacks,
): Electron.MenuItemConstructorOptions[] {
  const labels = getDesktopContextMenuLabels();
  return [
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
  renderingDiagnosticsEnabled: boolean;
  onRecordRenderingIssue: (window: BrowserWindow | null) => void;
  onOpenRenderingLogs: () => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win =
      baseWin instanceof BrowserWindow && getMainWindows().includes(baseWin)
        ? baseWin
        : selectMainWindow();
    if (win) callback(win);
  };
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
            win.webContents.reload();
          }),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            win.webContents.reloadIgnoringCache();
          }),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(process.platform === "win32"
          ? [
              { type: "separator" as const },
              {
                label: "Record Rendering Issue",
                accelerator: "CmdOrCtrl+Alt+Shift+D",
                enabled: options.renderingDiagnosticsEnabled,
                click: (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => {
                  const window =
                    baseWin instanceof BrowserWindow && getMainWindows().includes(baseWin)
                      ? baseWin
                      : selectMainWindow();
                  options.onRecordRenderingIssue(window ?? null);
                },
              },
              { label: "Open Rendering Logs", click: options.onOpenRenderingLogs },
            ]
          : []),
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
const applicationMenuContributions = new Map<string, () => Electron.MenuItemConstructorOptions[]>();
export function registerApplicationMenuContribution(
  id: string,
  items: () => Electron.MenuItemConstructorOptions[],
): () => void {
  if (applicationMenuContributions.has(id))
    throw new Error(`Duplicate application menu contribution: ${id}.`);
  applicationMenuContributions.set(id, items);
  rebuildApplicationMenu();
  return () => {
    applicationMenuContributions.delete(id);
    rebuildApplicationMenu();
  };
}

function rebuildApplicationMenu(): void {
  if (!applicationMenuOptions) return;
  const template = buildApplicationMenuTemplate(applicationMenuOptions, capturingShortcut);
  const pluginItems = [...applicationMenuContributions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, items]) => items());
  if (pluginItems.length) template.push({ label: "Plugins", submenu: pluginItems });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  applicationMenuOptions = options;
  rebuildApplicationMenu();
  app.on("browser-window-focus", rebuildApplicationMenu);
  app.on("browser-window-blur", rebuildApplicationMenu);

  ipcMain.handle(
    "paseo:menu:showContextMenu",
    (event, input?: ShowContextMenuInput): Promise<ContextMenuAction | null> | undefined => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !input) {
        return;
      }

      let selectedAction: ContextMenuAction | null = null;
      let template: Electron.MenuItemConstructorOptions[];
      if (input.kind === "composer-input") {
        if (
          !isMainWindowSender(event.sender) ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          typeof input.hasSelection !== "boolean" ||
          typeof input.isEditable !== "boolean"
        ) {
          return;
        }
        const labels = getDesktopContextMenuLabels();
        template = [
          {
            label: labels.cut,
            role: "cut",
            enabled: input.isEditable && input.hasSelection,
          },
          { label: labels.copy, role: "copy", enabled: input.hasSelection },
          { label: labels.paste, role: "paste", enabled: input.isEditable },
          { type: "separator" },
          { label: labels.selectAll, role: "selectAll" },
        ];
      } else if (input.kind === "terminal") {
        template = buildTerminalContextMenuTemplate(input, (action) => {
          selectedAction = action;
        });
      } else if (input.kind === "assistant-http-link" && isAllowedExternalUrl(input.url)) {
        template = buildLinkContextMenuTemplate(input, {
          onOpenExternal: () => {
            void openExternalUrl(input.url).catch((error) => {
              log.error("[opener] failed to open context-menu URL", error);
            });
          },
          onCopyAddress: () => {
            clipboard.writeText(input.url);
          },
        });
      } else if (input.kind === "assistant-file-link" && typeof input.revealLabel === "string") {
        template = [
          {
            label: input.revealLabel,
            click: () => {
              selectedAction = "reveal-in-file-manager";
            },
          },
        ];
      } else {
        return;
      }

      const contextMenu = Menu.buildFromTemplate(template);
      const { promise, resolve } = Promise.withResolvers<ContextMenuAction | null>();
      if (input.kind === "composer-input") {
        // IPC may arrive after native focus changed; edit roles must target this editor's window.
        win.webContents.focus();
      }
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

  // If the renderer reloads mid-capture (e.g. Cmd+R) its cleanup callback
  // never gets to send `false`, so reset the flag when the window finishes loading.
  app.on("browser-window-created", (...args: unknown[]) => {
    const win = args.find((value): value is BrowserWindow => value instanceof BrowserWindow);
    win?.webContents.on("did-finish-load", () => {
      if (!capturingShortcut) return;
      capturingShortcut = false;
      rebuildApplicationMenu();
    });
  });
}
