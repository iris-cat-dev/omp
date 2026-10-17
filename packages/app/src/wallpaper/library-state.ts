import {
  WallpaperLibrarySchema,
  type WallpaperLibrary,
} from "@omp-desktop/protocol/desktop-wallpaper";

export interface WallpaperLibraryState {
  library: WallpaperLibrary | null;
  loading: boolean;
  error: string | null;
}

export function createWallpaperLibraryState() {
  let state: WallpaperLibraryState = { library: null, loading: true, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: WallpaperLibraryState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    accept(raw: unknown): WallpaperLibrary {
      const library = WallpaperLibrarySchema.parse(raw);
      if (state.library === null || library.revision > state.library.revision) {
        publish({ library, loading: false, error: null });
      } else if (state.loading || state.error) {
        publish({ ...state, loading: false, error: null });
      }
      return state.library!;
    },
    fail(error: unknown) {
      publish({
        ...state,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

export const wallpaperLibraryState = createWallpaperLibraryState();
