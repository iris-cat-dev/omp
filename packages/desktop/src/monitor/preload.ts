import { contextBridge, ipcRenderer } from "electron";
import type { OmpMonitorScope } from "./types.js";
import type { OmpMonitorBoardPreferences } from "./board-types.js";
import type { OmpTitleThemeCommand, OmpTitleThemeResult } from "./title-themes.js";
import type {
  OmpMonitorPerfCardRequest,
  OmpMonitorPerfCardSize,
  OmpMonitorPerfCardState,
} from "./perf-card-types.js";
import type {
  OmpMonitorConfigure,
  OmpMonitorChooseSourceResult,
  OmpMonitorExportRange,
  OmpMonitorExportResult,
  OmpMonitorModeExportRange,
  OmpMonitorOrbCommand,
  OmpMonitorSurface,
  OmpMonitorViewState,
} from "./view-types.js";

// The sandbox imports no runtime module except Electron and exposes no arbitrary IPC.
contextBridge.exposeInMainWorld("ompMonitor", {
  ready: (): Promise<OmpMonitorViewState> => ipcRenderer.invoke("paseo:monitor:ready"),
  refresh: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:refresh"),
  resizeDashboard: (height: number): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:dashboard-size", height),
  showPerfCard: (request: OmpMonitorPerfCardRequest | null): void =>
    ipcRenderer.send("paseo:monitor:perf-card", request),
  readyPerfCard: (): Promise<OmpMonitorPerfCardState> =>
    ipcRenderer.invoke("paseo:monitor:perf-card-ready"),
  resizePerfCard: (size: OmpMonitorPerfCardSize): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:perf-card-size", size),
  openSurface: (surface: Exclude<OmpMonitorSurface, "orb" | "board">): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:surface", surface),
  configure: (patch: OmpMonitorConfigure): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:configure", patch),
  selectOrb: (instanceId: string): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:select-orb", instanceId),
  setOrbVisible: (visible: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:orb-visible", visible),
  commandOrb: (command: OmpMonitorOrbCommand): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:orb-command", command),
  commandTitleTheme: (command: OmpTitleThemeCommand): Promise<OmpTitleThemeResult> =>
    ipcRenderer.invoke("paseo:monitor:title-theme", command),
  setLaunchAtLogin: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:launch-at-login", enabled),
  refreshLaunchAtLogin: (): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:refresh-launch-at-login"),
  setSourceEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:source-enabled", enabled),
  chooseSourceFolder: (): Promise<OmpMonitorChooseSourceResult> =>
    ipcRenderer.invoke("paseo:monitor:source-folder"),
  resetSourceFolder: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:source-folder-reset"),
  startEffectsPreview: (): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:effects-preview-start"),
  stopEffectsPreview: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:effects-preview-stop"),
  setScope: (scope: OmpMonitorScope): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:scope", scope),
  newWindow: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:new-window"),
  newBoard: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:new-board"),
  configureBoard: (
    id: string,
    patch: Partial<OmpMonitorBoardPreferences> & { visible?: boolean; orbId?: string },
  ): Promise<void> => ipcRenderer.invoke("paseo:monitor:configure-board", { id, patch }),
  removeBoard: (id: string): Promise<void> => ipcRenderer.invoke("paseo:monitor:remove-board", id),
  selectBoard: (id: string): Promise<void> => ipcRenderer.invoke("paseo:monitor:select-board", id),
  beginDrag: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:drag-start"),
  endDrag: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:drag-end"),
  showMenu: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:menu"),
  setInteractive: (interactive: boolean): void =>
    ipcRenderer.send("paseo:monitor:interactive", interactive),
  exportCsv: (range?: OmpMonitorExportRange): Promise<OmpMonitorExportResult> => {
    if (range === undefined) return ipcRenderer.invoke("paseo:monitor:export-csv");
    return ipcRenderer.invoke("paseo:monitor:export-csv", range);
  },
  exportModeCsv: (range: OmpMonitorModeExportRange): Promise<OmpMonitorExportResult> =>
    ipcRenderer.invoke("paseo:monitor:export-mode-csv", range),
  setNetworkEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:network-enabled", enabled),
  setAutoSyncPrices: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("paseo:monitor:auto-sync-prices", enabled),
  checkPrices: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:check-prices"),
  refreshRates: (): Promise<void> => ipcRenderer.invoke("paseo:monitor:refresh-rates"),
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
  onPerfCardState: (listener: (state: OmpMonitorPerfCardState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OmpMonitorPerfCardState) =>
      listener(state);
    ipcRenderer.on("paseo:monitor:perf-card-state", handler);
    return () => ipcRenderer.removeListener("paseo:monitor:perf-card-state", handler);
  },
  onPointer: (listener: (point: { x: number; y: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }) =>
      listener(point);
    ipcRenderer.on("paseo:monitor:pointer", handler);
    return () => ipcRenderer.removeListener("paseo:monitor:pointer", handler);
  },
});
