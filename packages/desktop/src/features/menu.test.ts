import { BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerminalContextMenuTemplate, setupApplicationMenu } from "./menu.js";
import { registerMainWindow } from "../window/main-windows.js";
import { getDesktopContextMenuLabels } from "./context-menu-labels.js";

vi.mock("electron", () => ({
  app: { name: "OMP Desktop", on: vi.fn() },
  BrowserWindow: Object.assign(function BrowserWindowMock() {}, {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn(),
  }),
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

describe("window reload shortcuts", () => {
  it("reloads the selected application window without targeting a guest", () => {
    vi.clearAllMocks();
    setupApplicationMenu({
      onNewWindow: vi.fn(),
      renderingDiagnosticsEnabled: false,
      onRecordRenderingIssue: vi.fn(),
      onOpenRenderingLogs: vi.fn(),
    });
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];
    const view = menu?.find((entry) => entry.label === "View");
    const actions = Array.isArray(view?.submenu) ? view.submenu : [];
    const reload = actions.find((item) => item.label === "Reload");
    const forceReload = actions.find((item) => item.label === "Force Reload");
    const first = new BrowserWindow();
    const second = new BrowserWindow();
    const firstReload = vi.fn();
    const forceFirstReload = vi.fn();
    Object.assign(first, {
      webContents: {
        reload: firstReload,
        reloadIgnoringCache: forceFirstReload,
        isDestroyed: () => false,
        once: vi.fn(),
      },
      once: vi.fn(),
      on: vi.fn(),
      isDestroyed: () => false,
      isVisible: () => true,
    });
    Object.assign(second, {
      webContents: { reload: vi.fn(), reloadIgnoringCache: vi.fn() },
    });
    registerMainWindow(first);

    reload?.click?.(null as never, first, null as never);
    forceReload?.click?.(null as never, first, null as never);

    expect(firstReload).toHaveBeenCalledOnce();
    expect(forceFirstReload).toHaveBeenCalledOnce();
    expect(second.webContents.reload).not.toHaveBeenCalled();
  });
});

describe("terminal context menu", () => {
  it("offers the localized Clear action and reports its selection", () => {
    const onAction = vi.fn();
    const template = buildTerminalContextMenuTemplate(
      { hasSelection: false, clearLabel: "清空" },
      onAction,
    );
    const clearItem = template.find((item) => item.label === "清空");

    expect(clearItem).toBeDefined();
    clearItem?.click?.(null as never, undefined, null as never);
    expect(onAction).toHaveBeenCalledWith("clear");
  });
});

describe("assistant HTTP link context menu", () => {
  it("offers localized link actions and copies the original URL without decoding it", () => {
    vi.clearAllMocks();
    const url = "https://example.com/a%20b?q=x%2Fy#section";
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as BrowserWindow);
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({
      popup: vi.fn(),
    } as unknown as Electron.Menu);
    setupApplicationMenu({
      onNewWindow: vi.fn(),
      renderingDiagnosticsEnabled: false,
      onRecordRenderingIssue: vi.fn(),
      onOpenRenderingLogs: vi.fn(),
    });
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === "paseo:menu:showContextMenu")?.[1];
    if (!handler) throw new Error("context menu handler was not registered");
    vi.mocked(Menu.buildFromTemplate).mockClear();
    void handler({ sender: {} } as Electron.IpcMainInvokeEvent, {
      kind: "assistant-http-link",
      url,
      openExternalLabel: "在浏览器中打开链接",
      copyAddressLabel: "复制链接地址",
    });
    const actions = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];

    expect(actions?.map((item) => item.label)).toEqual(["在浏览器中打开链接", "复制链接地址"]);
    actions?.[1]?.click?.(null as never, undefined, null as never);
    expect(clipboard.writeText).toHaveBeenCalledWith(url);
  });
});

