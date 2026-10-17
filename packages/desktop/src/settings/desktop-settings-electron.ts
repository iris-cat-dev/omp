import { app } from "electron";

import { createLaunchAtLoginController } from "./launch-at-login.js";
import {
  createDesktopSettingsStore,
  type DesktopSettings,
  type DesktopSettingsStore,
} from "./desktop-settings.js";
import { wallpaperMediaRegistry } from "../wallpaper/media-registry.js";
import { getMainWindows } from "../window/main-windows.js";

let desktopSettingsStore: DesktopSettingsStore | null = null;
let wallpaperLibrarySubscribed = false;

export function getDesktopSettingsStore(): DesktopSettingsStore {
  desktopSettingsStore ??= createDesktopSettingsStore({
    userDataPath: app.getPath("userData"),
    onWallpaperLibraryCommitted: (library) => wallpaperMediaRegistry.updateLibrary(library),
  });
  if (!wallpaperLibrarySubscribed) {
    wallpaperLibrarySubscribed = true;
    desktopSettingsStore.subscribeWallpaperLibrary((library) => {
      for (const window of getMainWindows()) {
        try {
          window.webContents.send("paseo:event:paseo:wallpaper:libraryChanged", library);
        } catch {
          // A closed or failed renderer cannot turn a committed write into failure.
        }
      }
    });
  }
  return desktopSettingsStore;
}

export function subscribeDesktopSettingsChanges(
  listener: (settings: DesktopSettings) => void,
): () => void {
  return getDesktopSettingsStore().subscribe(listener);
}

export const launchAtLoginController = createLaunchAtLoginController({
  platform: process.platform,
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
});
