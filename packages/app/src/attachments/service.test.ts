import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, AttachmentStore, SaveAttachmentInput } from "@/attachments/types";
import { hydrateStreamState } from "@/types/stream";
import { __setAttachmentStoreForTests } from "./store";
import {
  deleteAttachments,
  encodeAttachmentsForSend,
  garbageCollectAttachments,
  persistAttachmentFromBytes,
  releaseAttachmentPreviewUrl,
  resolveAttachmentPreviewUrl,
} from "./service";
import { prepareVisualFeedbackAttachment } from "@/visual-feedback/submission";
import { collectRetainedAttachmentIds } from "./gc-retention";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { CanonicalDraftInputSchema } from "@/stores/draft-store/state";
import { withRetainedComposerImages } from "@/composer/actions";

function createAttachment(input: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: input.id ?? "att_1",
    mimeType: input.mimeType ?? "image/png",
    storageType: input.storageType ?? "web-indexeddb",
    storageKey: input.storageKey ?? "att_1",
    fileName: input.fileName,
    byteSize: input.byteSize,
    createdAt: input.createdAt ?? 1700000000000,
  };
}

function createRecordingStore(): AttachmentStore & {
  savedSources: SaveAttachmentInput[];
  releasedUrls: string[];
} {
  const savedSources: SaveAttachmentInput[] = [];
  const releasedUrls: string[] = [];

  return {
    storageType: "web-indexeddb",
    savedSources,
    releasedUrls,
    async save(input) {
      savedSources.push(input);
      return createAttachment({
        id: input.id,
        mimeType: input.mimeType,
        fileName: input.fileName,
        byteSize: 4,
      });
    },
    async encodeBase64({ attachment }) {
      return `${attachment.id}:base64`;
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async releasePreviewUrl({ url }) {
      releasedUrls.push(url);
    },
    async delete() {},
    async garbageCollect() {},
  };
}

describe("attachment service", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
  });

  it("prepares one draft-safe feedback card with both associated images", async () => {
    const store = createRecordingStore();
    const saved: AttachmentMetadata[] = [];
    const save = store.save;
    store.save = async (input) => {
      if (saved.length > 0) {
        expect(collectRetainedAttachmentIds()).toContain(saved[0]!.id);
      }
      const attachment = await save({ ...input, id: `feedback-image-${saved.length + 1}` });
      saved.push(attachment);
      return attachment;
    };
    __setAttachmentStoreForTests(store);
    const submission = {
      text: "  Supplied body\n  ",
      feedback: "  Requested changes\n修改要求  ",
      annotations: [
        { id: "note", kind: "point" as const, x: 1800.5, y: 900, text: "  Entire note\n  " },
      ],
      image: { data: "b3JpZ2luYWw=", mimeType: "image/png" as const, width: 2560, height: 1440 },
      preview: { data: "cHJldmlldw==", mimeType: "image/jpeg" as const, width: 1280, height: 720 },
    };
    const card = await prepareVisualFeedbackAttachment(submission);
    const draft = CanonicalDraftInputSchema.parse(
      JSON.parse(JSON.stringify({ text: "Existing composer body", attachments: [card] })),
    );
    expect(draft.text).toBe("Existing composer body");
    expect(draft.attachments).toEqual([card]);
    expect(card).toMatchObject({
      kind: "visual_feedback",
      text: submission.text,
      feedback: submission.feedback,
      annotations: submission.annotations,
      image: { metadata: saved[0], width: 2560, height: 1440 },
      preview: { metadata: saved[1], width: 1280, height: 720 },
    });
    expect(JSON.stringify(draft)).not.toContain(submission.image.data);
    expect(JSON.stringify(draft)).not.toContain(submission.preview.data);
    for (const metadata of saved) {
      expect(collectRetainedAttachmentIds()).not.toContain(metadata.id);
    }
    const wire = splitComposerAttachmentsForSubmit(draft.attachments);
    expect(wire.images).toEqual(saved);
  });

  it("cleans up an original image if saving the feedback preview fails", async () => {
    const store = createRecordingStore();
    const original = createAttachment({ id: "partial-original" });
    const failure = new Error("Preview storage unavailable");
    const deleted: string[] = [];
    let calls = 0;
    store.save = async () => {
      calls += 1;
      if (calls === 1) return original;
      throw failure;
    };
    store.delete = async ({ attachment }) => {
      deleted.push(attachment.id);
    };
    __setAttachmentStoreForTests(store);

    await expect(
      prepareVisualFeedbackAttachment({
        text: "",
        feedback: "Keep this feedback",
        annotations: [],
        image: { data: "AAEC", mimeType: "image/png", width: 400, height: 300 },
        preview: { data: "AwQF", mimeType: "image/png", width: 400, height: 300 },
      }),
    ).rejects.toBe(failure);
    expect(deleted).toEqual([original.id]);
    expect(collectRetainedAttachmentIds()).not.toContain(original.id);
  });

  it("keeps both feedback images through in-flight garbage collection and releases them afterwards", async () => {
    const store = createRecordingStore();
    const original = createAttachment({ id: "feedback-original" });
    const preview = createAttachment({ id: "feedback-preview" });
    const collections: string[][] = [];
    store.garbageCollect = async ({ referencedIds }) => {
      collections.push([...referencedIds]);
    };
    __setAttachmentStoreForTests(store);
    const card = {
      kind: "visual_feedback" as const,
      id: "feedback-in-flight",
      text: "",
      feedback: "Keep both images",
      annotations: [],
      image: { metadata: original, width: 2560, height: 1440 },
      preview: { metadata: preview, width: 1280, height: 720 },
    };

    await withRetainedComposerImages([card], async () => {
      await garbageCollectAttachments({ referencedIds: new Set() });
    });
    expect(collections).toEqual([[original.id, preview.id]]);
    await garbageCollectAttachments({ referencedIds: new Set() });
    expect(collections).toEqual([[original.id, preview.id], []]);
  });

  it.each(["Review this screenshot", ""])(
    "previews canonical screenshots after fresh history hydration with text %j",
    async (text) => {
      const store = createRecordingStore();
      store.resolvePreviewUrl = async () => {
        throw new Error("The previous session's local attachment is unavailable");
      };
      __setAttachmentStoreForTests(store);
      const images = [
        {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
          mimeType: "image/png",
        },
        {
          data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          mimeType: "image/gif",
        },
      ];
      const state = hydrateStreamState([
        {
          event: {
            type: "timeline",
            provider: "pi",
            item: { type: "user_message", messageId: "persisted-user", text, images },
          },
          timestamp: new Date("2026-09-05T10:00:00Z"),
        },
      ]);

      expect(state).toHaveLength(1);
      const message = state[0];
      if (message?.kind !== "user_message") throw new Error("Expected a hydrated user message");
      expect(message.text).toBe(text);
      expect(message.images).toHaveLength(2);
      const attachments = message.images!;
      expect(attachments[0]!.id).not.toBe(attachments[1]!.id);
      await expect(Promise.all(attachments.map(resolveAttachmentPreviewUrl))).resolves.toEqual(
        images.map((image) => `data:${image.mimeType};base64,${image.data}`),
      );
      await expect(encodeAttachmentsForSend(attachments)).resolves.toEqual(images);
    },
  );

  it("keeps inline image encoding and cleanup independent of local attachments", async () => {
    const store = createRecordingStore();
    const deletedIds: string[] = [];
    store.delete = async ({ attachment }) => {
      deletedIds.push(attachment.id);
    };
    __setAttachmentStoreForTests(store);
    const inline = createAttachment({
      id: "history-image",
      storageType: "inline-data",
      storageKey: "AAEC",
    });
    const local = createAttachment({ id: "local-image", storageKey: inline.storageKey });
    const inlineUrl = await resolveAttachmentPreviewUrl(inline);
    const localUrl = await resolveAttachmentPreviewUrl(local);

    await expect(encodeAttachmentsForSend([inline, local])).resolves.toEqual([
      { data: "AAEC", mimeType: "image/png" },
      { data: "local-image:base64", mimeType: "image/png" },
    ]);
    await releaseAttachmentPreviewUrl({ attachment: inline, url: inlineUrl });
    await releaseAttachmentPreviewUrl({ attachment: local, url: localUrl });
    await deleteAttachments([inline, local]);

    expect(store.releasedUrls).toEqual([localUrl]);
    expect(deletedIds).toEqual(["local-image"]);
    await expect(resolveAttachmentPreviewUrl(inline)).resolves.toBe("data:image/png;base64,AAEC");
  });

  it("persists raw bytes without requiring a base64 wrapper", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const bytes = new Uint8Array([0, 1, 2, 3]);

    const attachment = await persistAttachmentFromBytes({
      id: "att_bytes",
      bytes,
      mimeType: "image/png",
      fileName: "image.png",
    });

    expect(attachment).toEqual({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_1",
      fileName: "image.png",
      byteSize: 4,
      createdAt: 1700000000000,
    });
    expect(store.savedSources).toEqual([
      {
        id: "att_bytes",
        mimeType: "image/png",
        fileName: "image.png",
        source: { kind: "bytes", bytes },
      },
    ]);
  });

  it("keeps provider send output byte-compatible", async () => {
    const store = createRecordingStore();
    __setAttachmentStoreForTests(store);
    const attachment = createAttachment({ id: "att_send", mimeType: "image/jpeg" });

    await expect(encodeAttachmentsForSend([attachment])).resolves.toEqual([
      { data: "att_send:base64", mimeType: "image/jpeg" },
    ]);
  });

  it("rejects the send when an attachment can no longer be read", async () => {
    const store = createRecordingStore();
    store.encodeBase64 = async () => {
      throw new Error("ENOENT");
    };
    __setAttachmentStoreForTests(store);
    const attachment = createAttachment({ id: "att_missing", fileName: "missing.png" });

    await expect(encodeAttachmentsForSend([attachment])).rejects.toThrow(
      "Unable to read image attachment 'missing.png'. Remove and reattach it, then try again.",
    );
  });

  it("does not collect an attachment persisted while garbage collection is starting", async () => {
    let releaseSave: () => void = () => undefined;
    let reportSaveStarted: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const garbageCollections: string[][] = [];
    const store: AttachmentStore = {
      ...createRecordingStore(),
      async save(input) {
        reportSaveStarted();
        await saveGate;
        return createAttachment({ id: input.id });
      },
      async garbageCollect({ referencedIds }) {
        garbageCollections.push([...referencedIds]);
      },
    };
    __setAttachmentStoreForTests(store);

    const persist = persistAttachmentFromBytes({
      id: "assistant-preview",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });
    await saveStarted;
    const collect = garbageCollectAttachments({ referencedIds: new Set() });

    try {
      await Promise.resolve();
      expect(garbageCollections).toEqual([]);
    } finally {
      releaseSave();
      await Promise.all([persist, collect]);
    }

    expect(garbageCollections).toEqual([["assistant-preview"]]);
  });
});
