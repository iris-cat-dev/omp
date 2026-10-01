import { contextBridge, ipcRenderer, webUtils } from "electron";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103).

type EventHandler = (payload: unknown) => void;

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
  loginShell: process.env.SHELL,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  remoteSsh: {
    start: (input: Record<string, unknown>) => ipcRenderer.invoke("paseo:remote-ssh:start", input),
    writeInput: (input: { operationId: string; input: string }) =>
      ipcRenderer.invoke("paseo:remote-ssh:write-input", input),
    cancel: (input: { operationId: string }) =>
      ipcRenderer.invoke("paseo:remote-ssh:cancel", input),
    getProfile: (serverId: string) =>
      ipcRenderer.invoke("paseo:remote-ssh:profile:get", { serverId }),
    saveProfile: (input: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:remote-ssh:profile:save", input),
    removeProfile: (serverId: string) =>
      ipcRenderer.invoke("paseo:remote-ssh:profile:remove", { serverId }),
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`paseo:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`paseo:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("paseo:window:openNew", options),
    closeChoice: {
      ready: () =>
        ipcRenderer.invoke("paseo:window:closeChoiceReady") as Promise<{
          requestId: number;
        } | null>,
      respond: (response: {
        requestId: number;
        choice: "background" | "quit" | "cancel";
        remember: boolean;
      }) => ipcRenderer.invoke("paseo:window:respondCloseChoice", response) as Promise<boolean>,
    },
    getCurrentWindow: () => ({
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      beginWindowDrag: (point: { screenX: number; screenY: number }) =>
        ipcRenderer.invoke("paseo:window:beginDrag", point),
      moveWindowDrag: (point: { screenX: number; screenY: number }) =>
        ipcRenderer.send("paseo:window:moveDrag", point),
      endWindowDrag: () => ipcRenderer.send("paseo:window:endDrag"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
        trafficLightOffsetY?: number;
      }) => ipcRenderer.invoke("paseo:window:updateWindowControls", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("paseo:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("paseo:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("paseo:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("paseo:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("paseo:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("paseo:opener:openUrl", url),
    openPath: (input: { path: string; workspaceRoot: string }) =>
      ipcRenderer.invoke("paseo:opener:openPath", input),
    revealPath: (input: { path: string; workspaceRoot: string }) =>
      ipcRenderer.invoke("paseo:opener:revealPath", input),
  },
  editor: {
    listTargets: () => ipcRenderer.invoke("paseo:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
    setContextMenuLabels: (labels: Record<string, string>) =>
      ipcRenderer.invoke("paseo:menu:set-context-menu-labels", labels),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("paseo:menu:set-capturing-shortcut", capturing),
  },
});
