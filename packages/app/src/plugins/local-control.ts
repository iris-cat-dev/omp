import { Platform } from "react-native";
import type { LocalPluginPatch, LocalPluginSnapshot, LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";

type LocalPluginAction = { installationId: string; expectedRevision: number };
export type LocalPluginEnvironment = "native-desktop" | "web-client" | "mobile-client";
export interface LocalPluginControl {
  readonly environment: LocalPluginEnvironment;
  readonly persistence: "desktop-main-profile";
  getSnapshot(): Promise<LocalPluginSnapshot>;
  patch(input: LocalPluginPatch): Promise<LocalPluginSnapshot>;
  reload(input: LocalPluginAction): Promise<LocalPluginSnapshot>;
  remove(input: LocalPluginAction): Promise<LocalPluginSnapshot>;
  reinstall(input: LocalPluginAction): Promise<LocalPluginSnapshot>;
  clearData(input: LocalPluginAction): Promise<LocalPluginSnapshot>;
  getLogs(input: { installationId: string }): Promise<LocalPluginLogEntry[]>;
  subscribe(listener: () => void): Promise<() => void>;
}
export function getLocalPluginEnvironment(): LocalPluginEnvironment {
  return getDesktopHost()?.plugins ? "native-desktop" : Platform.OS === "web" ? "web-client" : "mobile-client";
}
/** Local plugin management requires the native Desktop profile. */
export function getLocalPluginControl(): LocalPluginControl {
  const native = getDesktopHost()?.plugins;
  if (!native) throw new Error("Local plugins require the native Desktop host.");
  return {
    environment: "native-desktop", persistence: "desktop-main-profile",
    getSnapshot: () => native.getSnapshot(), patch: (input) => native.patch(input),
    reload: (input) => native.reload(input), remove: (input) => native.remove(input),
    reinstall: (input) => native.reinstall(input), clearData: (input) => native.clearData(input),
    getLogs: (input) => native.getLogs(input),
    subscribe: (listener) => listenToDesktopEvent("desktop-plugins-changed", listener),
  };
}
