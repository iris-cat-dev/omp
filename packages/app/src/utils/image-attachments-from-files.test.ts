import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectClipboardAttachmentFiles,
  filesToImageAttachments,
} from "./image-attachments-from-files";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";

function createClipboardItem(params: { kind: string; type: string; file?: File | null }) {
  return {
    kind: params.kind,
    type: params.type,
    getAsFile: () => params.file ?? null,
  };
}

function createClipboardData(files: readonly File[]) {
  return {
    items: files.map((file) => createClipboardItem({ kind: "file", type: file.type, file })),
    files,
  };
}

function createTestStore(): AttachmentStore {
  let sequence = 0;
  return {
    storageType: "web-indexeddb",
    async save(input) {
      sequence += 1;
      const id = input.id ?? `att-${sequence}`;
      const mimeType = input.mimeType ?? "image/jpeg";
      const fileName = input.fileName ?? null;
      let byteSize = 0;
      if (input.source.kind === "blob") {
        byteSize = input.source.blob.size;
      } else if (input.source.kind === "data_url") {
        byteSize = input.source.dataUrl.length;
      } else if (input.source.kind === "file_uri") {
        byteSize = input.source.uri.length;
      } else {
        byteSize = input.source.bytes.byteLength;
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize,
        createdAt: 1700000000000 + sequence,
      };
    },
    async encodeBase64() {
      throw new Error("not used in this test");
    },
    async resolvePreviewUrl() {
      throw new Error("not used in this test");
    },
    async delete() {},
    async garbageCollect() {},
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(createTestStore());
});

afterEach(() => {
  __setAttachmentStoreForTests(null);
});

describe("collectClipboardAttachmentFiles", () => {
  it("separates raster images and generic files from mixed clipboard items", () => {
    const imagePng = new File([new Uint8Array([0, 1, 2, 3])], "paste.png", {
      type: "image/png",
    });
    const textFile = new File(["not image"], "notes.txt", {
      type: "text/plain",
    });
    const svgFile = new File(["<svg />"], "logo.svg", {
      type: "image/svg+xml",
    });

    const files = collectClipboardAttachmentFiles({
      items: [
        createClipboardItem({ kind: "string", type: "text/plain" }),
        createClipboardItem({
          kind: "file",
          type: "text/plain",
          file: textFile,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/png",
          file: imagePng,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/svg+xml",
          file: svgFile,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/jpeg",
          file: null,
        }),
      ],
    });

    expect(files).toEqual({
      imageFiles: [{ file: imagePng, mimeType: "image/png" }],
      genericFiles: [textFile, svgFile],
    });
  });

  it("keeps multiple Unicode filenames in mixed native file-list delivery", () => {
    const image = new File([new Uint8Array([1, 2])], "图片 café 😀.png", { type: "image/png" });
    const text = new File(["文件内容"], "文本 café.txt", { type: "text/plain" });
    const files = collectClipboardAttachmentFiles({
      items: [
        createClipboardItem({ kind: "file", type: image.type, file: image }),
        createClipboardItem({ kind: "file", type: text.type, file: text }),
      ],
      files: [image, text],
    });
    expect(files.imageFiles).toEqual([{ file: image, mimeType: "image/png" }]);
    expect(files.genericFiles).toEqual([text]);
    expect(files.imageFiles[0]?.file.name).toBe("图片 café 😀.png");
    expect(files.genericFiles[0]?.name).toBe("文本 café.txt");
  });

  it("preserves distinct images with the same name and bytes in one paste", () => {
    const first = new File(["same image"], "image.png", { type: "image/png" });
    const second = new File(["same image"], "image.png", { type: "image/png" });
    const document = new File(["notes"], "notes.txt", { type: "text/plain" });

    const files = collectClipboardAttachmentFiles({
      items: [
        createClipboardItem({ kind: "file", type: first.type, file: first }),
        createClipboardItem({ kind: "file", type: second.type, file: second }),
        createClipboardItem({ kind: "file", type: document.type, file: document }),
      ],
      files: [first, second, document],
    });

    expect(files.imageFiles).toHaveLength(2);
    expect(files.imageFiles[0]?.file).toBe(first);
    expect(files.imageFiles[1]?.file).toBe(second);
    expect(files.genericFiles).toEqual([document]);
  });

  it("recognizes an image with an empty MIME type by its file name", () => {
    const imagePng = new File([new Uint8Array([0, 1, 2, 3])], "paste.png");

    expect(
      collectClipboardAttachmentFiles({
        items: [createClipboardItem({ kind: "file", type: "", file: imagePng })],
      }),
    ).toEqual({
      imageFiles: [{ file: imagePng, mimeType: "image/png" }],
      genericFiles: [],
    });
  });

  it("falls back to clipboard files when items contain no readable files", () => {
    const documentFile = new File(["report"], "report.pdf", {
      type: "application/pdf",
    });

    expect(
      collectClipboardAttachmentFiles({
        items: [createClipboardItem({ kind: "file", type: "application/pdf", file: null })],
        files: [documentFile],
      }),
    ).toEqual({
      imageFiles: [],
      genericFiles: [documentFile],
    });
  });

  it("ignores text-only clipboard items", () => {
    expect(
      collectClipboardAttachmentFiles({
        items: [createClipboardItem({ kind: "string", type: "text/plain" })],
      }),
    ).toEqual({
      imageFiles: [],
      genericFiles: [],
    });
  });

  it("returns empty groups when clipboard data is missing", () => {
    expect(collectClipboardAttachmentFiles(undefined)).toEqual({
      imageFiles: [],
      genericFiles: [],
    });
  });
});

