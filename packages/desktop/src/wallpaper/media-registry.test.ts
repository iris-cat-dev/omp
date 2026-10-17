import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WallpaperLibrary,
  WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";
import { validateWallpaperFile } from "./files.js";
import { WallpaperMediaRegistry } from "./media-registry.js";
import { createWallpaperMediaResponse } from "./media-response.js";

const roots: string[] = [];
async function fixture(names = ["background.png", "preview.mp4"]): Promise<WallpaperLibrary> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-wallpaper-registry-"));
  roots.push(root);
  const items = await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(root, name);
      await writeFile(filePath, `media:${name}`);
      return { candidateId: randomUUID(), ...(await validateWallpaperFile(filePath)) };
    }),
  );
  return { version: 1, revision: 1, items };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function read(registry: WallpaperMediaRegistry, id: string, range?: string) {
  const response = await createWallpaperMediaResponse(
    new Request(`omp-desktop://app/wallpaper-media?id=${id}`, {
      headers: range ? { range } : {},
    }),
    registry,
    null,
  );
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document wallpaper ownership", () => {
  it("shares capabilities across background, previews and windows until the last independent release", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const first = registry.activateOwner({});
    const second = registry.activateOwner({});
    const id = library.items[0].candidateId;
    const background = (await registry.setBackground(first, first.epoch, 0, id)).media!;
    const preview = (await registry.setPreviews(first, first.epoch, 0, [id, id])).media;
    const other = (await registry.setBackground(second, second.epoch, 0, id)).media!;
    expect(preview.map((media) => media.id)).toEqual([background.id]);
    expect(other.id).toBe(background.id);
    await registry.setPreviews(first, first.epoch, 1, []);
    expect(await (await read(registry, background.id)).text()).toBe("media:background.png");
    registry.disposeOwner(first);
    registry.disposeOwner(first);
    expect((await read(registry, other.id)).status).toBe(200);
    registry.disposeOwner(second);
    expect((await read(registry, other.id)).status).toBe(404);
    const next = registry.activateOwner({});
    expect((await registry.setBackground(next, next.epoch, 0, id)).media!.id).not.toBe(other.id);
  });

  it("keeps an active video's real Range reads valid through more than 256 media turnovers", async () => {
    const library = await fixture([
      "background.mp4",
      ...Array.from({ length: 270 }, (_, index) => `${index}.png`),
    ]);
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const backgroundOwner = registry.activateOwner({});
    const previewOwner = registry.activateOwner({});
    const background = (
      await registry.setBackground(
        backgroundOwner,
        backgroundOwner.epoch,
        0,
        library.items[0].candidateId,
      )
    ).media!;
    let previous: string | undefined;
    for (let index = 1; index < library.items.length; index += 1) {
      const result = await registry.setPreviews(previewOwner, previewOwner.epoch, index, [
        library.items[index].candidateId,
      ]);
      if (previous) expect((await read(registry, previous)).status).toBe(404);
      previous = result.media[0].id;
    }
    const response = await read(registry, background.id, "bytes=2-6");
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("dia:b");
    await registry.setPreviews(previewOwner, previewOwner.epoch, library.items.length, []);
    expect((await read(registry, previous!)).status).toBe(404);
    registry.disposeOwner(backgroundOwner);
    expect((await read(registry, background.id)).status).toBe(404);
  });

  it("registers revisions before I/O, so reversed completions and old cleanup cannot replace a newer preview set", async () => {
    const library = await fixture();
    const started = deferred<void>();
    const blocked = deferred<void>();
    const registry = new WallpaperMediaRegistry(async (filePath) => {
      const file = await validateWallpaperFile(filePath);
      if (filePath === library.items[0].path) {
        started.resolve();
        await blocked.promise;
      }
      return file;
    });
    registry.updateLibrary(library);
    const owner = registry.activateOwner({});
    const old = registry.setPreviews(owner, owner.epoch, 0, [library.items[0].candidateId]);
    const oldFailure = expect(old).rejects.toMatchObject({ code: "superseded" });
    await started.promise;
    const current = await registry.setPreviews(owner, owner.epoch, 1, [
      library.items[1].candidateId,
    ]);
    blocked.resolve();
    await oldFailure;
    await expect(registry.setPreviews(owner, owner.epoch, 0, [])).rejects.toMatchObject({
      code: "superseded",
    });
    expect(await (await read(registry, current.media[0].id)).text()).toBe("media:preview.mp4");
    registry.disposeOwner(owner);
  });

  it.each([
    { action: "clear", code: "superseded" },
    { action: "remove", code: "not-found" },
    { action: "navigate", code: "stale-document" },
    { action: "dispose", code: "stale-document" },
  ] as const)(
    "does not resurrect an in-flight background after $action",
    async ({ action, code }) => {
      const library = await fixture();
      const started = deferred<void>();
      const blocked = deferred<void>();
      const registry = new WallpaperMediaRegistry(
        async (filePath): Promise<WallpaperValidatedFile> => {
          const file = await validateWallpaperFile(filePath);
          started.resolve();
          await blocked.promise;
          return file;
        },
      );
      registry.updateLibrary(library);
      const key = {};
      const owner = registry.activateOwner(key);
      const pending = registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId);
      const failure = expect(pending).rejects.toMatchObject({ code });
      await started.promise;
      if (action === "clear") {
        const cleared = registry.setBackground(owner, owner.epoch, 1, null);
        expect(owner.background.media.size).toBe(0);
        await cleared;
      } else if (action === "remove") {
        registry.updateLibrary({ ...library, revision: 2, items: [] });
      } else if (action === "navigate") {
        registry.activateOwner(key);
        registry.disposeOwner(owner);
        expect(registry.getOwner(key)?.epoch).not.toBe(owner.epoch);
      } else {
        registry.disposeOwner(owner);
        registry.disposeOwner(owner);
      }
      blocked.resolve();
      await failure;
      expect(owner.background.media.size).toBe(0);
    },
  );

  it("synchronously revokes removed membership while preserving unrelated previews and reports individual file errors", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.activateOwner({});
    const background = (
      await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId)
    ).media!;
    const preview = await registry.setPreviews(
      owner,
      owner.epoch,
      0,
      library.items.map((item) => item.candidateId),
    );
    registry.updateLibrary({ ...library, revision: 2, items: [library.items[1]] });
    expect(registry.get(background.id)).toBeNull();
    expect(registry.get(preview.media[1].id)).not.toBeNull();
    await rm(library.items[1].path);
    await mkdir(library.items[1].path);
    const result = await registry.setPreviews(owner, owner.epoch, 1, [
      library.items[0].candidateId,
      library.items[1].candidateId,
    ]);
    expect(result.media).toEqual([]);
    expect(result.rejected.map((failure) => failure.code)).toEqual(["not-found", "invalid-file"]);
    expect((await read(registry, preview.media[1].id)).status).toBe(404);
  });

  it("clears failed background attempts without clearing the independently held preview", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.activateOwner({});
    const media = (
      await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId)
    ).media!;
    await registry.setPreviews(owner, owner.epoch, 0, [library.items[0].candidateId]);
    await rm(library.items[1].path);
    await expect(
      registry.setBackground(owner, owner.epoch, 1, library.items[1].candidateId),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(owner.background.media.size).toBe(0);
    expect((await read(registry, media.id)).status).toBe(200);
    await registry.setPreviews(owner, owner.epoch, 1, []);
    expect((await read(registry, media.id)).status).toBe(404);
  });

  it("rejects oversized preview intents without disturbing an existing hold", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.activateOwner({});
    const current = await registry.setPreviews(owner, owner.epoch, 0, [
      library.items[0].candidateId,
    ]);
    await expect(
      registry.setPreviews(
        owner,
        owner.epoch,
        1,
        Array.from({ length: 49 }, () => library.items[1].candidateId),
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await (await read(registry, current.media[0].id)).text()).toBe("media:background.png");
    await registry.setPreviews(owner, owner.epoch, 1, []);
    expect((await read(registry, current.media[0].id)).status).toBe(404);
  });
});
