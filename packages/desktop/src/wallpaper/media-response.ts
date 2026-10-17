import { open, realpath, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { getWallpaperMediaType } from "@omp-desktop/protocol/desktop-wallpaper";
import type { RegisteredWallpaperMedia, WallpaperMediaRegistry } from "./media-registry.js";

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return null;
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return null;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const requestedEnd = endRaw === "" ? size - 1 : Number(endRaw);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    start > requestedEnd
  )
    return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function createWallpaperMediaHeaders(request: Request, developmentOrigin: string | null): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
  });
  if (developmentOrigin && request.headers.get("origin") === developmentOrigin) {
    headers.set("access-control-allow-origin", developmentOrigin);
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-allow-headers", "Range");
    headers.set("access-control-expose-headers", "Content-Range, Content-Length, Accept-Ranges");
  }
  return headers;
}

async function openAuthorizedWallpaperFile(
  media: Readonly<RegisteredWallpaperMedia>,
): Promise<{ file: FileHandle; size: number } | null> {
  const canonicalPath = await realpath(media.path);
  const type = getWallpaperMediaType(canonicalPath);
  if (
    canonicalPath !== media.path ||
    !type ||
    type.kind !== media.kind ||
    type.mime !== media.mime
  ) {
    return null;
  }
  const file = await open(canonicalPath, "r");
  let authorized = false;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) return null;
    authorized = true;
    return { file, size: metadata.size };
  } finally {
    if (!authorized) await file.close();
  }
}

async function createWallpaperRangeResponse(
  request: Request,
  file: FileHandle,
  size: number,
  mime: string,
  headers: Headers,
): Promise<Response> {
  let streamOwnsFile = false;
  try {
    headers.set("content-type", mime);
    headers.set("accept-ranges", "bytes");
    const rangeHeader = request.headers.get("range");
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (rangeHeader && !range) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range ? range.end - range.start + 1 : size));
    if (request.method === "HEAD") {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = Readable.toWeb(file.createReadStream(range ?? {})) as ReadableStream;
    const response = new Response(stream, { status: range ? 206 : 200, headers });
    streamOwnsFile = true; // The accepted stream owns and closes its file descriptor.
    return response;
  } finally {
    if (!streamOwnsFile) await file.close();
  }
}

export async function createWallpaperMediaResponse(
  request: Request,
  registry: WallpaperMediaRegistry,
  developmentOrigin: string | null,
): Promise<Response> {
  const headers = createWallpaperMediaHeaders(request, developmentOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 405, headers });
  }
  const media = registry.get(new URL(request.url).searchParams.get("id") ?? "");
  if (!media) return new Response("Not found", { status: 404, headers });
  // Capture immutable authorization before I/O. Later release prevents new reads,
  // but does not truncate an already accepted video range or thumbnail response.
  try {
    const authorized = await openAuthorizedWallpaperFile(media);
    if (!authorized) return new Response("Not found", { status: 404, headers });
    return await createWallpaperRangeResponse(
      request,
      authorized.file,
      authorized.size,
      media.mime,
      headers,
    );
  } catch {
    return new Response("Not found", { status: 404, headers });
  }
}
