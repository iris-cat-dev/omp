import { describe, expect, it } from "vitest";
import { createDirectoryComposerAttachment } from "@/attachments/directory";
import { splitComposerAttachmentsForSubmit } from "./submit";

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
