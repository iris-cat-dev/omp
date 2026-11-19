import { app, ipcMain } from "electron";
import {
  PluginClientTrustRequestSchema,
  type PluginClientTrustInstallation,
} from "@omp-desktop/protocol/plugin-client-trust";
import { getMainWindows, isMainWindowSender } from "../window/main-windows.js";
import { createPluginClientTrustStore } from "./client-trust-store.js";

export function registerPluginClientTrustIpc(appUrl: string): void {
  const allowed = new URL(appUrl);
  const access = createPluginClientTrustStore(app.getPath("userData"));
  function isAppDocument(url: string): boolean {
    // Node's URL.origin is null for the packaged custom scheme.
    const document = URL.parse(url);
    return document !== null && document.protocol === allowed.protocol && document.host === allowed.host;
  }

  ipcMain.handle("omp:plugin-client-trust", async (event, input: unknown) => {
    const frame = event.senderFrame;
    if (!isMainWindowSender(event.sender) || !frame || frame.detached ||
        frame !== event.sender.mainFrame || !isAppDocument(frame.url)) {
      throw new Error("Plugin client trust requires the main application document.");
    }
    const request = PluginClientTrustRequestSchema.parse(input);
    const result = await access(request);
    const { action, hostId, installationId } = request.operation;
    if (result !== null && action !== "check") {
      const change: PluginClientTrustInstallation = { hostId, installationId };
      for (const { webContents } of getMainWindows()) {
        if (isAppDocument(webContents.mainFrame.url)) {
          webContents.send("omp:plugin-client-trust-changed", change);
        }
      }
    }
    return result;
  });
}
