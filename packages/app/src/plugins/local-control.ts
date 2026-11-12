import { Platform } from "react-native";
import type { LocalPluginPatch, LocalPluginSnapshot, LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getRendererPluginProfile } from "./renderer-profile";

type LocalPluginAction = { installationId: string; expectedRevision: number };
export type LocalPluginEnvironment = "native-desktop" | "web-client" | "mobile-client";
export interface LocalPluginControl {
  readonly environment: LocalPluginEnvironment;
  readonly persistence: "desktop-main-profile" | "client-async-storage";
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
/** Intrinsic client management: native main profile or this web/mobile client's own profile. */
export function getLocalPluginControl(): LocalPluginControl {
  const native = getDesktopHost()?.plugins;
  if (native) return {
    environment: "native-desktop", persistence: "desktop-main-profile",
    getSnapshot: () => native.getSnapshot(), patch: (input) => native.patch(input),
    reload: (input) => native.reload(input), remove: (input) => native.remove(input),
    reinstall: (input) => native.reinstall(input), clearData: (input) => native.clearData(input),
    getLogs: (input) => native.getLogs(input),
    subscribe: (listener) => listenToDesktopEvent("desktop-plugins-changed", listener),
  };
  const renderer = getRendererPluginProfile();
  return {
    environment: getLocalPluginEnvironment(), persistence: "client-async-storage",
    getSnapshot: () => renderer.getSnapshot(), patch: (input) => renderer.patch(input),
    reload: (input) => renderer.reload(input), remove: (input) => renderer.remove(input),
    reinstall: (input) => renderer.reinstall(input), clearData: (input) => renderer.clearData(input),
    getLogs: (input) => renderer.getLogs(input),
    subscribe: async (listener) => renderer.subscribe(listener),
  };
}
