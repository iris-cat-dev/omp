import { describe, expect, it } from "vitest";
import { createIndexedDbAttachmentStore } from "./indexeddb-attachment-store";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("browser attachment preview URLs", () => {
  it("keeps image bytes available for saving after the preview is released", async () => {
    const store = createIndexedDbAttachmentStore();
    const source = await (await fetch(`data:image/png;base64,${PNG_BASE64}`)).blob();
    const attachment = await store.save({
      id: "saveable-image-preview",
      mimeType: "image/png",
      source: { kind: "blob", blob: source },
    });
    const image = new Image();
    try {
      const url = await store.resolvePreviewUrl({ attachment });
      expect(url).toBe(`data:image/png;base64,${PNG_BASE64}`);
      image.src = url;
      await image.decode();
      expect([image.naturalWidth, image.naturalHeight]).toEqual([1, 1]);
      await store.releasePreviewUrl!({ attachment, url });
      const saved = await (await fetch(url)).blob();
      expect(saved.type).toBe("image/png");
      expect(new Uint8Array(await saved.arrayBuffer())).toEqual(
        new Uint8Array(await source.arrayBuffer()),
      );
    } finally {
      image.removeAttribute("src");
      await store.delete({ attachment });
    }
  });

  it("revokes non-image previews without changing their bytes", async () => {
    const store = createIndexedDbAttachmentStore();
    const attachment = await store.save({
      id: "releasable-file-preview",
      mimeType: "text/plain",
      source: { kind: "blob", blob: new Blob(["attachment contents"], { type: "text/plain" }) },
    });
    try {
      const url = await store.resolvePreviewUrl({ attachment });
      expect(url.startsWith("blob:")).toBe(true);
      expect(await (await fetch(url)).text()).toBe("attachment contents");
      await store.releasePreviewUrl!({ attachment, url });
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      await store.delete({ attachment });
    }
  });
});
