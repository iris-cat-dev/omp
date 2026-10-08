import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WALLPAPER_DIRS = [
  join(homedir(), "Pictures", "Wallpapers"),
  join(homedir(), "Pictures", "Wallpaper"),
  join(homedir(), ".wallpapers"),
  join(homedir(), "Wallpapers"),
];

const WALLPAPER_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".mp4",
  ".webm",
  ".m4v",
  ".mov",
]);

export interface WallpaperFileEntry {
  path: string;
  name: string;
}

export function scanWallpaperCandidates(): string[] {
  const candidates: string[] = [];
  for (const dir of WALLPAPER_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const name of entries) {
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        if (WALLPAPER_EXTENSIONS.has(ext)) {
          candidates.push(join(dir, name));
        }
      }
    } catch {
      // Directory read failed; skip.
    }
  }
  return candidates;
}

export function scanWallpaperDir(dir: string): WallpaperFileEntry[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir);
    const result: WallpaperFileEntry[] = [];
    for (const name of entries) {
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      if (WALLPAPER_EXTENSIONS.has(ext)) {
        result.push({ path: join(dir, name), name });
      }
    }
    return result;
  } catch {
    return [];
  }
}
