import { describe, expect, it } from "vitest";
import {
  applyClearDraftRecord,
  collectReferencedAttachmentIdsFromState,
  DraftStoreStateSchema,
  normalizeComposerAttachment,
  pruneFinalizedDraftRecords,
  toDraftInputIfReady,
  UserComposerAttachmentSchema,
  type DraftRecord,
  type DraftStoreState,
} from "./state";
import type { VisualFeedbackComposerAttachment } from "@/attachments/types";

function feedbackAttachment(id: string): VisualFeedbackComposerAttachment {
  const metadata = (role: string) => ({
    id: `${id}-${role}`,
    mimeType: "image/png",
    storageType: "desktop-file" as const,
    storageKey: `/attachments/${id}-${role}.png`,
    createdAt: 1,
  });
  return {
    kind: "visual_feedback",
    id,
    text: "  Message body\nwith whitespace  ",
    feedback: "  修改要求\nDo not trim.  ",
    annotations: [
      { id: "point", kind: "point", x: 1800.5, y: 900, text: "  Point note\n保留  " },
      { id: "rectangle", kind: "rectangle", x: 20, y: 30, width: 50, height: 40, text: "" },
      { id: "arrow", kind: "arrow", x: 10, y: 20, x2: 90, y2: 80, text: "Arrow note" },
      {
        id: "pen",
        kind: "pen",
        points: [
          { x: 1, y: 2 },
          { x: 20.5, y: 30.5 },
        ],
        text: "Freehand note",
      },
    ],
    image: { metadata: metadata("original"), width: 2560, height: 1440 },
    preview: { metadata: metadata("preview"), width: 1280, height: 720 },
  };
}

function feedbackDraft(id: string): DraftRecord {
  return {
    input: { text: "Keep existing composer text", attachments: [feedbackAttachment(id)] },
    lifecycle: "active",
    updatedAt: 1,
    version: 1,
  };
}

