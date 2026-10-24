import { contextBridge, ipcRenderer } from "electron";
import type { OmpMonitorScope } from "./types.js";
import type {
  OmpMonitorConfigure,
  OmpMonitorExportRange,
  OmpMonitorExportResult,
  OmpMonitorSurface,
  OmpMonitorViewState,
} from "./view-types.js";

// The sandbox imports no runtime module except Electron and exposes no arbitrary IPC.
contextBridge.exposeInMainWorld("ompMonitor", {
  ready: (): Promise<OmpMonitorViewState> => ipcRenderer.invoke("paseo:monitor:ready"),
  refresh: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:refresh"),
  openSurface: (surface: Exclude<OmpMonitorSurface, "orb">): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:surface", surface),
  configure: (patch: OmpMonitorConfigure): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:configure", patch),
  selectOrb: (instanceId: string): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:select-orb", instanceId),
  setOrbVisible: (visible: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:orb-visible", visible),
  setScope: (scope: OmpMonitorScope): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:scope", scope),
  newWindow: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:new-window"),
  beginDrag: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:drag-start"),
  endDrag: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:drag-end"),
  showMenu: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:menu"),
  setInteractive: (interactive: boolean): void =>
    ipcRenderer.send("paseo:monitor:interactive", interactive),
  exportCsv: (range?: OmpMonitorExportRange): Promise<OmpMonitorExportResult> => {
    if (range === undefined) return ipcRenderer.invoke("paseo:monitor:export-csv");
    return ipcRenderer.invoke("paseo:monitor:export-csv", range);
  },
  setNetworkEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:network-enabled", enabled),
  setCurrency: (currency: string): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:currency", currency),
  refreshPublicData: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:refresh-public-data"),
  close: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:close"),
  closeAll: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:close-all"),
  onDragCancelled: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("paseo:monitor:drag-cancelled", handler);
    return () => ipcRenderer.removeListener("paseo:monitor:drag-cancelled", handler);
  },
  onState: (listener: (state: OmpMonitorViewState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OmpMonitorViewState) =>
      listener(state);
    ipcRenderer.on("paseo:monitor:state", handler);
    return () => ipcRenderer.removeListener("paseo:monitor:state", handler);
  },
  onPointer: (listener: (point: { x: number; y: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }) =>
      listener(point);
    ipcRenderer.on("paseo:monitor:pointer", handler);
    return () => ipcRenderer.removeListener("paseo:monitor:pointer", handler);
  },
});
