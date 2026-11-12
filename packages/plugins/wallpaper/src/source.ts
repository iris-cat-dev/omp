import type { WallpaperMediaKind } from "@omp-desktop/protocol/desktop-wallpaper";

export interface WallpaperConfiguration {
  source: "none" | "file" | "url";
  candidateId: string | null;
  url: string | null;
  opacity: number;
}
export const DEFAULT_WALLPAPER_CONFIGURATION: WallpaperConfiguration = {
  source: "none", candidateId: null, url: null, opacity: 0.85,
};
const VIDEO_EXTENSIONS: Record<string, true> = { ".mp4": true, ".webm": true, ".m4v": true, ".mov": true, ".ogv": true };
export function parseRemoteWallpaperSource(value: string | null): { key: string; uri: string; kind: WallpaperMediaKind } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const pathname = url.pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    return { key: `url:${url.href}`, uri: url.href, kind: VIDEO_EXTENSIONS[dot < 0 ? "" : pathname.slice(dot)] ? "video" : "image" };
  } catch { return null; }
}
