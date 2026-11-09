import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentMetadata,
  AttachmentStore,
  VisualFeedbackComposerAttachment,
} from "@/attachments/types";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type * as DraftStoreModule from "./index";

const { persisted } = vi.hoisted(() => ({ persisted: new Map<string, string>() }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (name: string) => persisted.get(name) ?? null,
    setItem: async (name: string, value: string) => {
      persisted.set(name, value);
    },
    removeItem: async (name: string) => {
      persisted.delete(name);
    },
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("@/stores/create-flow-store", () => ({
  useCreateFlowStore: { getState: () => ({ pendingByDraftId: {} }) },
}));
vi.mock("@/attachments/workspace-attachments-store", () => ({
  useWorkspaceAttachmentsStore: { getState: () => ({ attachmentsByScope: {} }) },
}));

const files = new Map<string, AttachmentMetadata>();
const attachmentStore: AttachmentStore = {
  storageType: "web-indexeddb",
  async save() {
    throw new Error("This fixture seeds stored attachment files directly");
  },
  async encodeBase64({ attachment }) {
    if (!files.has(attachment.id)) throw new Error("Attachment was collected");
    return "aW1hZ2U=";
  },
  async resolvePreviewUrl({ attachment }) {
    if (!files.has(attachment.id)) throw new Error("Attachment was collected");
    return `blob:${attachment.id}`;
  },
  async delete({ attachment }) {
    files.delete(attachment.id);
  },
  async garbageCollect({ referencedIds }) {
    for (const id of files.keys()) {
      if (!referencedIds.has(id)) files.delete(id);
    }
  },
};
let useDraftStore: typeof DraftStoreModule.useDraftStore;
let flushDraftPersistStorage: typeof DraftStoreModule.flushDraftPersistStorage;

function image(id: string): AttachmentMetadata {
  const metadata: AttachmentMetadata = {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    createdAt: 1,
  };
  files.set(id, metadata);
  return metadata;
}
function feedback(
  original: AttachmentMetadata,
  preview: AttachmentMetadata,
): VisualFeedbackComposerAttachment {
  return {
    kind: "visual_feedback",
    id: "feedback",
    text: "Feedback body",
    feedback: "Keep the images",
    annotations: [],
    image: { metadata: original, width: 100, height: 80 },
    preview: { metadata: preview, width: 50, height: 40 },
  };
}

beforeAll(async () => {
  __setAttachmentStoreForTests(attachmentStore);
  // Import starts rehydration and GC; its owned attachment backend must already exist.
  ({ useDraftStore, flushDraftPersistStorage } = await import("./index"));
  await nextTurn();
});
beforeEach(async () => {
  __setAttachmentStoreForTests(attachmentStore);
  useDraftStore.setState({
    drafts: {},
    createModalDraft: null,
    attachmentFocusRequestByDraftKey: {},
  });
  await nextTurn();
  await flushDraftPersistStorage();
  files.clear();
  persisted.clear();
});
afterEach(async () => {
  await nextTurn();
  await flushDraftPersistStorage();
  __setAttachmentStoreForTests(null);
});

describe("draft attachment lifecycle", () => {
  it("collects replaced nested images but retains a shared image until the last draft releases it", async () => {
    const original = image("original");
    const preview = image("preview");
    const store = useDraftStore.getState();
    store.saveDraftInput({
      draftKey: "draft:feedback",
      draft: { text: "Inspect", attachments: [feedback(original, preview)] },
    });
    store.saveCreateModalDraft({
      text: "Shared",
      attachments: [{ kind: "image", metadata: original }],
    });
    await nextTurn();
    expect([...files.keys()].sort()).toEqual(["original", "preview"]);

    const replacement = image("replacement-preview");
    store.saveDraftInput({
      draftKey: "draft:feedback",
      draft: { text: "Inspect", attachments: [feedback(original, replacement)] },
    });
    await nextTurn();
    expect([...files.keys()].sort()).toEqual(["original", "replacement-preview"]);

    store.clearDraftInput({ draftKey: "draft:feedback", lifecycle: "sent" });
    await nextTurn();
    expect([...files.keys()]).toEqual(["original"]);
    store.saveCreateModalDraft(null);
    await nextTurn();
    expect([...files.keys()]).toEqual([]);
  });

  it("keeps equivalent normalized saves from superseding a draft revision and persists subsequent edits", async () => {
    const metadata = image("draft-image");
    const store = useDraftStore.getState();
    const draft = { text: "Short input", attachments: [{ kind: "image" as const, metadata }] };
    store.saveDraftInput({ draftKey: "draft:input", draft });
    const revision = useDraftStore.getState().drafts["draft:input"]!.version;
    store.saveDraftInput({
      draftKey: "draft:input",
      draft: {
        ...draft,
        attachments: [
          {
            kind: "image",
            metadata: { ...metadata, previewUri: "blob:view-only" } as AttachmentMetadata,
          },
        ],
      },
    });
    expect(useDraftStore.getState().drafts["draft:input"]!.version).toBe(revision);

    store.saveDraftInput({
      draftKey: "draft:input",
      draft: { ...draft, text: "Edited short input" },
    });
    await flushDraftPersistStorage();
    const saved = JSON.parse(persisted.get("omp-desktop-drafts")!);
    expect(saved.state.drafts["draft:input"].input).toEqual({
      ...draft,
      text: "Edited short input",
    });
    expect(useDraftStore.getState().drafts["draft:input"]!.version).toBe(revision + 1);

    store.clearDraftInput({ draftKey: "draft:input", lifecycle: "sent" });
    store.saveDraftInput({ draftKey: "draft:input", draft });
    await flushDraftPersistStorage();
    expect(useDraftStore.getState().drafts["draft:input"]!.lifecycle).toBe("active");
    expect(
      JSON.parse(persisted.get("omp-desktop-drafts")!).state.drafts["draft:input"].input,
    ).toEqual(draft);
  });
});
