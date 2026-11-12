import { describe, expect, it } from "vitest";
import { DEFAULT_WALLPAPER_CONFIGURATION, parseRemoteWallpaperSource } from "./source.js";
import { WallpaperConfigSchema } from "./builtin.js";

describe("wallpaper source", () => {
  it("classifies video by pathname while preserving URL query and fragment", () => {
    expect(parseRemoteWallpaperSource("https://cdn.example.com/live.MP4?token=abc#frame")).toEqual({
      key: "url:https://cdn.example.com/live.MP4?token=abc#frame", uri: "https://cdn.example.com/live.MP4?token=abc#frame", kind: "video",
    });
    expect(parseRemoteWallpaperSource("https://cdn.example.com/image.jpg?format=video.mp4")?.kind).toBe("image");
  });
  it.each(["file:///C:/secret.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "", null])(
    "rejects unsupported media URL %s", value => { expect(parseRemoteWallpaperSource(value)).toBeNull(); },
  );
  it("preserves none, explicit null and .85 defaults independently from activation", () => {
    expect(WallpaperConfigSchema.parse(DEFAULT_WALLPAPER_CONFIGURATION)).toEqual({ source: "none", candidateId: null, url: null, opacity: 0.85 });
    for (const opacity of [0, 0.85, 1]) expect(WallpaperConfigSchema.parse({ ...DEFAULT_WALLPAPER_CONFIGURATION, opacity }).opacity).toBe(opacity);
  });
});
