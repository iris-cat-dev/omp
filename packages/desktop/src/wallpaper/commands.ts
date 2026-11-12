import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";
import {
  WALLPAPER_MEDIA_TYPES,
  WallpaperRequestSchemas,
  type WallpaperCommand,
  type WallpaperCommandData,
  type WallpaperRequest,
  type WallpaperResponse,
} from "@omp-desktop/protocol/desktop-wallpaper";
import type { DesktopSettingsStore } from "../settings/desktop-settings.js";
import {
  mapWallpaperFiles,
  validateLegacyWallpaper,
  validateWallpaperFile,
  wallpaperFailure,
  WallpaperError,
} from "./files.js";
import {
  wallpaperMediaRegistry,
  type WallpaperDocumentOwner,
  type WallpaperMediaRegistry,
} from "./media-registry.js";
import { authorizeLocalPlugin } from "../plugins/local-runtime-electron.js";
import { getCommittedWallpaperDocumentIdentity } from "./media-request-authorization.js";

export interface WallpaperCommandDependencies {
  registry: WallpaperMediaRegistry;
  store: DesktopSettingsStore;
  getMainWindows: () => BrowserWindow[];
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>;
  validateFile?: typeof validateWallpaperFile;
  authorize?: typeof authorizeLocalPlugin;
  beforeAcquire?: (event: IpcMainInvokeEvent, request: WallpaperRequest<"setBackground" | "setPreviews">, owner: WallpaperDocumentOwner, purpose: "background" | "previews") => number;
}

export function registerWallpaperWindow(
  window: BrowserWindow,
  registry = wallpaperMediaRegistry,
): void {
  const contents = window.webContents;
  // Revoke before a replacement document can request resources, even if navigation fails.
  contents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) dispose();
  });
  contents.on("did-frame-navigate", (_event, _url, _status, _text, isMainFrame) => {
    if (!isMainFrame) return;
    const owner = registry.getOwner(contents);
    // Preserve a canonical Request's pending binding; its native commit is the same tuple.
    if (owner?.nativeIdentity) return;
    const identity = getCommittedWallpaperDocumentIdentity(contents);
    if (identity) registry.bindNativeDocument(contents, identity);
    else if (!owner) registry.activateOwner(contents);
  });
  const dispose = () => {
    const owner = registry.getOwner(contents);
    if (owner) registry.disposeOwner(owner);
  };
  contents.on("render-process-gone", dispose);
  contents.once("destroyed", dispose);
  window.once("closed", dispose);
}

type CommandHandlers = {
  [K in WallpaperCommand]: (
    request: WallpaperRequest<K>,
    owner: WallpaperDocumentOwner,
    window: BrowserWindow,
  ) => WallpaperCommandData[K] | Promise<WallpaperCommandData[K]>;
};

