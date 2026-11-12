import { getMainWindows } from "../window/main-windows.js";
import { wallpaperMediaRegistry } from "./media-registry.js";
import { createWallpaperMediaResponse } from "./media-response.js";
import {
  bindWallpaperProtocolDocument,
  getCommittedWallpaperDocumentIdentity,
  getNativeProtocolRequestIdentity,
  getWallpaperMediaRequestOwner,
} from "./media-request-authorization.js";

/** Shared by the application protocol and its real native GUI acceptance entry. */
export async function handleWallpaperProtocolRequest(
  request: Request,
  url: URL,
  devOrigin: string | null,
): Promise<Response | null> {
  const nativeIdentity = getNativeProtocolRequestIdentity(request);
  if (decodeURIComponent(url.pathname) === "/wallpaper-media") {
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    if (!nativeIdentity) return new Response("Native document identity is unavailable for local wallpaper media", { status: 501, headers: { "cache-control": "no-store" } });
    const windows = getMainWindows();
    const requestingWindow = windows.find(window => window.webContents.id === nativeIdentity.contentsId);
    if (requestingWindow && !getCommittedWallpaperDocumentIdentity(requestingWindow.webContents)) {
      return new Response("Committed native document identity is unavailable for local wallpaper media", { status: 501, headers: { "cache-control": "no-store" } });
    }
    return createWallpaperMediaResponse(
      request,
      wallpaperMediaRegistry,
      getWallpaperMediaRequestOwner(nativeIdentity, wallpaperMediaRegistry, windows),
      devOrigin,
    );
  }
  if (url.hostname === "app" && nativeIdentity?.isDocument &&
      !bindWallpaperProtocolDocument(nativeIdentity, wallpaperMediaRegistry, getMainWindows())) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}
