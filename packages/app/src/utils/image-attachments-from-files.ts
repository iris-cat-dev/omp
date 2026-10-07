import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { resolveRasterImageMimeType } from "@/attachments/file-types";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
}

export type ImageAttachmentFromFile = AttachmentMetadata;

export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export interface ClipboardAttachmentFiles {
  imageFiles: ClipboardImageFile[];
  genericFiles: File[];
}

function collectClipboardFile(
  result: ClipboardAttachmentFiles,
  file: File,
  mimeTypeHint?: string,
): void {
  const mimeType = resolveRasterImageMimeType({
    mimeType: file.type || mimeTypeHint,
    path: file.name,
  });
  if (mimeType) {
    result.imageFiles.push({ file, mimeType });
  } else {
    result.genericFiles.push(file);
  }
}

export function collectClipboardAttachmentFiles(
  clipboardData?: ClipboardDataLike | null,
): ClipboardAttachmentFiles {
  const result: ClipboardAttachmentFiles = { imageFiles: [], genericFiles: [] };
  const items = clipboardData?.items;
  let foundReadableItem = false;

  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind !== "file") {
        continue;
      }
      const file = item.getAsFile?.();
      if (!file) {
        continue;
      }
      foundReadableItem = true;
      collectClipboardFile(result, file, item.type);
    }
  }

  const files = clipboardData?.files;
  if (!foundReadableItem && files) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file) {
        collectClipboardFile(result, file);
      }
    }
  }

  return result;
}

export async function filesToImageAttachments(
  files: readonly ClipboardImageFile[],
): Promise<ImageAttachmentFromFile[]> {
  const attachments = await Promise.all(
    files.map(async ({ file, mimeType }) => {
      try {
        return await persistAttachmentFromBlob({
          blob: file,
          mimeType,
          fileName: file.name,
        });
      } catch (error) {
        console.error("[attachments] Failed to persist file attachment", {
          fileName: file.name,
          error,
        });
        return null;
      }
    }),
  );

  return attachments.filter((entry): entry is ImageAttachmentFromFile => entry !== null);
}
