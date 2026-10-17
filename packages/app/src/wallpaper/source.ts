import type { AppSettings } from "@/hooks/use-settings";
import type { WallpaperMediaKind } from "@omp-desktop/protocol/desktop-wallpaper";
import type { WallpaperLibrary } from "@omp-desktop/protocol/desktop-wallpaper";

const VIDEO_EXTENSIONS: Record<string, true> = {
  ".mp4": true,
  ".webm": true,
  ".m4v": true,
  ".mov": true,
  ".ogv": true,
};

export interface RemoteWallpaperSource {
  key: string;
  src: string;
  kind: WallpaperMediaKind;
}

export function getWallpaperSourceKey(settings: AppSettings): string | null {
  if (!settings.wallpaperEnabled) return null;
  if (settings.wallpaperSource === "url") {
    return parseRemoteWallpaperSource(settings.wallpaperUrl)?.key ?? null;
  }
  return settings.wallpaperSource === "file" && settings.wallpaperCandidateId
    ? `file:${settings.wallpaperCandidateId}`
    : null;
}

export function getEffectiveWallpaperSourceKey(
  settings: AppSettings,
  library: WallpaperLibrary | null,
): string | null {
  if (
    settings.wallpaperSource === "file" &&
    !library?.items.some((item) => item.candidateId === settings.wallpaperCandidateId)
  ) {
    return null;
  }
  return getWallpaperSourceKey(settings);
}

export function parseRemoteWallpaperSource(value: string | null): RemoteWallpaperSource | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const pathname = url.pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    const extension = dot >= 0 ? pathname.slice(dot) : "";
    return {
      key: `url:${url.href}`,
      src: url.href,
      kind: VIDEO_EXTENSIONS[extension] ? "video" : "image",
    };
  } catch {
    return null;
  }
}
