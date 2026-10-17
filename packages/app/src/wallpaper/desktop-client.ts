import { useEffect, useSyncExternalStore } from "react";
import type {
  WallpaperAddResult,
  WallpaperCommand,
  WallpaperCommandData,
  WallpaperErrorCode,
  WallpaperLegacyResult,
  WallpaperMediaDescriptor,
  WallpaperPreviewFailure,
  WallpaperRemoveResult,
  WallpaperRequest,
  WallpaperResponse,
} from "@omp-desktop/protocol/desktop-wallpaper";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { wallpaperLibraryState } from "./library-state";

export class WallpaperClientError extends Error {
  constructor(
    readonly code: WallpaperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WallpaperClientError";
  }
}

async function invoke<K extends WallpaperCommand>(
  command: K,
  input: WallpaperRequest<K>,
): Promise<WallpaperCommandData[K]> {
  const host = getDesktopHost();
  if (!isElectronRuntime() || !host?.invoke) {
    throw new WallpaperClientError("unavailable", "Desktop wallpaper API is unavailable.");
  }
  const response = (await host.invoke(`paseo:wallpaper:${command}`, input)) as WallpaperResponse<K>;
  if (!response.ok) throw new WallpaperClientError(response.code, response.message);
  return response.data;
}

// These belong to the document, not to a mounted settings page or StrictMode effect.
let context: Promise<{ epoch: string }> | null = null;
let backgroundRevision = 0;
let previewsRevision = 0;
let subscription: Promise<void> | null = null;
let reloadInFlight: Promise<void> | null = null;
let adding = false;
let removing = false;

function getContext(): Promise<{ epoch: string }> {
  if (!context) {
    const request = invoke("getContext", {});
    context = request;
    void request.catch(() => {
      if (context === request) context = null;
    });
  }
  return context;
}

function subscribeLibrary(): Promise<void> {
  if (!subscription) {
    subscription = listenToDesktopEvent("paseo:wallpaper:libraryChanged", (raw: unknown) => {
      try {
        wallpaperLibraryState.accept(raw);
      } catch (error) {
        wallpaperLibraryState.fail(error);
      }
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        subscription = null;
        throw error;
      });
  }
  return subscription;
}

export function reloadWallpaperLibrary(): Promise<void> {
  if (reloadInFlight) return reloadInFlight;
  const request = (async () => {
    try {
      // Subscribe before get so a newer committed event cannot fall through the gap.
      await subscribeLibrary();
      const { epoch } = await getContext();
      wallpaperLibraryState.accept(await invoke("getLibrary", { epoch }));
    } catch (error) {
      wallpaperLibraryState.fail(error);
      throw error;
    }
  })();
  reloadInFlight = request;
  void request
    .finally(() => {
      if (reloadInFlight === request) reloadInFlight = null;
    })
    .catch(() => {});
  return request;
}

export function useWallpaperLibrary() {
  const state = useSyncExternalStore(
    wallpaperLibraryState.subscribe,
    wallpaperLibraryState.getSnapshot,
    wallpaperLibraryState.getSnapshot,
  );
  useEffect(() => {
    if (isElectronRuntime()) void reloadWallpaperLibrary().catch(() => {});
  }, []);
  return { ...state, reload: reloadWallpaperLibrary };
}

async function reconcileLostReply(error: unknown): Promise<never> {
  // A rejected transport may have lost a committed reply. Re-read, never rollback or re-open.
  try {
    await reloadWallpaperLibrary();
  } catch {
    // Preserve the original operation error; the library state separately exposes read failure.
  }
  throw error;
}

export async function addWallpaperCandidates(labels: {
  title: string;
  mediaLabel: string;
  imageLabel: string;
  videoLabel: string;
}): Promise<WallpaperAddResult> {
  if (adding) throw new WallpaperClientError("busy", "A wallpaper picker is already open.");
  adding = true;
  try {
    const { epoch } = await getContext();
    const result = await invoke("addCandidates", { epoch, ...labels });
    wallpaperLibraryState.accept(result.library);
    return result;
  } catch (error) {
    return reconcileLostReply(error);
  } finally {
    adding = false;
  }
}

export async function removeWallpaperCandidates(
  candidateIds: readonly string[],
): Promise<WallpaperRemoveResult> {
  if (removing) throw new WallpaperClientError("busy", "A wallpaper removal is already pending.");
  removing = true;
  try {
    const { epoch } = await getContext();
    const result = await invoke("removeCandidates", { epoch, candidateIds: [...candidateIds] });
    wallpaperLibraryState.accept(result.library);
    return result;
  } catch (error) {
    return reconcileLostReply(error);
  } finally {
    removing = false;
  }
}

export async function importLegacyWallpaper(input: {
  directory: string | null;
  path: string | null;
}): Promise<WallpaperLegacyResult> {
  try {
    const { epoch } = await getContext();
    const result = await invoke("importLegacy", { epoch, ...input });
    wallpaperLibraryState.accept(result.library);
    return result;
  } catch (error) {
    return reconcileLostReply(error);
  }
}

export function acquireWallpaperBackground(candidateId: string) {
  const revision = ++backgroundRevision;
  const result: Promise<WallpaperMediaDescriptor | null> = (async () => {
    const { epoch } = await getContext();
    if (revision !== backgroundRevision)
      throw new WallpaperClientError("superseded", "Background was replaced.");
    const response = await invoke("setBackground", { epoch, revision, candidateId });
    if (revision !== backgroundRevision)
      throw new WallpaperClientError("superseded", "Background was replaced.");
    return response.media;
  })();
  return {
    result,
    release() {
      if (revision !== backgroundRevision) return;
      const clearRevision = ++backgroundRevision;
      void getContext()
        .then(({ epoch }) => {
          if (clearRevision !== backgroundRevision) return;
          return invoke("setBackground", { epoch, revision: clearRevision, candidateId: null });
        })
        .catch(() => {});
    },
  };
}

export function acquireWallpaperPreviews(candidateIds: readonly string[]): {
  result: Promise<{ media: WallpaperMediaDescriptor[]; rejected: WallpaperPreviewFailure[] }>;
  release: () => void;
} {
  const revision = ++previewsRevision;
  const ids = [...candidateIds];
  const result = (async () => {
    const { epoch } = await getContext();
    if (revision !== previewsRevision)
      throw new WallpaperClientError("superseded", "Previews were replaced.");
    const response = await invoke("setPreviews", { epoch, revision, candidateIds: ids });
    if (revision !== previewsRevision)
      throw new WallpaperClientError("superseded", "Previews were replaced.");
    return response;
  })();
  return {
    result,
    release() {
      if (revision !== previewsRevision) return;
      const clearRevision = ++previewsRevision;
      void getContext()
        .then(({ epoch }) => {
          if (clearRevision !== previewsRevision) return;
          return invoke("setPreviews", { epoch, revision: clearRevision, candidateIds: [] });
        })
        .catch(() => {});
    },
  };
}
