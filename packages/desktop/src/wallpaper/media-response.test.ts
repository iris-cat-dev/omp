import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWallpaperFile } from "./files.js";
import { WallpaperMediaRegistry } from "./media-registry.js";
import { createWallpaperMediaResponse } from "./media-response.js";

const roots: string[] = [];
async function fixture(content = "0123456789") {
  const root = await mkdtemp(path.join(tmpdir(), "omp-wallpaper-stream-"));
  roots.push(root);
  const filePath = path.join(root, "中文 video.mp4");
  await writeFile(filePath, content);
  const candidate = { candidateId: randomUUID(), ...(await validateWallpaperFile(filePath)) };
  const registry = new WallpaperMediaRegistry();
  registry.updateLibrary({ version: 1, revision: 1, items: [candidate] });
  const owner = registry.activateOwner({});
  const media = (await registry.setBackground(owner, owner.epoch, 0, candidate.candidateId)).media!;
  return { registry, owner, media, filePath };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("wallpaper protocol streams", () => {
  it.each([
    [undefined, 200, "0123456789", null],
    ["bytes=2-5", 206, "2345", "bytes 2-5/10"],
    ["bytes=7-", 206, "789", "bytes 7-9/10"],
    ["bytes=-3", 206, "789", "bytes 7-9/10"],
    ["bytes=8-900", 206, "89", "bytes 8-9/10"],
  ] as const)("streams the real file for range %s", async (range, status, body, contentRange) => {
    const { registry, media } = await fixture();
    const response = await createWallpaperMediaResponse(
      new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`, {
        headers: range ? { range } : {},
      }),
      registry,
      null,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(body);
  });

  it.each([
    "bytes=10-",
    "bytes=4-2",
    "bytes=-0",
    "bytes=",
    "bytes=0-1,4-5",
    "bytes=9007199254740992-",
  ])("rejects unsatisfiable or malformed range %s", async (range) => {
    const { registry, media } = await fixture();
    const response = await createWallpaperMediaResponse(
      new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`, { headers: { range } }),
      registry,
      null,
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("authorizes once, so an accepted stream completes but a released capability cannot start another read", async () => {
    const { registry, media, owner } = await fixture();
    const request = new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`, {
      headers: { range: "bytes=1-7" },
    });
    const accepted = createWallpaperMediaResponse(request, registry, null);
    registry.disposeOwner(owner);
    const refused = await createWallpaperMediaResponse(request, registry, null);
    expect(refused.status).toBe(404);
    const response = await accepted;
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("1234567");
  });

  it("uses the exact development origin for anonymous CORS on both success and failure", async () => {
    const { registry, media } = await fixture();
    const developmentOrigin = "http://localhost:8081";
    for (const [id, status] of [
      [media.id, 200],
      [randomUUID(), 404],
    ] as const) {
      const response = await createWallpaperMediaResponse(
        new Request(`omp-desktop://app/wallpaper-media?id=${id}`, {
          headers: { origin: developmentOrigin },
        }),
        registry,
        developmentOrigin,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin")).toBe(developmentOrigin);
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("vary")).toBe("Origin");
      expect(response.headers.get("cache-control")).toBe("no-store");
      await response.arrayBuffer();
    }
    for (const origin of ["http://localhost:8082", "http://localhost:8081.evil.invalid", "null"]) {
      const response = await createWallpaperMediaResponse(
        new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`, {
          method: "HEAD",
          headers: { origin },
        }),
        registry,
        developmentOrigin,
      );
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toBe("Origin");
    }
    const packaged = await createWallpaperMediaResponse(
      new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`, {
        method: "HEAD",
        headers: { origin: developmentOrigin },
      }),
      registry,
      null,
    );
    expect(packaged.headers.get("access-control-allow-origin")).toBeNull();
    expect(await packaged.text()).toBe("");
  });

  it("rechecks real filesystem identity for each request and handles empty files and HEAD without leaking streams", async () => {
    const { registry, media, filePath } = await fixture("");
    const request = new Request(`omp-desktop://app/wallpaper-media?id=${media.id}`);
    const empty = await createWallpaperMediaResponse(request, registry, null);
    expect(empty.headers.get("content-length")).toBe("0");
    expect(await empty.text()).toBe("");
    const range = await createWallpaperMediaResponse(
      new Request(request, { headers: { range: "bytes=-1" } }),
      registry,
      null,
    );
    expect(range.status).toBe(416);
    await rm(filePath);
    await mkdir(filePath);
    const directory = await createWallpaperMediaResponse(request, registry, null);
    expect(directory.status).toBe(404);
    await rm(filePath, { recursive: true });
    await writeFile(filePath, "repaired");
    const repaired = await createWallpaperMediaResponse(request, registry, null);
    expect(await repaired.text()).toBe("repaired");
    const head = await createWallpaperMediaResponse(
      new Request(request, { method: "HEAD" }),
      registry,
      null,
    );
    expect(head.headers.get("content-length")).toBe("8");
    expect(await head.text()).toBe("");
  });
});
