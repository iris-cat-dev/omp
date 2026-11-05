import { describe, expect, it } from "vitest";
import { areAttachmentsEqual, hasDraftContent, resolveDraftKey } from "./input-draft-core";
import type { ComposerAttachment } from "@/attachments/types";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
} from "@/provider-selection/provider-selection";

describe("resolveDraftKey", () => {
  it("returns a string draft key unchanged", () => {
    expect(
      resolveDraftKey({
        draftKey: "draft:key",
        selectedServerId: "host-1",
      }),
    ).toBe("draft:key");
  });

  it("resolves a computed draft key from the selected server", () => {
    expect(
      resolveDraftKey({
        draftKey: ({ selectedServerId }) => `draft:${selectedServerId ?? "none"}`,
        selectedServerId: "host-1",
      }),
    ).toBe("draft:host-1");
  });
});

describe("hasDraftContent", () => {
  it("preserves whitespace-only text while the user is editing", () => {
    expect(hasDraftContent({ text: "\n\n\n\n\n", attachments: [] })).toBe(true);
  });
});

describe("areAttachmentsEqual", () => {
  const image: Extract<ComposerAttachment, { kind: "image" }> = {
    kind: "image",
    metadata: {
      id: "image-1",
      mimeType: "image/png",
      storageType: "inline-data",
      storageKey: "original-bytes",
      createdAt: 1,
    },
  };
  const context: Extract<ComposerAttachment, { kind: "chat_history" }> = {
    kind: "chat_history",
    id: "history-1",
    attachment: { type: "text", mimeType: "text/plain", text: "Earlier messages" },
    source: { serverId: "host", agentId: "agent" },
  };
  const review: Extract<ComposerAttachment, { kind: "review" }> = {
    kind: "review",
    reviewDraftKey: "review-1",
    commentCount: 0,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      comments: [],
    },
  };

  it("compares reconstructed readonly attachments by content while preserving their order", () => {
    const left: readonly ComposerAttachment[] = [image, context, review];
    expect(areAttachmentsEqual({ left, right: structuredClone(left) })).toBe(true);
    expect(areAttachmentsEqual({ left: [], right: [] })).toBe(true);
    expect(areAttachmentsEqual({ left, right: [review, context, image] })).toBe(false);
    expect(areAttachmentsEqual({ left, right: [image, context] })).toBe(false);
  });

  it("does not mistake changed nested image or workspace-file content for the submitted draft", () => {
    expect(
      areAttachmentsEqual({
        left: [image],
        right: [{ ...image, metadata: { ...image.metadata, storageKey: "replacement-bytes" } }],
      }),
    ).toBe(false);
    expect(
      areAttachmentsEqual({
        left: [{ kind: "workspace_file", path: "index.ts", selection: { kind: "whole_file" } }],
        right: [
          {
            kind: "workspace_file",
            path: "index.ts",
            selection: { kind: "line_range", startLine: 1, endLine: 3 },
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps workspace context and review ownership and payload semantics", () => {
    expect(
      areAttachmentsEqual({
        left: [context],
        right: [{ ...context, attachment: { ...context.attachment, text: "New context" } }],
      }),
    ).toBe(false);
    expect(
      areAttachmentsEqual({
        left: [context],
        right: [{ ...context, source: { ...context.source, agentId: "other-agent" } }],
      }),
    ).toBe(false);
    expect(
      areAttachmentsEqual({
        left: [review],
        right: [{ ...review, reviewDraftKey: "other-review" }],
      }),
    ).toBe(false);
    expect(
      areAttachmentsEqual({
        left: [review],
        right: [{ ...review, attachment: { ...review.attachment, cwd: "/other-repo" } }],
      }),
    ).toBe(false);
  });
});

describe("resolveEffectiveComposerModelId", () => {
  it("returns the selected model trimmed", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "  gpt-5.4-mini  ",
        modeId: "",
        thinkingOptionId: "",
        availableModels: [],
        modeOptions: [],
      }),
    ).toBe("gpt-5.4-mini");
  });

  it("returns empty string when no model selected", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "",
        modeId: "",
        thinkingOptionId: "",
        availableModels: [],
        modeOptions: [],
      }),
    ).toBe("");
  });

  it("falls back to the provider default model when no model is selected", () => {
    expect(
      resolveEffectiveComposerModelId({
        provider: "codex",
        modelId: "",
        modeId: "",
        thinkingOptionId: "",
        availableModels: [
          { provider: "codex", id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
          { provider: "codex", id: "gpt-5.4", label: "gpt-5.4", isDefault: true },
        ],
        modeOptions: [],
      }),
    ).toBe("gpt-5.4");
  });
});

describe("resolveEffectiveComposerThinkingOptionId", () => {
  const models = [
    {
      provider: "codex",
      id: "gpt-5.4",
      label: "gpt-5.4",
      isDefault: true,
      defaultThinkingOptionId: "high",
      thinkingOptions: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
  ];

  it("prefers the selected thinking option when present", () => {
    expect(
      resolveEffectiveComposerThinkingOptionId(
        {
          provider: "codex",
          modelId: "gpt-5.4",
          modeId: "",
          thinkingOptionId: "medium",
          availableModels: models,
          modeOptions: [],
        },
        "gpt-5.4",
      ),
    ).toBe("medium");
  });

  it("falls back to the model default thinking option", () => {
    expect(
      resolveEffectiveComposerThinkingOptionId(
        {
          provider: "codex",
          modelId: "gpt-5.4",
          modeId: "",
          thinkingOptionId: "",
          availableModels: models,
          modeOptions: [],
        },
        "gpt-5.4",
      ),
    ).toBe("high");
  });
});

describe("buildDraftComposerCommandConfig", () => {
  it("returns undefined when cwd is empty", () => {
    expect(
      buildDraftCommandConfig({
        selection: {
          provider: "codex",
          modelId: "gpt-5.4",
          modeId: "",
          thinkingOptionId: "",
          availableModels: [],
          modeOptions: [],
        },
        cwd: "  ",
        effectiveModelId: "gpt-5.4",
        effectiveThinkingOptionId: "high",
      }),
    ).toBeUndefined();
  });

  it("builds the draft command config from derived composer state", () => {
    expect(
      buildDraftCommandConfig({
        selection: {
          provider: "codex",
          modelId: "gpt-5.4",
          modeId: "auto",
          thinkingOptionId: "high",
          availableModels: [],
          modeOptions: [{ id: "auto", label: "Auto" }],
        },
        cwd: "/repo",
        effectiveModelId: "gpt-5.4",
        effectiveThinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });
});