export function createWallpaperCommandHandler(dependencies: WallpaperCommandDependencies) {
  const { registry, store } = dependencies;
  const pickers = new WeakSet<WallpaperDocumentOwner>();
  const validateFile = dependencies.validateFile ?? validateWallpaperFile;
  const extensions = Object.entries(WALLPAPER_MEDIA_TYPES);
  const handlers: CommandHandlers = {
    getContext: (_request, owner) => ({ epoch: owner.epoch }),
    getLibrary: () => store.getWallpaperLibrary(),
    importLegacy: async (request) => {
      let file = null;
      let reason: string | null = null;
      try {
        file = await validateLegacyWallpaper(request.directory, request.path);
      } catch (error) {
        reason = wallpaperFailure(error).message;
      }
      return store.importLegacyWallpaper(file, reason);
    },
    addCandidates: async (request, owner, window) => {
      if (pickers.has(owner))
        throw new WallpaperError("busy", "A wallpaper picker is already open for this document.");
      pickers.add(owner);
      try {
        let selection: OpenDialogReturnValue;
        try {
          selection = await dependencies.showOpenDialog(window, {
            title: request.title,
            properties: ["openFile", "multiSelections"],
            filters: [
              { name: request.mediaLabel, extensions: extensions.map(([extension]) => extension) },
              {
                name: request.imageLabel,
                extensions: extensions
                  .filter(([, type]) => type.kind === "image")
                  .map(([extension]) => extension),
              },
              {
                name: request.videoLabel,
                extensions: extensions
                  .filter(([, type]) => type.kind === "video")
                  .map(([extension]) => extension),
              },
            ],
          });
        } catch (error) {
          throw new WallpaperError(
            "dialog-error",
            error instanceof Error ? error.message : "The wallpaper picker could not be opened.",
          );
        }
        if (!registry.isCurrent(owner))
          throw new WallpaperError("stale-document", "The picker document has changed.");
        try {
          (dependencies.authorize ?? authorizeLocalPlugin)({ sender: window.webContents,
            senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent,
            request.installationId, request.generation, "manage", "wallpaper.media", "wallpaper");
        } catch (error) {
          throw new WallpaperError("unauthorized", error instanceof Error ? error.message : "Wallpaper capability was revoked.");
        }
        if (selection.canceled) {
          return {
            library: await store.getWallpaperLibrary(),
            added: [],
            duplicates: [],
            cancelled: true,
            rejected: [],
          };
        }
        // Confirmation accepts a persistent intent. Closing the window after this
        // point must not roll it back or redirect it into a new document's media.
        const checked = await mapWallpaperFiles(selection.filePaths, async (requestedPath) => {
          try {
            return { file: await validateFile(requestedPath), rejected: null };
          } catch (error) {
            const failure = wallpaperFailure(error);
            return {
              file: null,
              rejected: { path: requestedPath, code: failure.code, message: failure.message },
            };
          }
        });
        const files = checked.flatMap((item) => (item.file ? [item.file] : []));
        const result = files.length
          ? await store.addWallpaperCandidates(files)
          : { library: await store.getWallpaperLibrary(), added: [], duplicates: [] };
        return {
          ...result,
          cancelled: false,
          rejected: checked.flatMap((item) => (item.rejected ? [item.rejected] : [])),
        };
      } finally {
        pickers.delete(owner);
      }
    },
    removeCandidates: (request) => store.removeWallpaperCandidates(request.candidateIds),
    setBackground: (request, owner) =>
      registry.setBackground(owner, request.epoch, request.revision, request.candidateId, request),
    setPreviews: (request, owner) =>
      registry.setPreviews(owner, request.epoch, request.revision, request.candidateIds, request),
  };

  return async function handleWallpaperCommand<K extends WallpaperCommand>(
    event: IpcMainInvokeEvent,
    command: K,
    args: unknown,
  ): Promise<WallpaperResponse<K>> {
    const window = dependencies
      .getMainWindows()
      .find((candidate) => candidate.webContents === event.sender);
    if (
      !window ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame.detached ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return {
        ok: false,
        code: "invalid-request",
        message: "Wallpaper commands require a registered main window's main frame.",
      };
    }
    const owner = registry.getOwner(event.sender);
    if (!owner)
      return { ok: false, code: "stale-document", message: "No active wallpaper document." };
    if (owner.nativeIdentity) {
      const committed = getCommittedWallpaperDocumentIdentity(event.sender);
      if (!committed) return { ok: false, code: "unsupported", message: "This runtime does not expose committed native document identity for local wallpaper media." };
      if (committed.contentsId !== owner.nativeIdentity.contentsId || committed.frameId !== owner.nativeIdentity.frameId ||
          committed.navigationToken !== owner.nativeIdentity.navigationToken) {
        return { ok: false, code: "stale-document", message: "The requesting document has not committed the current wallpaper owner." };
      }
    }
    const parsed = WallpaperRequestSchemas[command].safeParse(args);
    if (!parsed.success)
      return { ok: false, code: "invalid-request", message: "Invalid wallpaper request." };
    const request = parsed.data as WallpaperRequest<K>;
    try {
      const purpose = command === "setBackground" &&
        (request as WallpaperRequest<"setBackground">).candidateId !== null ? "background" : "manage";
      (dependencies.authorize ?? authorizeLocalPlugin)(event, request.installationId,
        request.generation, purpose, "wallpaper.media", "wallpaper");
    } catch (error) {
      return { ok: false, code: "unauthorized", message: error instanceof Error ? error.message : "Wallpaper capability was revoked." };
    }
    if ("epoch" in request && request.epoch !== owner.epoch) {
      return { ok: false, code: "stale-document", message: "The document has changed." };
    }
    if ((command === "getContext" || command === "setBackground" || command === "setPreviews") && !owner.nativeIdentity) {
      return { ok: false, code: "unsupported", message: "This runtime does not expose native document identity for local wallpaper media." };
    }
    try {
      if ((command === "setBackground" || command === "setPreviews") && dependencies.beforeAcquire) {
        const mediaRequest = request as WallpaperRequest<"setBackground" | "setPreviews">;
        mediaRequest.revision = dependencies.beforeAcquire(event, mediaRequest, owner, command === "setBackground" ? "background" : "previews");
      }
      return { ok: true, data: await handlers[command](request, owner, window) };
    } catch (error) {
      if (error instanceof WallpaperError)
        return { ok: false, code: error.code, message: error.message };
      return {
        ok: false,
        code: "storage-error",
        message: error instanceof Error ? error.message : "Wallpaper storage is unavailable.",
      };
    }
  };
}
