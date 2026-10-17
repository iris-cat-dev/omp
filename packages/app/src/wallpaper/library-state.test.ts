import { describe, expect, it } from "vitest";
import { createWallpaperLibraryState } from "./library-state";
import type { WallpaperLibrary } from "@omp-desktop/protocol/desktop-wallpaper";

const candidate = {
  candidateId: "0199ef80-5ff5-7000-8000-000000000001",
  directory: "C:/wallpapers",
  path: "C:/wallpapers/a.png",
  name: "a.png",
  kind: "image" as const,
};

describe("wallpaper authoritative library state", () => {
  it("does not resurrect removed items when an older get or mutation finishes after an event", () => {
    const state = createWallpaperLibraryState();
    const before: WallpaperLibrary = { version: 1, revision: 4, items: [candidate] };
    state.accept({ version: 1, revision: 5, items: [] });
    state.accept(before);
    state.accept({ ...before, revision: 5 });
    expect(state.getSnapshot().library?.items).toEqual([]);
    expect(state.getSnapshot().library?.revision).toBe(5);
  });

  it("recovers a missed event by re-reading without accepting a stale snapshot", () => {
    const state = createWallpaperLibraryState();
    state.accept({ version: 1, revision: 1, items: [candidate] });
    state.fail(new Error("reply lost"));
    expect(state.getSnapshot().error).toBe("reply lost");
    state.accept({ version: 1, revision: 3, items: [] });
    expect(state.getSnapshot()).toEqual({
      library: { version: 1, revision: 3, items: [] },
      loading: false,
      error: null,
    });
    state.accept({ version: 1, revision: 2, items: [candidate] });
    expect(state.getSnapshot().library?.items).toEqual([]);
  });
});
