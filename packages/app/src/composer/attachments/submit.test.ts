import { describe, expect, it } from "vitest";
import { createDirectoryComposerAttachment } from "@/attachments/directory";
import { splitComposerAttachmentsForSubmit } from "./submit";
import type { AttachmentMetadata, VisualFeedbackComposerAttachment } from "@/attachments/types";

function image(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    createdAt: 1,
  };
}

describe("composer attachment submission", () => {
  it("submits a directory as a direct text reference without an upload attachment", () => {
    const result = splitComposerAttachmentsForSubmit([
      createDirectoryComposerAttachment("/Users/alice/My Project"),
    ]);

    expect(result.images).toEqual([]);
    expect(result.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        contextKind: "directory",
        title: "My Project",
        text: "Directory: /Users/alice/My Project",
      },
    ]);
  });
  it("submits quoted content as a direct text attachment", () => {
    const result = splitComposerAttachmentsForSubmit([
      { kind: "quoted_content", id: "quote-1", text: "The selected response." },
    ]);

    expect(result.images).toEqual([]);
    expect(result.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "Quoted content",
        text: "The selected response.",
      },
    ]);
  });
  it("associates every feedback card with its original and preview among other images", () => {
    const ordinary = image("ordinary");
    const original = image("first-original");
    const preview = image("first-preview");
    const nextOriginal = image("second-original");
    const first: VisualFeedbackComposerAttachment = {
      kind: "visual_feedback",
      id: "first",
      text: "  Keep this body\nunchanged.  ",
      feedback: "  修改要求\nKeep all requested changes.  ",
      annotations: [
        { id: "point", kind: "point", x: 2048, y: 1024, text: "  First note\n完整内容  " },
        { id: "rect", kind: "rectangle", x: 30, y: 40, width: 90, height: 60, text: "" },
        { id: "arrow", kind: "arrow", x: 100, y: 200, x2: 400, y2: 500, text: "Arrow" },
        {
          id: "pen",
          kind: "pen",
          points: [
            { x: 12.5, y: 25.25 },
            { x: 600, y: 700 },
          ],
          text: "Freehand",
        },
      ],
      image: { metadata: original, width: 2560, height: 1440 },
      preview: { metadata: preview, width: 1280, height: 720 },
    };
    const result = splitComposerAttachmentsForSubmit([
      { kind: "image", metadata: ordinary },
      first,
      { kind: "image", metadata: image("between") },
      {
        kind: "visual_feedback",
        id: "second",
        text: "",
        feedback: "Second card",
        annotations: [{ id: "note", kind: "point", x: 50, y: 80, text: "Second note" }],
        image: { metadata: nextOriginal, width: 800, height: 600 },
      },
    ]);

    expect(result.images).toEqual([ordinary, original, preview, image("between"), nextOriginal]);
    expect(result.attachments).toHaveLength(2);
    const payloads = result.attachments.map((attachment) => {
      if (attachment.type !== "text") throw new Error("Expected feedback text context");
      return JSON.parse(attachment.text);
    });
    expect(payloads[0]).toEqual({
      schemaVersion: "omp-visual-feedback-1",
      coordinateSpace: "original-image-pixels",
      text: first.text,
      feedback: first.feedback,
      image: { width: 2560, height: 1440, attachment: "original", imageNumber: 2 },
      preview: { width: 1280, height: 720, attachment: "annotated", imageNumber: 3 },
      annotations: [
        {
          number: 1,
          id: "point",
          kind: "point",
          x: 2048,
          y: 1024,
          text: "  First note\n完整内容  ",
        },
        { number: 2, id: "rect", kind: "rectangle", x: 30, y: 40, width: 90, height: 60, text: "" },
        { number: 3, id: "arrow", kind: "arrow", x: 100, y: 200, x2: 400, y2: 500, text: "Arrow" },
        {
          number: 4,
          id: "pen",
          kind: "pen",
          points: [
            { x: 12.5, y: 25.25 },
            { x: 600, y: 700 },
          ],
          text: "Freehand",
        },
      ],
    });
    expect(payloads[1]).toMatchObject({
      image: { width: 800, height: 600, attachment: "original", imageNumber: 5 },
      preview: null,
      annotations: [{ number: 1, text: "Second note" }],
    });
  });

  it("preserves feedback without an original image, including a preview-only card", () => {
    const preview = image("preview-only");
    const result = splitComposerAttachmentsForSubmit([
      {
        kind: "visual_feedback",
        id: "text-only",
        text: "",
        feedback: "  No screenshot supplied  ",
        annotations: [],
      },
      {
        kind: "visual_feedback",
        id: "preview-only",
        text: "Body",
        feedback: "",
        annotations: [],
        preview: { metadata: preview, width: 120, height: 80 },
      },
    ]);

    expect(result.images).toEqual([preview]);
    const payloads = result.attachments.map((attachment) => {
      if (attachment.type !== "text") throw new Error("Expected feedback text context");
      return JSON.parse(attachment.text);
    });
    expect(payloads[0]).toMatchObject({
      text: "",
      feedback: "  No screenshot supplied  ",
      image: null,
      preview: null,
      annotations: [],
    });
    expect(payloads[1]).toMatchObject({
      image: null,
      preview: { width: 120, height: 80, attachment: "annotated", imageNumber: 1 },
    });
  });
  it("preserves a legacy element draft's text and screenshot when it is submitted", () => {
    const screenshot = {
      id: "existing-screenshot",
      mimeType: "image/png",
      storageType: "desktop-file" as const,
      storageKey: "/saved/screenshot.png",
      createdAt: 1,
    };
    const result = splitComposerAttachmentsForSubmit([
      {
        kind: "browser_element",
        attachment: {
          url: "https://example.com",
          selector: "#save",
          tag: "button",
          text: "Save",
          outerHTML: "<button>Save</button>",
          computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 10, height: 10 },
          reactSource: null,
          parentChain: [],
          children: [],
          screenshot,
          formatted: "Save button on the previous page",
        },
      },
    ]);

    expect(result.images).toEqual([screenshot]);
    expect(result.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "Browser element · button",
        text: "Save button on the previous page",
      },
    ]);
  });
});
