import { contextBridge, ipcRenderer } from "electron";
const channel = ipcRenderer.invoke("omp:overlay:bind") as Promise<string>;
const invoke = (action: string, input?: unknown) => channel.then((name) => ipcRenderer.invoke(name, action, input));
contextBridge.exposeInMainWorld("ompOverlay", {
  ready: () => invoke("ready"), open: () => invoke("open"), menu: () => invoke("menu"),
  dragStart: () => invoke("drag-start"), dragEnd: () => invoke("drag-end"),
  interactive: (value: boolean) => { void channel.then((name) => ipcRenderer.send(`${name}:interactive`, value)); },
  reportError: (message: string) => invoke("error", message),
  onState: (listener: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state); ipcRenderer.on("omp:overlay:state", handler); return () => ipcRenderer.removeListener("omp:overlay:state", handler); },
  onPointer: (listener: (point: { x: number; y: number }) => void) => { const handler = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }) => listener(point); ipcRenderer.on("omp:overlay:pointer", handler); return () => ipcRenderer.removeListener("omp:overlay:pointer", handler); },
});
