import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPluginClientTrustIpc } from "./client-trust-ipc.js";

const host = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  windows: [] as BrowserWindow[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => host.userData },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      host.handlers.set(channel, handler);
    },
  },
}));

vi.mock("../window/main-windows.js", () => ({
  getMainWindows: () => host.windows,
  isMainWindowSender: (sender: WebContents) =>
    !sender.isDestroyed() && host.windows.some((window) => window.webContents === sender),
}));

interface MockFrame {
  url: string;
  detached: boolean;
  send: ReturnType<typeof vi.fn>;
}

function createWindow(frame: MockFrame | null): {
  window: BrowserWindow;
  webContents: WebContents;
  frame: MockFrame | null;
  webContentsSend: ReturnType<typeof vi.fn>;
} {
  const webContentsSend = vi.fn();
  const webContents = {
    mainFrame: frame as unknown as WebFrameMain,
    isDestroyed: () => false,
    send: webContentsSend,
  } as unknown as WebContents;
  const window = { webContents } as unknown as BrowserWindow;
  host.windows.push(window);
  return { window, webContents, frame, webContentsSend };
}

const approveOperation = {
  action: "approve" as const,
  hostId: "host-1",
  installationId: "qqbot",
  packageId: "qqbot",
  sourcePath: "/plugins/qqbot",
  capabilities: ["agents.create"],
};

describe("plugin client trust IPC", () => {
  beforeEach(async () => {
    host.userData = await mkdtemp(path.join(tmpdir(), "omp-client-trust-ipc-"));
    host.handlers.clear();
    host.windows.length = 0;
  });

  afterEach(async () => {
    await rm(host.userData, { recursive: true, force: true });
  });

  it("broadcasts committed trust changes to ready app windows even when another main window is unloaded, detached, foreign, or fails to send", async () => {
    registerPluginClientTrustIpc("omp-desktop://app/");
    const handler = host.handlers.get("omp:plugin-client-trust")!;

    const caller = createWindow({ url: "omp-desktop://app/settings", detached: false, send: vi.fn() });
    createWindow(null);
    const detached = createWindow({ url: "omp-desktop://app/", detached: true, send: vi.fn() });
    const foreign = createWindow({ url: "https://example.com/", detached: false, send: vi.fn() });
    const failing = createWindow({
      url: "omp-desktop://app/",
      detached: false,
      send: vi.fn(() => {
        throw new Error("Render frame is detached");
      }),
    });
    failing.webContentsSend.mockImplementation(() => {
      throw new Error("WebContents destroyed");
    });
    const peer = createWindow({ url: "omp-desktop://app/workspace", detached: false, send: vi.fn() });

    const event = {
      sender: caller.webContents,
      senderFrame: caller.frame as unknown as WebFrameMain,
    } as IpcMainInvokeEvent;

    await expect(handler(event, { operation: approveOperation, initial: {} })).resolves.toBe(true);

    const expectedChange = { hostId: "host-1", installationId: "qqbot" };
    expect(caller.frame!.send).toHaveBeenCalledWith("omp:plugin-client-trust-changed", expectedChange);
    expect(peer.frame!.send).toHaveBeenCalledWith("omp:plugin-client-trust-changed", expectedChange);
    expect(detached.frame!.send).not.toHaveBeenCalled();
    expect(detached.webContentsSend).not.toHaveBeenCalled();
    expect(foreign.frame!.send).not.toHaveBeenCalled();
    expect(foreign.webContentsSend).not.toHaveBeenCalled();
  });

  it("rejects non-app or detached senders and does not broadcast read-only checks", async () => {
    registerPluginClientTrustIpc("omp-desktop://app/");
    const handler = host.handlers.get("omp:plugin-client-trust")!;

    const appWindow = createWindow({ url: "omp-desktop://app/", detached: false, send: vi.fn() });
    const foreignWindow = createWindow({ url: "https://example.com/", detached: false, send: vi.fn() });

    await expect(
      handler(
        {
          sender: foreignWindow.webContents,
          senderFrame: foreignWindow.frame as unknown as WebFrameMain,
        } as IpcMainInvokeEvent,
        { operation: { ...approveOperation, action: "check" } },
      ),
    ).rejects.toThrow("Plugin client trust requires the main application document.");

    await expect(
      handler(
        {
          sender: appWindow.webContents,
          senderFrame: appWindow.frame as unknown as WebFrameMain,
        } as IpcMainInvokeEvent,
        { operation: { ...approveOperation, action: "check" }, initial: {} },
      ),
    ).resolves.toBe(false);
    expect(appWindow.frame!.send).not.toHaveBeenCalled();
    expect(appWindow.webContentsSend).not.toHaveBeenCalled();
  });
});
