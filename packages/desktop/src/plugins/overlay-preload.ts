import { contextBridge, ipcRenderer } from "electron";
const channel = ipcRenderer.invoke("paseo:overlay:bind") as Promise<string>;
const invoke = (action: string, input?: unknown) => channel.then((name) => ipcRenderer.invoke(name, action, input));
contextBridge.exposeInMainWorld("ompOverlay", {
  ready: () => invoke("ready"), open: () => invoke("open"), menu: () => invoke("menu"),
  dragStart: () => invoke("drag-start"), dragEnd: () => invoke("drag-end"),
  interactive: (value: boolean) => { void channel.then((name) => ipcRenderer.send(`${name}:interactive`, value)); },
  reportError: (message: string) => invoke("error", message),
  onState: (listener: (state: unknown) => void) => { const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state); ipcRenderer.on("paseo:overlay:state", handler); return () => ipcRenderer.removeListener("paseo:overlay:state", handler); },
  onPointer: (listener: (point: { x: number; y: number }) => void) => { const handler = (_event: Electron.IpcRendererEvent, point: { x: number; y: number }) => listener(point); ipcRenderer.on("paseo:overlay:pointer", handler); return () => ipcRenderer.removeListener("paseo:overlay:pointer", handler); },
});
