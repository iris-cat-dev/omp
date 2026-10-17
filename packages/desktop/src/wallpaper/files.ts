import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  getWallpaperMediaType,
  type WallpaperErrorCode,
  type WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";

export class WallpaperError extends Error {
  constructor(
    readonly code: WallpaperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WallpaperError";
  }
}

export function wallpaperFailure(error: unknown): WallpaperError {
  if (error instanceof WallpaperError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new WallpaperError(
    code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "not-readable",
    error instanceof Error ? error.message : "The media file could not be read.",
  );
}

export async function validateWallpaperFile(
  requestedPath: string,
): Promise<WallpaperValidatedFile> {
  try {
    const canonicalPath = await realpath(requestedPath);
    if (!(await stat(canonicalPath)).isFile()) {
      throw new WallpaperError("invalid-file", "The selected path is not a regular file.");
    }
    const media = getWallpaperMediaType(canonicalPath);
    if (!media) throw new WallpaperError("unsupported", "This media type is not supported.");
    await access(canonicalPath, constants.R_OK);
    return {
      directory: path.dirname(canonicalPath),
      path: canonicalPath,
      name: path.basename(canonicalPath),
      kind: media.kind,
    };
  } catch (error) {
    throw wallpaperFailure(error);
  }
}

export async function validateLegacyWallpaper(
  directory: string | null,
  requestedPath: string | null,
): Promise<WallpaperValidatedFile | null> {
  if (!requestedPath) return null;
  if (!directory) throw new WallpaperError("invalid-file", "The legacy directory is missing.");
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) {
    throw new WallpaperError("invalid-file", "The legacy directory is not a directory.");
  }
  const file = await validateWallpaperFile(requestedPath);
  const relative = path.relative(root, file.path);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WallpaperError("invalid-file", "The legacy file is outside its selected directory.");
  }
  return file;
}

// Keep filesystem pressure bounded without allowing completion order to reorder a batch.
export async function mapWallpaperFiles<T, R>(
  values: readonly T[],
  visit: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await visit(values[index]);
      }
    }),
  );
  return results;
}
