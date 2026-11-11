import type { BrowserWindow, WebContents } from "electron";
import type { NativeProtocolRequestIdentity, WallpaperDocumentOwner, WallpaperMediaRegistry } from "./media-registry.js";

// mini-electron supplies this readonly, frozen identity on canonical protocol.handle Requests.
// Headers, URLs, referrers and renderer payloads are never identity sources.
export function getNativeProtocolRequestIdentity(request: Request): NativeProtocolRequestIdentity | null {
  const identity = (request as Request & { readonly nativeRequest?: NativeProtocolRequestIdentity }).nativeRequest;
  if (!identity || !Number.isSafeInteger(identity.contentsId) || identity.contentsId <= 0 ||
      typeof identity.frameId !== "string" || !identity.frameId || identity.frameId === "0" ||
      typeof identity.navigationToken !== "string" || !identity.navigationToken ||
      typeof identity.isMainFrame !== "boolean" || typeof identity.isDocument !== "boolean") return null;
  return identity;
}

/** The frame descriptor exposes the committed document, including HTTP development pages. */
export function getCommittedWallpaperDocumentIdentity(contents: WebContents): NativeProtocolRequestIdentity | null {
  if (contents.isDestroyed() || !Number.isSafeInteger(contents.id) || contents.id <= 0) return null;
  const frame = contents.mainFrame as typeof contents.mainFrame & { readonly nativeID?: string; readonly navigationToken?: string | null };
  if (!frame || frame.detached ||
      typeof frame.nativeID !== "string" || !frame.nativeID || frame.nativeID === "0" ||
      typeof frame.navigationToken !== "string" || !frame.navigationToken) return null;
  return { contentsId: contents.id, frameId: frame.nativeID, isMainFrame: true, isDocument: true,
    navigationToken: frame.navigationToken };
}

function requestingContents(identity: NativeProtocolRequestIdentity, windows: readonly BrowserWindow[]) {
  const contents = windows.find(window => window.webContents.id === identity.contentsId)?.webContents;
  if (!contents || contents.isDestroyed()) return null;
  const frame = contents.mainFrame;
  if (!frame || frame.detached) return null;
  // nativeID is a 64-bit identifier exposed as a string, never an Electron routingId.
  const nativeID = (frame as typeof frame & { readonly nativeID?: string }).nativeID;
  if (nativeID !== identity.frameId) return null;
  return contents;
}

/** Called for the real application's main-document Request, before its body is returned. */
export function bindWallpaperProtocolDocument(
  identity: NativeProtocolRequestIdentity | null,
  registry: WallpaperMediaRegistry,
  windows: readonly BrowserWindow[],
): WallpaperDocumentOwner | null {
  if (!identity?.isMainFrame || !identity.isDocument) return null;
  const contents = requestingContents(identity, windows);
  return contents ? registry.bindNativeDocument(contents, identity) : null;
}

/** Resolve the current native document lease, not permission remembered for a URL. */
export function getWallpaperMediaRequestOwner(
  identity: NativeProtocolRequestIdentity | null,
  registry: WallpaperMediaRegistry,
  windows: readonly BrowserWindow[],
): WallpaperDocumentOwner | null {
  if (!identity?.isMainFrame || identity.isDocument) return null;
  const contents = requestingContents(identity, windows);
  if (!contents) return null;
  const owner = registry.getOwner(contents);
  const native = owner?.nativeIdentity;
  const committed = getCommittedWallpaperDocumentIdentity(contents);
  if (!owner || !native || !committed || !registry.isCurrent(owner) || !native.isMainFrame || !native.isDocument ||
      native.contentsId !== identity.contentsId || native.frameId !== identity.frameId ||
      native.navigationToken !== identity.navigationToken || committed.navigationToken !== native.navigationToken ||
      committed.frameId !== native.frameId) return null;
  return owner;
}