describe("desktop clipboard image representations", () => {
  it.each([false, true])(
    "prefers original image files over the same paste's bitmap regardless of order (bitmap first: %s)",
    (bitmapFirst) => {
      const bitmap = new File(["rendered png"], "image.png", { type: "image/png" });
      const original = new File(["original jpeg"], "photo.jpg", { type: "image/jpeg" });
      const notes = new File(["notes"], "notes.txt", { type: "text/plain" });
      const files = bitmapFirst ? [bitmap, original, notes] : [original, notes, bitmap];
      const clipboard = createClipboardData(files);
      const getPathForFile = (file: File) => (file === original ? "C:/photos/photo.jpg" : "");

      const first = collectClipboardAttachmentFiles(clipboard, getPathForFile);
      const second = collectClipboardAttachmentFiles(clipboard, getPathForFile);

      expect(first.imageFiles).toEqual([{ file: original, mimeType: "image/jpeg" }]);
      expect(first.genericFiles).toEqual([notes]);
      expect(second).toEqual(first);
    },
  );

  it("normalizes files-only clipboard delivery using the same source rule", () => {
    const bitmap = new File(["bitmap"], "image.png", { type: "image/png" });
    const original = new File(["original"], "image.png", { type: "image/png" });

    const files = collectClipboardAttachmentFiles({ files: [bitmap, original] }, (file) =>
      file === original ? "C:/photos/image.png" : "",
    );

    expect(files.imageFiles).toEqual([{ file: original, mimeType: "image/png" }]);
  });

  it("retains multiple original images even when their names and contents match", () => {
    const bitmap = new File(["bitmap"], "image.png", { type: "image/png" });
    const first = new File(["same image"], "image.png", { type: "image/png" });
    const second = new File(["same image"], "image.png", { type: "image/png" });
    const document = new File(["pdf"], "document.pdf", { type: "application/pdf" });

    const files = collectClipboardAttachmentFiles(
      createClipboardData([bitmap, first, document, second]),
      (file) => {
        if (file === first) return "C:/first/image.png";
        if (file === second) return "C:/second/image.png";
        return "";
      },
    );

    expect(files.imageFiles).toEqual([
      { file: first, mimeType: "image/png" },
      { file: second, mimeType: "image/png" },
    ]);
    expect(files.genericFiles).toEqual([document]);
  });

  it("keeps screenshot images when the native file list is absent or unreadable", () => {
    const first = new File(["first bitmap"], "image.png", { type: "image/png" });
    const second = new File(["second bitmap"], "image.png", { type: "image/png" });
    const clipboard = createClipboardData([first, second]);

    expect(collectClipboardAttachmentFiles(clipboard, () => "").imageFiles).toEqual([
      { file: first, mimeType: "image/png" },
      { file: second, mimeType: "image/png" },
    ]);
    expect(
      collectClipboardAttachmentFiles(createClipboardData([first]), () => "").imageFiles,
    ).toEqual([{ file: first, mimeType: "image/png" }]);
  });

  it("does not treat a generic native file as an original image", () => {
    const bitmap = new File(["bitmap"], "image.png", { type: "image/png" });
    const document = new File(["pdf"], "document.pdf", { type: "application/pdf" });

    const files = collectClipboardAttachmentFiles(createClipboardData([bitmap, document]), (file) =>
      file === document ? "C:/document.pdf" : "",
    );

    expect(files.imageFiles).toEqual([{ file: bitmap, mimeType: "image/png" }]);
    expect(files.genericFiles).toEqual([document]);
  });

  it("leaves web clipboard images and non-PNG files unchanged without native bitmap provenance", () => {
    const bitmap = new File(["bitmap"], "image.png", { type: "image/png" });
    const original = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    const clipboard = createClipboardData([bitmap, original]);

    expect(collectClipboardAttachmentFiles(clipboard).imageFiles).toHaveLength(2);
    expect(
      collectClipboardAttachmentFiles(clipboard, (file) => (file === bitmap ? "C:/image.png" : ""))
        .imageFiles,
    ).toEqual([
      { file: bitmap, mimeType: "image/png" },
      { file: original, mimeType: "image/jpeg" },
    ]);
  });
});