describe("assistant file link context menu", () => {
  const popup = vi.fn();
  const win = {} as BrowserWindow;
  const sender = {} as Electron.WebContents;
  let showContextMenu: (
    event: { sender: Electron.WebContents },
    input: { kind: "assistant-file-link"; revealLabel: string },
  ) => Promise<"reveal-in-file-manager" | null> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    popup.mockReset();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win);
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({ popup } as unknown as Electron.Menu);
    setupApplicationMenu({
      onNewWindow: vi.fn(),
      renderingDiagnosticsEnabled: false,
      onRecordRenderingIssue: vi.fn(),
      onOpenRenderingLogs: vi.fn(),
    });
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === "paseo:menu:showContextMenu")?.[1];
    if (!handler) {
      throw new Error("context menu handler was not registered");
    }
    showContextMenu = handler as typeof showContextMenu;
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  it("returns reveal selection without executing any file operation", async () => {
    const result = showContextMenu(
      { sender },
      { kind: "assistant-file-link", revealLabel: "在访达中显示" },
    );
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];
    expect(template?.map((item) => item.label)).toEqual(["在访达中显示"]);
    expect(popup).toHaveBeenCalledWith({ window: win, callback: expect.any(Function) });

    template?.[0]?.click?.(null as never, undefined, null as never);
    popup.mock.calls[0]?.[0].callback();

    await expect(result).resolves.toBe("reveal-in-file-manager");
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("returns null when the file context menu is dismissed", async () => {
    const result = showContextMenu(
      { sender },
      { kind: "assistant-file-link", revealLabel: "Reveal in File Manager" },
    );
    popup.mock.calls[0]?.[0].callback();

    await expect(result).resolves.toBeNull();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("composer input context menu", () => {
  const popup = vi.fn();
  let win: BrowserWindow;
  let sender: Electron.WebContents;
  let handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = Object.assign(new EventEmitter(), {
      id: 300,
      mainFrame: {},
      isDestroyed: () => false,
      focus: vi.fn(),
    }) as unknown as Electron.WebContents;
    win = Object.assign(new EventEmitter(), {
      webContents: sender,
      isDestroyed: () => false,
    }) as unknown as BrowserWindow;
    registerMainWindow(win);
    popup.mockImplementation((options: Electron.PopupOptions) => {
      expect(sender.focus).toHaveBeenCalledOnce();
      options.callback?.();
    });
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win);
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({ popup } as unknown as Electron.Menu);
    setupApplicationMenu({
      onNewWindow: vi.fn(),
      renderingDiagnosticsEnabled: false,
      onRecordRenderingIssue: vi.fn(),
      onOpenRenderingLogs: vi.fn(),
    });
    const registered = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === "paseo:menu:showContextMenu")?.[1];
    if (!registered) throw new Error("context menu handler was not registered");
    handler = registered;
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  afterEach(() => {
    win.emit("closed");
  });

  function event(frame: object | undefined = sender.mainFrame): Electron.IpcMainInvokeEvent {
    return { sender, senderFrame: frame } as Electron.IpcMainInvokeEvent;
  }

  it("opens real native edit roles for a registered main-frame editor", async () => {
    const labels = getDesktopContextMenuLabels();
    const result = handler(event(), {
      kind: "composer-input",
      hasSelection: true,
      isEditable: true,
    });
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];

    expect(template).toEqual([
      { label: labels.cut, role: "cut", enabled: true },
      { label: labels.copy, role: "copy", enabled: true },
      { label: labels.paste, role: "paste", enabled: true },
      { type: "separator" },
      { label: labels.selectAll, role: "selectAll" },
    ]);
    expect(popup).toHaveBeenCalledExactlyOnceWith({
      window: win,
      callback: expect.any(Function),
    });
    await expect(result).resolves.toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("disables cut and copy for an empty selection without disabling native Paste", () => {
    handler(event(), { kind: "composer-input", hasSelection: false, isEditable: true });
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];

    expect(template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "cut", enabled: false }),
        expect.objectContaining({ role: "copy", enabled: false }),
        expect.objectContaining({ role: "paste", enabled: true }),
      ]),
    );
  });

  it("keeps copy and select all while disabling mutations for a locked editor", () => {
    handler(event(), { kind: "composer-input", hasSelection: true, isEditable: false });
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0];

    expect(template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "cut", enabled: false }),
        expect.objectContaining({ role: "copy", enabled: true }),
        expect.objectContaining({ role: "paste", enabled: false }),
        expect.objectContaining({ role: "selectAll" }),
      ]),
    );
  });

  it("rejects subframes, missing frame identity and unregistered window senders", () => {
    const input = { kind: "composer-input", hasSelection: true, isEditable: true };
    handler(event({}), input);
    handler({ sender } as Electron.IpcMainInvokeEvent, input);
    const foreignSender = Object.assign(new EventEmitter(), {
      mainFrame: {},
      isDestroyed: () => false,
    }) as unknown as Electron.WebContents;
    handler(
      {
        sender: foreignSender,
        senderFrame: foreignSender.mainFrame,
      } as Electron.IpcMainInvokeEvent,
      input,
    );

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });

  it("rejects malformed editor state instead of enabling native actions by coercion", () => {
    for (const input of [
      { kind: "composer-input", isEditable: true },
      { kind: "composer-input", hasSelection: false },
      { kind: "composer-input", hasSelection: "yes", isEditable: true },
      { kind: "composer-input", hasSelection: false, isEditable: "yes" },
    ]) {
      handler(event(), input);
    }

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
