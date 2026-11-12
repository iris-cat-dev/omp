import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LocalPluginPatch, LocalPluginSnapshot, LocalPluginDirectoryInstall, LocalPluginDirectoryInspection, LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
import type { VisualFeedbackImage } from "@omp-desktop/protocol/visual-feedback";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103).

type EventHandler = (payload: unknown) => void;
let pluginDocumentBinding: Promise<{ documentEpoch: number }> | undefined;
const bindPluginDocument = () => pluginDocumentBinding ??= ipcRenderer.invoke("omp:plugins:bind");

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
  plugins: {
    startupReady: () => ipcRenderer.invoke("omp:plugins:startup-ready") as Promise<void>,
    getSnapshot: () => ipcRenderer.invoke("omp:plugins:get") as Promise<LocalPluginSnapshot>,
    patch: (input: LocalPluginPatch) => ipcRenderer.invoke("omp:plugins:patch", input) as Promise<LocalPluginSnapshot>,
    selectBackground: (input: { provider: { installationId: string; extensionId: string } | null; expectedRevision: number }) => ipcRenderer.invoke("omp:plugins:selectBackground", input) as Promise<LocalPluginSnapshot>,
    reload: (input: { installationId: string; expectedRevision: number }) => ipcRenderer.invoke("omp:plugins:reload", input) as Promise<LocalPluginSnapshot>,
    remove: (input: { installationId: string; expectedRevision: number }) => ipcRenderer.invoke("omp:plugins:remove", input) as Promise<LocalPluginSnapshot>,
    reinstall: (input: { installationId: string; expectedRevision: number }) => ipcRenderer.invoke("omp:plugins:reinstall", input) as Promise<LocalPluginSnapshot>,
    clearData: (input: { installationId: string; expectedRevision: number }) => ipcRenderer.invoke("omp:plugins:clearData", input) as Promise<LocalPluginSnapshot>,
    inspectDirectory: (input: { directory: string }) => ipcRenderer.invoke("omp:plugins:inspectDirectory", input) as Promise<LocalPluginDirectoryInspection>,
    installDirectory: (input: LocalPluginDirectoryInstall) => ipcRenderer.invoke("omp:plugins:installDirectory", {
      directory: input.directory,
      expectedRevision: input.expectedRevision,
      // mini-electron's context bridge transports explicit undefined values as null.
      // Omit absent optional properties before the request reaches the strict IPC schema.
      ...(input.installationId == null ? {} : { installationId: input.installationId }),
      ...(input.approval == null ? {} : { approval: input.approval }),
    }) as Promise<LocalPluginSnapshot>,
    getLogs: (input: { installationId: string }) => ipcRenderer.invoke("omp:plugins:getLogs", input) as Promise<LocalPluginLogEntry[]>,
    publish: async (input: { installationId: string; generation: number; clientActivationId: string; method: string; input?: unknown }) => {
      const { documentEpoch } = await bindPluginDocument();
      return ipcRenderer.invoke("omp:plugins:invoke", { ...input, documentEpoch });
    },
    openClientScope: async (input: { installationId: string; generation: number; clientActivationId: string; mode: "manage" | "active" }) => {
      const { documentEpoch } = await bindPluginDocument();
      await ipcRenderer.invoke("omp:plugins:openClientScope", { ...input, documentEpoch });
    },
    releaseClientScope: async (input: { installationId: string; generation: number; clientActivationId: string }) => {
      const { documentEpoch } = await bindPluginDocument();
      await ipcRenderer.invoke("omp:plugins:releaseClientScope", { ...input, documentEpoch });
    },
  },
  monitor: {
    open: () => ipcRenderer.invoke("paseo:monitor:open") as Promise<void>,
  },
  screenshot:
    process.platform === "darwin" || process.platform === "win32"
      ? {
          capture: () =>
            ipcRenderer.invoke("paseo:screenshot:capture") as Promise<VisualFeedbackImage | null>,
        }
      : undefined,
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
    contentReady: () => ipcRenderer.invoke("paseo:window:content-ready") as Promise<void>,
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
    openSettings: () => ipcRenderer.invoke("paseo:notification:openSettings"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    listBrowsers: () =>
      ipcRenderer.invoke("paseo:opener:listBrowsers") as Promise<
        Array<{ id: string; label: string; available: boolean }>
      >,
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