describe("draft-store lifecycle", () => {
  it("prunes finalized tombstones after TTL", () => {
    const nowMs = 1_000_000;
    const drafts = {
      oldSent: {
        input: { text: "", attachments: [] },
        lifecycle: "sent" as const,
        updatedAt: 0,
        version: 2,
      },
      recentAbandoned: {
        input: { text: "", attachments: [] },
        lifecycle: "abandoned" as const,
        updatedAt: nowMs + 2 * 60 * 1000,
        version: 2,
      },
      active: {
        input: { text: "a", attachments: [] },
        lifecycle: "active" as const,
        updatedAt: 0,
        version: 1,
      },
    };

    const pruned = pruneFinalizedDraftRecords({
      drafts,
      nowMs: nowMs + 6 * 60 * 1000,
    });

    expect(pruned.oldSent).toBeUndefined();
    expect(pruned.recentAbandoned).toBeDefined();
    expect(pruned.active).toBeDefined();
  });

  it("normalizes clear-with-lifecycle into a tombstone without attachments", () => {
    const cleared = applyClearDraftRecord({
      record: {
        input: {
          text: "hello",
          attachments: [
            {
              kind: "image",
              metadata: {
                id: "att-1",
                mimeType: "image/jpeg",
                storageType: "web-indexeddb",
                storageKey: "att-1",
                createdAt: 1,
              },
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      },
      lifecycle: "sent",
      nowMs: 2,
    });

    expect(cleared).toEqual({
      input: { text: "", attachments: [] },
      lifecycle: "sent",
      updatedAt: 2,
      version: 2,
    });
  });

  it("keeps nested image references in active drafts and the create modal only", () => {
    const state: DraftStoreState = {
      drafts: {
        active: feedbackDraft("active"),
        sent: { ...feedbackDraft("sent"), lifecycle: "sent" },
        abandoned: { ...feedbackDraft("abandoned"), lifecycle: "abandoned" },
      },
      createModalDraft: feedbackDraft("modal"),
    };
    expect([...collectReferencedAttachmentIdsFromState(state)]).toEqual([
      "active-original",
      "active-preview",
      "modal-original",
      "modal-preview",
    ]);

    state.drafts.active = applyClearDraftRecord({
      record: state.drafts.active!,
      lifecycle: "sent",
      nowMs: 2,
    })!;
    state.createModalDraft = null;
    expect([...collectReferencedAttachmentIdsFromState(state)]).toEqual([]);
  });
});

describe("draft-store normalization", () => {
  it("roundtrips feedback body, all note shapes and both image references without inline bytes", () => {
    const state: DraftStoreState = {
      drafts: { active: feedbackDraft("active") },
      createModalDraft: feedbackDraft("modal"),
    };
    const saved = JSON.stringify(state);
    const restored = DraftStoreStateSchema.parse(JSON.parse(saved));
    expect(restored).toEqual(state);
    expect(toDraftInputIfReady(restored.drafts.active)).toEqual(state.drafts.active!.input);
    expect(toDraftInputIfReady(restored.createModalDraft)).toEqual(state.createModalDraft!.input);
    expect(saved).not.toContain("base64");
    expect(saved).not.toContain("data:");
    expect(saved).not.toContain('"data"');
  });

  it("normalizes nested image metadata without dropping feedback or physical coordinates", () => {
    const attachment = feedbackAttachment("normalized");
    const image = attachment.image!;
    const preview = attachment.preview!;
    expect(
      normalizeComposerAttachment({
        ...attachment,
        image: { ...image, metadata: { ...image.metadata, previewUri: "blob:stale" } },
        preview: { ...preview, metadata: { ...preview.metadata, previewUri: "blob:stale" } },
      } as VisualFeedbackComposerAttachment),
    ).toEqual(attachment);
  });

  it("rejects invalid or inline-byte nested feedback image data in persisted drafts", () => {
    const attachment = feedbackAttachment("invalid");
    const image = attachment.image!;
    const preview = attachment.preview!;
    const invalidImages = [
      { ...image, width: 0 },
      { ...image, height: -1 },
      { ...image, width: 2560.5 },
      { ...image, width: 32768, height: 32768 },
      { ...image, metadata: { ...image.metadata, createdAt: "yesterday" } },
      { ...image, data: "base64-image-data" },
    ];
    for (const invalid of invalidImages) {
      expect(
        UserComposerAttachmentSchema.safeParse({ ...attachment, image: invalid }).success,
      ).toBe(false);
      expect(
        UserComposerAttachmentSchema.safeParse({ ...attachment, preview: invalid }).success,
      ).toBe(false);
    }
    expect(
      UserComposerAttachmentSchema.safeParse({
        ...attachment,
        preview: { ...preview, metadata: { ...preview.metadata, data: "base64-image-data" } },
      }).success,
    ).toBe(false);
  });

  it("keeps text-only and preview-only feedback valid", () => {
    const { image: _image, preview, ...textOnly } = feedbackAttachment("optional");
    expect(UserComposerAttachmentSchema.parse(textOnly)).toEqual(textOnly);
    const previewOnly = { ...textOnly, preview };
    expect(UserComposerAttachmentSchema.parse(previewOnly)).toEqual(previewOnly);
  });

  it("preserves uploaded file attachments when hydrating a draft", () => {
    const attachment = {
      kind: "file" as const,
      attachment: {
        type: "uploaded_file" as const,
        id: "file-1",
        fileName: "context.json",
        mimeType: "application/json",
        size: 42,
        path: "/tmp/context.json",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves workspace file selections when hydrating a draft", () => {
    const attachment = {
      kind: "workspace_file" as const,
      path: "src/app.ts",
      selection: { kind: "line_range" as const, startLine: 12, endLine: 24 },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });
  it("preserves directory references when hydrating a draft", () => {
    const attachment = {
      kind: "directory" as const,
      path: " /Users/alice/My Project/ ",
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Inspect this folder", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({
      text: "Inspect this folder",
      attachments: [{ kind: "directory", path: "/Users/alice/My Project" }],
    });
  });
  it("preserves quoted content when hydrating a draft", () => {
    expect(
      toDraftInputIfReady({
        input: {
          text: "",
          attachments: [
            {
              kind: "quoted_content",
              id: "quote-1",
              text: "  selected response  ",
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 5,
      }),
    ).toEqual({
      text: "",
      attachments: [
        {
          kind: "quoted_content",
          id: "quote-1",
          text: "selected response",
        },
      ],
    });
  });

  it("preserves New Workspace picker ownership when hydrating a draft", () => {
    const pickerAttachment = {
      kind: "github_pr" as const,
      owner: "new-workspace-picker" as const,
      item: {
        kind: "change_request" as const,
        number: 202,
        title: "Persist picker ownership",
        url: "https://example.com/pull/202",
        state: "open" as const,
        body: null,
        labels: [],
        baseRefName: "main",
        headRefName: "feature/picker-ownership",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Keep this prompt", attachments: [pickerAttachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({
      text: "Keep this prompt",
      attachments: [pickerAttachment],
    });
  });
});
