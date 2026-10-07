/**
 * Local wallpaper videos cannot be loaded via file:// — Chromium rejects
 * file:// media from any non-file origin with "Media load rejected by URL
 * safety check" (the renderer runs from http://localhost:8081 in dev and
 * omp-desktop://app in production). Instead, media bytes are served through
 * the app's own same-origin protocol route (/wallpaper-media?path=...), which
 * streams from disk without copying the file into a blob.
 */
export function buildWallpaperMediaSrc(path: string): string {
  if (!path) return "";
  const query = encodeURIComponent(path);
  if (typeof window !== "undefined" && window.location?.protocol === "http:") {
    // Dev server origin: the protocol handler is still registered for the
    // app scheme, but the renderer origin differs, so point directly at the
    // privileged scheme — Electron resolves it via protocol.handle.
    return `omp-desktop://app/wallpaper-media?path=${query}`;
  }
  return `omp-desktop://app/wallpaper-media?path=${query}`;
}
