import { createContext, useContext, useSyncExternalStore } from "react";
import type { WallpaperController } from "./controller.js";
import type { PluginClientContext } from "@omp-desktop/plugin";
interface WallpaperViewContext { controller: WallpaperController; client: PluginClientContext }
export const WallpaperControllerContext = createContext<WallpaperViewContext | null>(null);
export function useWallpaperViewContext(): WallpaperViewContext {
  const context = useContext(WallpaperControllerContext);
  if (!context) throw new Error("Wallpaper settings require an installation context.");
  return context;
}
export function useWallpaperController(): WallpaperController {
  return useWallpaperViewContext().controller;
}
export function useWallpaperSnapshot() {
  const controller = useWallpaperController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
