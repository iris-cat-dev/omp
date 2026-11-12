import { app } from "electron";

import { createLaunchAtLoginController } from "./launch-at-login.js";
import {
  createDesktopSettingsStore,
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
    desktopSettingsStore.subscribe((settings) => {
      for (const window of getMainWindows()) {
        try { if (!window.webContents.isDestroyed()) window.webContents.send("paseo:event:desktop-settings-changed", settings); }
        catch { /* A closed renderer cannot block committed settings broadcasts. */ }
      }
    });
    desktopSettingsStore.subscribeWallpaperLibrary((library) => {
      for (const window of getMainWindows()) {
        try {
          window.webContents.send("paseo:event:omp:wallpaper:libraryChanged", library);
        } catch {
          // A closed or failed renderer cannot turn a committed write into failure.
        }
      }
    });
  }
  return desktopSettingsStore;
}


export const launchAtLoginController = createLaunchAtLoginController({
  platform: process.platform,
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
});
