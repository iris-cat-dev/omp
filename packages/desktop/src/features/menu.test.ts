import { describe, expect, it, vi } from "vitest";
import {
  buildLinkContextMenuTemplate,
  buildTerminalContextMenuTemplate,
  reloadActiveBrowserOrWindow,
} from "./menu.js";

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
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
  it("offers both opening destinations and copy without changing the URL", () => {
    const callbacks = {
      onOpenInDesktop: vi.fn(),
      onOpenExternal: vi.fn(),
      onCopyAddress: vi.fn(),
    };
    const template = buildLinkContextMenuTemplate(
      {
        kind: "assistant-http-link",
        url: "https://example.com/a%20b?q=x%2Fy#section",
        openInDesktopLabel: "在 OMP Desktop 中打开",
        openExternalLabel: "在浏览器中打开链接",
        copyAddressLabel: "复制链接地址",
      },
      callbacks,
    );

    expect(template.map((item) => item.label)).toEqual([
      "在 OMP Desktop 中打开",
      "在浏览器中打开链接",
      "复制链接地址",
    ]);
    template[0]?.click?.(null as never, undefined, null as never);
    template[1]?.click?.(null as never, undefined, null as never);
    template[2]?.click?.(null as never, undefined, null as never);
    expect(callbacks.onOpenInDesktop).toHaveBeenCalledOnce();
    expect(callbacks.onOpenExternal).toHaveBeenCalledOnce();
    expect(callbacks.onCopyAddress).toHaveBeenCalledOnce();
  });
});