describe("filesToImageAttachments", () => {
  it("persists files as attachment metadata in order", async () => {
    const pngFile = new File([new Uint8Array([0, 1, 2, 3])], "first.png", {
      type: "image/png",
    });
    const typeLessFile = new File([new Uint8Array([4, 5, 6, 7])], "second", {
      type: "",
    });

    const attachments = await filesToImageAttachments([
      { file: pngFile, mimeType: "image/png" },
      { file: typeLessFile, mimeType: "image/png" },
    ]);

    expect(attachments).toEqual([
      {
        id: "att-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-1",
        fileName: "first.png",
        byteSize: 4,
        createdAt: 1700000000001,
      },
      {
        id: "att-2",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-2",
        fileName: "second",
        byteSize: 4,
        createdAt: 1700000000002,
      },
    ]);
  });

  it("handles large files without creating data URLs", async () => {
    const large = new File([new Uint8Array(4 * 1024 * 1024)], "large.png", {
      type: "image/png",
    });

    const [attachment] = await filesToImageAttachments([{ file: large, mimeType: "image/png" }]);

    expect(attachment?.storageType).toBe("web-indexeddb");
    expect(attachment?.byteSize).toBe(4 * 1024 * 1024);
  });

  it("persists a repeated paste of the same file as a new attachment", async () => {
    const file = new File(["same image"], "image.png", { type: "image/png" });
    const clipboard = {
      items: [createClipboardItem({ kind: "file", type: file.type, file })],
      files: [file],
    };

    const first = await filesToImageAttachments(
      collectClipboardAttachmentFiles(clipboard).imageFiles,
    );
    const second = await filesToImageAttachments(
      collectClipboardAttachmentFiles(clipboard).imageFiles,
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).toBe("att-1");
    expect(second[0]?.id).toBe("att-2");
  });
});
