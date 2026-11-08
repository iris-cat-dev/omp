import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "./types";
import {
  acquireAttachmentPreviewResource,
  getImagePreviewResidencyStats,
  type AttachmentPreviewResource,
} from "./preview-resource";

const resources: AttachmentPreviewResource[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.release();
});

function createImage(width: number, height: number): AttachmentMetadata {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // Two-pixel stripes become single-pixel stripes at half size. A 512px
  // longest-edge preview destroys their contrast when displayed at 1024px.
  for (let x = 0; x < width; x += 2) {
    context.fillStyle = x % 4 === 0 ? "#000" : "#fff";
    context.fillRect(x, 0, 2, height);
  }
  return {
    id: `stripes-${width}-${height}`,
    storageType: "inline-data",
    storageKey: canvas.toDataURL("image/png").split(",")[1]!,
    mimeType: "image/png",
    createdAt: 0,
  };
}

async function decode(uri: string): Promise<ImageBitmap> {
  return await createImageBitmap(await (await fetch(uri)).blob());
}

describe("image preview resolution", () => {
  it("preserves fine detail at the requested physical display width", async () => {
    const resource = await acquireAttachmentPreviewResource(createImage(2048, 1024), {
      width: 1024,
    });
    resources.push(resource);
    const bitmap = await decode(resource.uri);
    try {
      expect([bitmap.width, bitmap.height]).toEqual([1024, 512]);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(100, 100, 2, 1).data;
      expect(Math.abs(pixels[0]! - pixels[4]!)).toBeGreaterThan(200);
    } finally {
      bitmap.close();
    }
  });

  it("keeps portrait resolution proportional to display width and releases decoded residency", async () => {
    const before = getImagePreviewResidencyStats();
    const resource = await acquireAttachmentPreviewResource(createImage(1200, 3600), {
      width: 1000,
    });
    resources.push(resource);
    const bitmap = await decode(resource.uri);
    try {
      expect([bitmap.width, bitmap.height]).toEqual([1000, 3000]);
      expect(resource.decodedBytes).toBe(1000 * 3000 * 4);
      resource.release();
      resource.release();
      expect(getImagePreviewResidencyStats()).toEqual(before);
    } finally {
      bitmap.close();
    }
  });

  it("bounds square attachment pills while leaving small originals unscaled", async () => {
    const attachment = createImage(80, 160);
    const original = `data:${attachment.mimeType};base64,${attachment.storageKey}`;
    const fullWidth = await acquireAttachmentPreviewResource(attachment, { width: 200 });
    resources.push(fullWidth);
    expect(fullWidth.uri).toBe(original);
    const pill = await acquireAttachmentPreviewResource(attachment, { width: 96, height: 96 });
    resources.push(pill);
    const bitmap = await decode(pill.uri);
    try {
      expect([bitmap.width, bitmap.height]).toEqual([48, 96]);
    } finally {
      bitmap.close();
    }
  });
});
