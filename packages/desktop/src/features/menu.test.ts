import { BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTerminalContextMenuTemplate, setupApplicationMenu } from "./menu.js";

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
    setupApplicationMenu({ onNewWindow: vi.fn() });
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
      webContents: { reload: firstReload, reloadIgnoringCache: forceFirstReload },
    });
    Object.assign(second, {
      webContents: { reload: vi.fn(), reloadIgnoringCache: vi.fn() },
    });

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
  it("opens the original URL in the system browser, never in an app guest", () => {
    vi.clearAllMocks();
    const url = "https://example.com/a%20b?q=x%2Fy#section";
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as BrowserWindow);
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({
      popup: vi.fn(),
    } as unknown as Electron.Menu);
    setupApplicationMenu({ onNewWindow: vi.fn() });
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
    actions?.[0]?.click?.(null as never, undefined, null as never);
    actions?.[1]?.click?.(null as never, undefined, null as never);
    expect(shell.openExternal).toHaveBeenCalledWith(url);
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
    setupApplicationMenu({ onNewWindow: vi.fn() });
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
