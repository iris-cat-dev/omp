import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WallpaperLibrary,
  WallpaperMediaDescriptor,
  WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";
import { validateWallpaperFile } from "./files.js";
import { WallpaperMediaRegistry, type WallpaperDocumentOwner } from "./media-registry.js";
import { createWallpaperMediaResponse } from "./media-response.js";

const roots: string[] = [];
const binding = { installationId: "wallpaper", generation: 1 };
const nativeIdentity = { contentsId: 1, frameId: "15790216271289020344", isMainFrame: true, isDocument: true, navigationToken: "document-A" };
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
async function read(registry: WallpaperMediaRegistry, owner: WallpaperDocumentOwner, media: WallpaperMediaDescriptor, range?: string) {
  const response = await createWallpaperMediaResponse(
    new Request(media.uri, {
      headers: range ? { range } : {},
    }),
    registry,
    owner,
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
  it("issues independent capabilities for background, previews and each window", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const first = registry.bindNativeDocument({}, nativeIdentity);
    const second = registry.bindNativeDocument({}, nativeIdentity);
    const id = library.items[0].candidateId;
    const background = (await registry.setBackground(first, first.epoch, 0, id, binding)).media!;
    const preview = (await registry.setPreviews(first, first.epoch, 0, [id, id], binding)).media;
    const other = (await registry.setBackground(second, second.epoch, 0, id, binding)).media!;
    expect(preview).toHaveLength(1);
    expect(preview[0].id).not.toBe(background.id);
    expect(other.id).not.toBe(background.id);
    expect(registry.get(background.id, { ...background.scope, epoch: second.epoch })).toBeNull();
    expect(registry.get(background.id, { ...background.scope, purpose: "previews" })).toBeNull();
    expect(registry.get(background.id, { ...background.scope, installationId: "other-installation" })).toBeNull();
    expect(registry.get(background.id, { ...background.scope, generation: 0 })).toBeNull();
    expect(background.uri).not.toContain("path=");
    expect(new URL(background.uri).searchParams.get("epoch")).toBe(first.epoch);
    await registry.setPreviews(first, first.epoch, 1, [], binding);
    expect(await (await read(registry, first, background)).text()).toBe("media:background.png");
    registry.disposeOwner(first);
    registry.disposeOwner(first);
    expect((await read(registry, second, other)).status).toBe(200);
    registry.disposeOwner(second);
    expect((await read(registry, second, other)).status).toBe(404);
    const next = registry.bindNativeDocument({}, nativeIdentity);
    expect((await registry.setBackground(next, next.epoch, 0, id, binding)).media!.id).not.toBe(other.id);
  });

  it("keeps an active video's real Range reads valid through more than 256 media turnovers", async () => {
    const library = await fixture([
      "background.mp4",
      ...Array.from({ length: 270 }, (_, index) => `${index}.png`),
    ]);
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const backgroundOwner = registry.bindNativeDocument({}, nativeIdentity);
    const previewOwner = registry.bindNativeDocument({}, nativeIdentity);
    const background = (
      await registry.setBackground(backgroundOwner, backgroundOwner.epoch, 0, library.items[0].candidateId, binding)
    ).media!;
    let previous: WallpaperMediaDescriptor | undefined;
    for (let index = 1; index < library.items.length; index += 1) {
      const result = await registry.setPreviews(previewOwner, previewOwner.epoch, index, [
        library.items[index].candidateId,
      ], binding);
      if (previous) expect((await read(registry, previewOwner, previous)).status).toBe(404);
      previous = result.media[0];
    }
    const response = await read(registry, backgroundOwner, background, "bytes=2-6");
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("dia:b");
    await registry.setPreviews(previewOwner, previewOwner.epoch, library.items.length, [], binding);
    expect((await read(registry, previewOwner, previous!)).status).toBe(404);
    registry.disposeOwner(backgroundOwner);
    expect((await read(registry, backgroundOwner, background)).status).toBe(404);
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
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const old = registry.setPreviews(owner, owner.epoch, 0, [library.items[0].candidateId], binding);
    const oldFailure = expect(old).rejects.toMatchObject({ code: "superseded" });
    await started.promise;
    const current = await registry.setPreviews(owner, owner.epoch, 1, [
      library.items[1].candidateId,
    ], binding);
    blocked.resolve();
    await oldFailure;
    await expect(registry.setPreviews(owner, owner.epoch, 0, [], binding)).rejects.toMatchObject({
      code: "superseded",
    });
    expect(await (await read(registry, owner, current.media[0])).text()).toBe("media:preview.mp4");
    registry.disposeOwner(owner);
  });

  it.each([
    { action: "clear", code: "superseded" },
    { action: "remove", code: "not-found" },
    { action: "navigate", code: "stale-document" },
    { action: "dispose", code: "stale-document" },
    { action: "revoke", code: "unauthorized" },
    { action: "deselect", code: "superseded" },
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
      const owner = registry.bindNativeDocument(key, nativeIdentity);
      const pending = registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding);
      const failure = expect(pending).rejects.toMatchObject({ code });
      await started.promise;
      if (action === "clear") {
        const cleared = registry.setBackground(owner, owner.epoch, 1, null, binding);
        expect(owner.installations.get(binding.installationId)?.background.media.size ?? 0).toBe(0);
        await cleared;
      } else if (action === "remove") {
        registry.updateLibrary({ ...library, revision: 2, items: [] });
      } else if (action === "navigate") {
        registry.bindNativeDocument(key, { ...nativeIdentity, navigationToken: "replacement-document" });
        registry.disposeOwner(owner);
        expect(registry.getOwner(key)?.epoch).not.toBe(owner.epoch);
      } else if (action === "revoke") {
        registry.revokeInstallation(binding.installationId, binding.generation);
      } else if (action === "deselect") {
        registry.revokeBackground(binding.installationId, binding.generation);
      } else {
        registry.disposeOwner(owner);
        registry.disposeOwner(owner);
      }
      blocked.resolve();
      await failure;
      expect(owner.installations.get(binding.installationId)?.background.media.size ?? 0).toBe(0);
    },
  );

  it("synchronously revokes removed membership while preserving unrelated previews and reports individual file errors", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const background = (
      await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding)
    ).media!;
    const preview = await registry.setPreviews(owner, owner.epoch, 0, library.items.map((item) => item.candidateId), binding);
    registry.updateLibrary({ ...library, revision: 2, items: [library.items[1]] });
    expect(registry.get(background.id, background.scope)).toBeNull();
    expect(registry.get(preview.media[1].id, preview.media[1].scope)).not.toBeNull();
    await rm(library.items[1].path);
    await mkdir(library.items[1].path);
    const result = await registry.setPreviews(owner, owner.epoch, 1, [
      library.items[0].candidateId,
      library.items[1].candidateId,
    ], binding);
    expect(result.media).toEqual([]);
    expect(result.rejected.map((failure) => failure.code)).toEqual(["not-found", "invalid-file"]);
    expect((await read(registry, owner, preview.media[1])).status).toBe(404);
  });

  it("clears failed background attempts without clearing the independently held preview", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const media = (
      await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding)
    ).media!;
    const preview = (await registry.setPreviews(owner, owner.epoch, 0, [library.items[0].candidateId], binding)).media[0];
    await rm(library.items[1].path);
    await expect(
      registry.setBackground(owner, owner.epoch, 1, library.items[1].candidateId, binding),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(owner.installations.get(binding.installationId)?.background.media.size ?? 0).toBe(0);
    expect((await read(registry, owner, media)).status).toBe(404);
    expect((await read(registry, owner, preview)).status).toBe(200);
    await registry.setPreviews(owner, owner.epoch, 1, [], binding);
    expect((await read(registry, owner, media)).status).toBe(404);
  });

  it("rejects oversized preview intents without disturbing an existing hold", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry();
    registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const current = await registry.setPreviews(owner, owner.epoch, 0, [
      library.items[0].candidateId,
    ], binding);
    await expect(
      registry.setPreviews(owner, owner.epoch, 1, Array.from({ length: 49 }, () => library.items[1].candidateId), binding),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await (await read(registry, owner, current.media[0])).text()).toBe("media:background.png");
    await registry.setPreviews(owner, owner.epoch, 1, [], binding);
    expect((await read(registry, owner, current.media[0])).status).toBe(404);
  });

  it("replacing one installation generation cannot clear another installation or newer leases", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry(); registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const old = (await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding)).media!;
    const anotherBinding = { installationId: "other-wallpaper", generation: 1 };
    const other = (await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, anotherBinding)).media!;
    registry.revokeInstallation(binding.installationId, 1);
    const newer = (await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, { ...binding, generation: 2 })).media!;
    registry.revokeInstallation(binding.installationId, 1);
    expect((await read(registry, owner, old)).status).toBe(404);
    expect((await read(registry, owner, other)).status).toBe(200);
    expect((await read(registry, owner, newer)).status).toBe(200);
    registry.disposeOwner(owner);
  });

  it("deselecting wallpaper revokes background URLs without disturbing management previews", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry(); registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const background = (await registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding)).media!;
    const preview = (await registry.setPreviews(owner, owner.epoch, 0, [library.items[0].candidateId], binding)).media[0];
    registry.revokeBackground(binding.installationId, binding.generation);
    expect((await read(registry, owner, background)).status).toBe(404);
    expect((await read(registry, owner, preview)).status).toBe(200);
    const resumed = (await registry.setBackground(owner, owner.epoch, 2, library.items[0].candidateId, binding)).media!;
    expect((await read(registry, owner, resumed)).status).toBe(200);
    registry.disposeOwner(owner);
  });

  it("client lease cleanup releases only its document and purpose", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry(); registry.updateLibrary(library);
    const first = registry.bindNativeDocument({}, nativeIdentity), second = registry.bindNativeDocument({}, nativeIdentity);
    const candidateId = library.items[0].candidateId;
    const firstBackground = (await registry.setBackground(first, first.epoch, 0, candidateId, binding)).media!;
    const firstPreview = (await registry.setPreviews(first, first.epoch, 0, [candidateId], binding)).media[0];
    const secondBackground = (await registry.setBackground(second, second.epoch, 0, candidateId, binding)).media!;
    registry.releasePluginDocument(first, binding.installationId, binding.generation, "background");
    expect((await read(registry, first, firstBackground)).status).toBe(404);
    expect((await read(registry, first, firstPreview)).status).toBe(200);
    expect((await read(registry, second, secondBackground)).status).toBe(200);
    registry.releasePluginDocument(first, binding.installationId, binding.generation + 1, "previews");
    expect((await read(registry, first, firstPreview)).status).toBe(200);
    registry.releasePluginDocument(first, binding.installationId, binding.generation, "previews");
    expect((await read(registry, first, firstPreview)).status).toBe(404);
    expect((await read(registry, second, secondBackground)).status).toBe(200);
    registry.disposeOwner(first); registry.disposeOwner(second);
  });

  it("document-purpose cleanup cancels an in-flight acquisition before it can publish", async () => {
    const library = await fixture(), started = deferred<void>(), blocked = deferred<void>();
    const registry = new WallpaperMediaRegistry(async filePath => {
      const file = await validateWallpaperFile(filePath); started.resolve(); await blocked.promise; return file;
    });
    registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity);
    const pending = registry.setBackground(owner, owner.epoch, 0, library.items[0].candidateId, binding);
    const rejected = expect(pending).rejects.toMatchObject({ code: "superseded" });
    await started.promise;
    registry.releasePluginDocument(owner, binding.installationId, binding.generation, "background");
    blocked.resolve(); await rejected;
    expect(owner.installations.get(binding.installationId)?.background.media.size).toBe(0);
    registry.disposeOwner(owner);
  });

  it("translates reset client counters without allocating holdings or replacing previews", async () => {
    const library = await fixture();
    const registry = new WallpaperMediaRegistry(); registry.updateLibrary(library);
    const owner = registry.bindNativeDocument({}, nativeIdentity), candidateId = library.items[0].candidateId;
    expect(registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation, "background")).toBe(0);
    expect(owner.installations.size).toBe(0);
    await registry.setBackground(owner, owner.epoch, 7, candidateId, binding);
    const preview = (await registry.setPreviews(owner, owner.epoch, 2, [candidateId], binding)).media[0];
    expect(registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation, "background")).toBe(8);
    expect(registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation, "previews")).toBe(3);
    registry.releasePluginDocument(owner, binding.installationId, binding.generation, "background");
    const revision = registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation, "background");
    expect(revision).toBe(9);
    const resumed = (await registry.setBackground(owner, owner.epoch, revision, candidateId, binding)).media!;
    expect((await read(registry, owner, resumed)).status).toBe(200);
    expect((await read(registry, owner, preview)).status).toBe(200);
    expect(() => registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation + 1, "background")).toThrow("generation was revoked");
    expect(() => registry.nextPluginDocumentRevision(owner, binding.installationId, -1, "background")).toThrow("Invalid installation generation");
    registry.disposeOwner(owner);
    expect(() => registry.nextPluginDocumentRevision(owner, binding.installationId, binding.generation, "background")).toThrow("document has changed");
  });
});
