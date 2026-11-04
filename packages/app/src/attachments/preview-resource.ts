import type { AttachmentMetadata } from "./types";
import { resolveAttachmentPreviewUrl, releaseAttachmentPreviewUrl } from "./service";
import { isWeb } from "@/constants/platform";

export interface AttachmentPreviewResource {
  uri: string;
  encodedBytes: number;
  decodedBytes: number;
  release: () => void;
}
const live = new Set<AttachmentPreviewResource>();
let thumbnailTail: Promise<void> = Promise.resolve();

export function getImagePreviewResidencyStats() {
  let encodedBytes = 0;
  let decodedBytes = 0;
  for (const preview of live) { encodedBytes += preview.encodedBytes; decodedBytes += preview.decodedBytes; }
  return { encodedBytes, decodedBytes, previews: live.size };
}

export function recordImagePreviewDimensions(uri: string, width: number, height: number): void {
  for (const resource of live) {
    if (resource.uri === uri) resource.decodedBytes = width * height * 4;
  }
}

/** Full resolution lives only in an open lightbox; transcript previews are bounded rasters. */
export async function acquireAttachmentPreviewResource(attachment: AttachmentMetadata, maxEdge?: number): Promise<AttachmentPreviewResource> {
  const acquire = async (): Promise<AttachmentPreviewResource> => {
    const original = await resolveAttachmentPreviewUrl(attachment);
    let uri = original;
    let encodedBytes = attachment.byteSize ?? (attachment.storageType === "inline-data" ? Math.floor(attachment.storageKey.length * 3 / 4) : 0);
    let decodedBytes = 0;
    try {
      if (isWeb && maxEdge && typeof createImageBitmap === "function") {
        const response = await fetch(original);
        if (!response.ok) throw new Error(`Image preview read failed (${response.status})`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        try {
          const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
          const width = Math.max(1, Math.round(bitmap.width * scale));
          const height = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Image preview canvas is unavailable");
          context.drawImage(bitmap, 0, 0, width, height);
          const { promise, resolve, reject } = Promise.withResolvers<Blob>();
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image preview encoding failed")), "image/png");
          const thumbnail = await promise;
          canvas.width = 0;
          canvas.height = 0;
          uri = URL.createObjectURL(thumbnail);
          encodedBytes = thumbnail.size;
          decodedBytes = width * height * 4;
        } finally { bitmap.close(); }
        await releaseAttachmentPreviewUrl({ attachment, url: original });
      }
      let released = false;
      const resource: AttachmentPreviewResource = {
        uri, encodedBytes, decodedBytes,
        release() {
          if (released) return;
          released = true;
          live.delete(resource);
          if (uri !== original) URL.revokeObjectURL(uri);
          else void releaseAttachmentPreviewUrl({ attachment, url: original });
        },
      };
      live.add(resource);
      return resource;
    } catch (error) {
      if (uri !== original) URL.revokeObjectURL(uri);
      await releaseAttachmentPreviewUrl({ attachment, url: original });
      throw error;
    }
  };
  if (!maxEdge) return await acquire();
  // Limit transient full-size decoding/IPC buffers to one preview at a time.
  const pending = thumbnailTail.then(acquire);
  thumbnailTail = pending.then(() => undefined, () => undefined);
  return await pending;
}
