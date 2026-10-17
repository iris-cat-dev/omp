import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  getEffectiveWallpaperSourceKey,
  getWallpaperSourceKey,
  parseRemoteWallpaperSource,
} from "./source";
import {
  beginWallpaperLoad,
  endWallpaperLoad,
  finishWallpaperLoad,
  getWallpaperLoadStatus,
  retryWallpaperLoad,
} from "./load-state";

describe("wallpaper source", () => {
  it("classifies video URLs from the pathname instead of the query string", () => {
    expect(parseRemoteWallpaperSource("https://cdn.example.com/live.mp4?token=abc#frame")).toEqual({
      key: "url:https://cdn.example.com/live.mp4?token=abc#frame",
      src: "https://cdn.example.com/live.mp4?token=abc#frame",
      kind: "video",
    });
    expect(parseRemoteWallpaperSource("https://cdn.example.com/image.jpg?format=webp")).toEqual({
      key: "url:https://cdn.example.com/image.jpg?format=webp",
      src: "https://cdn.example.com/image.jpg?format=webp",
      kind: "image",
    });
  });

  it("rejects local and executable URL schemes", () => {
    expect(parseRemoteWallpaperSource("file:///C:/secret.png")).toBeNull();
    expect(parseRemoteWallpaperSource("javascript:alert(1)")).toBeNull();
    expect(parseRemoteWallpaperSource("data:image/png;base64,AAAA")).toBeNull();
  });

  it("activates each source only when its own required fields exist", () => {
    expect(
      getWallpaperSourceKey({
        ...DEFAULT_CLIENT_SETTINGS,
        wallpaperEnabled: true,
        wallpaperSource: "url",
        wallpaperCandidateId: "0199ef80-5ff5-7000-8000-000000000001",
        wallpaperUrl: "https://example.com/background.png",
      }),
    ).toBe("url:https://example.com/background.png");
    expect(
      getWallpaperSourceKey({
        ...DEFAULT_CLIENT_SETTINGS,
        wallpaperEnabled: true,
        wallpaperSource: "file",
        wallpaperCandidateId: null,
      }),
    ).toBeNull();
  });

  it("keeps disabled and unselected sources inactive even with retained media fields", () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      wallpaperEnabled: true,
      wallpaperUrl: "https://example.com/background.png",
    };
    expect(getWallpaperSourceKey(settings)).toBeNull();
    expect(getWallpaperSourceKey({ ...settings, wallpaperSource: "url" })).toBe(
      "url:https://example.com/background.png",
    );
    expect(
      getWallpaperSourceKey({ ...settings, wallpaperSource: "url", wallpaperEnabled: false }),
    ).toBeNull();
  });

  it("activates the theme only for loaded media and ignores replaced media events", () => {
    const first = "file:first";
    const second = "url:https://example.com/background.png";
    const firstToken = beginWallpaperLoad(first);
    expect(getWallpaperLoadStatus(first)).toBe("loading");
    finishWallpaperLoad(firstToken, "error");
    expect(getWallpaperLoadStatus(first)).toBe("error");
    finishWallpaperLoad(firstToken, "ready");
    expect(getWallpaperLoadStatus(first)).toBe("error");
    const secondToken = beginWallpaperLoad(second);
    finishWallpaperLoad(firstToken, "ready");
    expect(getWallpaperLoadStatus(second)).toBe("loading");
    finishWallpaperLoad(secondToken, "ready");
    expect(getWallpaperLoadStatus(second)).toBe("ready");
    expect(getWallpaperLoadStatus(first)).toBe("loading");
    expect(getWallpaperLoadStatus(null)).toBe("loading");
    beginWallpaperLoad(null);
    expect(getWallpaperLoadStatus(second)).toBe("loading");
  });

  it("isolates A→B→A and same-item retry from old events and cleanup", () => {
    const firstA = beginWallpaperLoad("file:A");
    beginWallpaperLoad("file:B");
    const secondA = beginWallpaperLoad("file:A");
    finishWallpaperLoad(firstA, "ready");
    endWallpaperLoad(firstA);
    expect(getWallpaperLoadStatus("file:A")).toBe("loading");
    finishWallpaperLoad(secondA, "error");
    retryWallpaperLoad();
    finishWallpaperLoad(secondA, "ready");
    expect(getWallpaperLoadStatus("file:A")).toBe("loading");
    const repairedA = beginWallpaperLoad("file:A");
    finishWallpaperLoad(repairedA, "ready");
    finishWallpaperLoad(secondA, "error");
    expect(getWallpaperLoadStatus("file:A")).toBe("ready");
  });

  it("does not bind a removed identity to a newly added copy of the same path", () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      wallpaperEnabled: true,
      wallpaperSource: "file" as const,
      wallpaperCandidateId: "0199ef80-5ff5-7000-8000-000000000001",
    };
    const library = {
      version: 1 as const,
      revision: 2,
      items: [
        {
          candidateId: "0199ef80-5ff5-7000-8000-000000000002",
          path: "C:/wallpapers/a.png",
          directory: "C:/wallpapers",
          name: "a.png",
          kind: "image" as const,
        },
      ],
    };
    expect(getEffectiveWallpaperSourceKey(settings, library)).toBeNull();
    expect(
      getEffectiveWallpaperSourceKey(
        {
          ...settings,
          wallpaperCandidateId: library.items[0]!.candidateId,
        },
        library,
      ),
    ).toBe(`file:${library.items[0]!.candidateId}`);
    expect(
      getEffectiveWallpaperSourceKey(
        {
          ...settings,
          wallpaperSource: "url",
          wallpaperUrl: "https://example.com/video.webm",
        },
        null,
      ),
    ).toBe("url:https://example.com/video.webm");
  });
});
