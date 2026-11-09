import { create } from "zustand";
import { persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import equal from "fast-deep-equal";
import type {
  AttachmentMetadata,
  DirectoryComposerAttachment,
  WorkspaceFileComposerAttachment,
} from "@/attachments/types";
import { appendDirectoryAttachment } from "@/attachments/directory";
import { appendWorkspaceFileAttachment } from "@/attachments/workspace-file";
import {
  garbageCollectAttachments,
  persistAttachmentFromDataUrl,
  persistAttachmentFromFileUri,
} from "@/attachments/service";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { getComposerAttachmentImages } from "@/attachments/composer-images";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import {
  applyClearDraftRecord,
  collectReferencedAttachmentIdsFromState,
  DRAFT_STORE_VERSION,
  isAttachmentMetadata,
  isCanonicalDraftInput,
  isLegacyDraftImage,
  normalizeComposerAttachment,
  pruneFinalizedDraftRecords,
  toDraftInputIfReady,
  type DraftInput,
  type DraftLifecycleState,
  type DraftRecord,
  type DraftStoreState,
} from "./state";
import {
  migrateDraftInput,
  migratePersistedState,
  type MigrateLegacyImages,
  PersistedDraftStoreSchema,
} from "./migration";
import { createDraftPersistStorage } from "./persistence";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type { DraftInput, DraftLifecycleState } from "./state";

interface DraftStoreActions {
  getDraftInput: (draftKey: string) => DraftInput | undefined;
  hydrateDraftInput: (input: { draftKey: string }) => Promise<DraftInput | undefined>;
  saveDraftInput: (input: { draftKey: string; draft: DraftInput }) => void;
  markDraftLifecycle: (input: { draftKey: string; lifecycle: DraftLifecycleState }) => void;
  clearDraftInput: (input: {
    draftKey: string;
    lifecycle?: Exclude<DraftLifecycleState, "active">;
  }) => void;
  attachWorkspaceFile: (input: {
    draftKey: string;
    attachment: WorkspaceFileComposerAttachment;
  }) => Promise<void>;
  attachDirectory: (input: {
    draftKey: string;
    attachment: DirectoryComposerAttachment;
  }) => Promise<void>;
  getCreateModalDraft: () => DraftInput | null;
  saveCreateModalDraft: (draft: DraftInput | null) => void;
  collectActiveAttachmentIds: () => string[];
}

interface DraftStoreRuntimeState {
  attachmentFocusRequestByDraftKey: Record<string, number>;
}

type DraftStore = DraftStoreState & DraftStoreRuntimeState & DraftStoreActions;

let gcScheduled = false;
const draftPersistStorage = createDraftPersistStorage(
  createValidatedPersistStorage(AsyncStorage, PersistedDraftStoreSchema),
);

export function flushDraftPersistStorage(): Promise<void> {
  return draftPersistStorage?.flush() ?? Promise.resolve();
}

function createDraftRecord(input: {
  draft: DraftInput;
  lifecycle: DraftLifecycleState;
  previousVersion?: number;
}): DraftRecord {
  return {
    input: {
      text: input.draft.text,
      attachments: input.draft.attachments.map(normalizeComposerAttachment),
    },
    lifecycle: input.lifecycle,
    updatedAt: Date.now(),
    version: (input.previousVersion ?? 0) + 1,
  };
}

function attachmentReferencesChanged(
  previous: DraftRecord | null | undefined,
  next: DraftRecord | null,
): boolean {
  if (previous?.lifecycle === "active" && !Array.isArray(previous.input.attachments)) {
    return true;
  }
  if (!previous?.input.attachments?.length && !next?.input.attachments.length) {
    return false;
  }
  const previousIds = new Set<string>();
  const nextIds = new Set<string>();
  for (const [record, ids] of [
    [previous, previousIds],
    [next, nextIds],
  ] as const) {
    if (record?.lifecycle !== "active") continue;
    for (const attachment of record.input.attachments ?? []) {
      for (const image of getComposerAttachmentImages(attachment)) {
        ids.add(image.id);
      }
    }
  }
  if (previousIds.size !== nextIds.size) return true;
  for (const id of previousIds) {
    if (!nextIds.has(id)) return true;
  }
  return false;
}

const migrateLegacyImages: MigrateLegacyImages = async (images) => {
  if (images.length === 0) {
    return [];
  }

  const migrated = await Promise.all(
    images.map(async (entry) => {
      if (isAttachmentMetadata(entry)) {
        return entry;
      }
      if (!isLegacyDraftImage(entry)) {
        return null;
      }

      try {
        if (entry.uri.startsWith("data:")) {
          return await persistAttachmentFromDataUrl({
            dataUrl: entry.uri,
            mimeType: entry.mimeType,
          });
        }

        return await persistAttachmentFromFileUri({
          uri: entry.uri,
          mimeType: entry.mimeType,
        });
      } catch (error) {
        console.warn("[DraftStore] Failed to migrate legacy draft attachment", {
          uri: entry.uri,
          error,
        });
        return null;
      }
    }),
  );

  return migrated.filter((entry): entry is AttachmentMetadata => entry !== null);
};

async function runAttachmentGc(): Promise<void> {
  gcScheduled = false;
  const nowMs = Date.now();

  const state = useDraftStore.getState();
  const prunedDrafts = pruneFinalizedDraftRecords({ drafts: state.drafts, nowMs });
  if (prunedDrafts !== state.drafts) {
    useDraftStore.setState({ drafts: prunedDrafts });
  }

  const referencedIds = new Set<string>();
  for (const id of useDraftStore.getState().collectActiveAttachmentIds()) {
    referencedIds.add(id);
  }
  for (const id of collectRetainedAttachmentIds()) {
    referencedIds.add(id);
  }

  const pendingByDraftId = useCreateFlowStore.getState().pendingByDraftId;
  for (const pendingCreate of Object.values(pendingByDraftId)) {
    if (pendingCreate.lifecycle !== "active" || !pendingCreate.images) {
      continue;
    }
    for (const image of pendingCreate.images) {
      referencedIds.add(image.id);
    }
  }

  const sessions = useSessionStore.getState().sessions;
  for (const session of Object.values(sessions)) {
    collectQueuedMessageAttachmentIds(session, referencedIds);
    collectStreamUserImageIds(session.agentStreamTail, referencedIds);
    collectStreamUserImageIds(session.agentStreamHead, referencedIds);
  }

  // Browser-element screenshots live in the workspace attachment store, not in
  // drafts, so collect their ids here to keep them from being garbage collected
  // before the user sends the message.
  const attachmentsByScope = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
  for (const attachments of Object.values(attachmentsByScope)) {
    for (const attachment of attachments) {
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        referencedIds.add(attachment.attachment.screenshot.id);
      }
    }
  }

  try {
    await garbageCollectAttachments({ referencedIds });
  } catch (error) {
    console.warn("[DraftStore] Attachment garbage collection failed", error);
  }
}

function collectQueuedMessageAttachmentIds(
  session: SessionState,
  referencedIds: Set<string>,
): void {
  for (const queue of session.queuedMessages.values()) {
    for (const queuedMessage of queue) {
      for (const attachment of queuedMessage.attachments) {
        for (const image of getComposerAttachmentImages(attachment)) {
          referencedIds.add(image.id);
        }
      }
    }
  }
}

function collectStreamUserImageIds(
  streams: SessionState["agentStreamTail"],
  referencedIds: Set<string>,
): void {
  for (const stream of streams.values()) {
    for (const item of stream) {
      if (item.kind !== "user_message") continue;
      for (const image of item.images ?? []) {
        referencedIds.add(image.id);
      }
    }
  }
}

function scheduleAttachmentGc(): void {
  if (gcScheduled) {
    return;
  }
  gcScheduled = true;
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      void runAttachmentGc();
    });
    return;
  }
  setTimeout(() => {
    void runAttachmentGc();
  }, 0);
}

async function migrateAllLegacyDrafts(): Promise<void> {
  const state = useDraftStore.getState();
  const keys = Object.entries(state.drafts)
    .filter(([, record]) => record.lifecycle === "active" && !isCanonicalDraftInput(record.input))
    .map(([draftKey]) => draftKey);

  for (const draftKey of keys) {
    try {
      await state.hydrateDraftInput({ draftKey });
    } catch (error) {
      console.warn("[DraftStore] Failed to migrate draft during startup", {
        draftKey,
        error,
      });
    }
  }
}

export const useDraftStore = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},

      getDraftInput: (draftKey) => {
        const record = get().drafts[draftKey];
        return toDraftInputIfReady(record);
      },

      hydrateDraftInput: async ({ draftKey }) => {
        const current = get().drafts[draftKey];
        if (!current) {
          return undefined;
        }
        if (current.lifecycle !== "active") {
          return undefined;
        }
        const ready = toDraftInputIfReady(current);
        if (ready) {
          return ready;
        }

        const migratedDraft = await migrateDraftInput(
          { rawInput: current.input },
          { migrateLegacyImages },
        );

        const existing = get().drafts[draftKey];
        if (!existing || existing.version !== current.version) {
          return migratedDraft;
        }
        set((state) => ({
          drafts: {
            ...state.drafts,
            [draftKey]: createDraftRecord({
              draft: migratedDraft,
              lifecycle: existing.lifecycle,
              previousVersion: existing.version,
            }),
          },
        }));

        scheduleAttachmentGc();
        return migratedDraft;
      },

      saveDraftInput: ({ draftKey, draft }) => {
        const existing = get().drafts[draftKey];
        const next = createDraftRecord({
          draft,
          lifecycle: "active",
          previousVersion: existing?.version,
        });
        if (existing?.lifecycle === "active" && equal(existing.input, next.input)) {
          return;
        }
        set((state) => ({
          drafts: { ...state.drafts, [draftKey]: next },
        }));
        if (attachmentReferencesChanged(existing, next)) {
          scheduleAttachmentGc();
        }
      },

      markDraftLifecycle: ({ draftKey, lifecycle }) => {
        const existing = get().drafts[draftKey];
        if (!existing || existing.lifecycle === lifecycle) {
          return;
        }
        set((state) => ({
          drafts: {
            ...state.drafts,
            [draftKey]: {
              ...existing,
              lifecycle,
              updatedAt: Date.now(),
              version: existing.version + 1,
            },
          },
        }));
        scheduleAttachmentGc();
      },

      clearDraftInput: ({ draftKey, lifecycle }) => {
        if (!get().drafts[draftKey] && !lifecycle) {
          return;
        }
        set((state) => {
          const existing = state.drafts[draftKey];
          if (!existing) {
            return lifecycle
              ? {
                  drafts: {
                    ...state.drafts,
                    [draftKey]: createDraftRecord({
                      draft: { text: "", attachments: [] },
                      lifecycle,
                    }),
                  },
                }
              : state;
          }
          const cleared = applyClearDraftRecord({
            record: existing,
            lifecycle,
            nowMs: Date.now(),
          });
          if (cleared) {
            return {
              drafts: {
                ...state.drafts,
                [draftKey]: cleared,
              },
            };
          }
          const nextDrafts = { ...state.drafts };
          delete nextDrafts[draftKey];
          return { drafts: nextDrafts };
        });

        scheduleAttachmentGc();
      },

      attachWorkspaceFile: async ({ draftKey, attachment }) => {
        await get().hydrateDraftInput({ draftKey });
        set((state) => {
          const existing = state.drafts[draftKey];
          const draft = toDraftInputIfReady(existing) ?? { text: "", attachments: [] };
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: {
                  ...draft,
                  attachments: appendWorkspaceFileAttachment(draft.attachments, attachment),
                },
                lifecycle: "active",
                previousVersion: existing?.version,
              }),
            },
            attachmentFocusRequestByDraftKey: {
              ...state.attachmentFocusRequestByDraftKey,
              [draftKey]: (state.attachmentFocusRequestByDraftKey[draftKey] ?? 0) + 1,
            },
          };
        });
      },

      attachDirectory: async ({ draftKey, attachment }) => {
        await get().hydrateDraftInput({ draftKey });
        set((state) => {
          const existing = state.drafts[draftKey];
          const draft = toDraftInputIfReady(existing) ?? { text: "", attachments: [] };
          return {
            drafts: {
              ...state.drafts,
              [draftKey]: createDraftRecord({
                draft: {
                  ...draft,
                  attachments: appendDirectoryAttachment(draft.attachments, attachment),
                },
                lifecycle: "active",
                previousVersion: existing?.version,
              }),
            },
            attachmentFocusRequestByDraftKey: {
              ...state.attachmentFocusRequestByDraftKey,
              [draftKey]: (state.attachmentFocusRequestByDraftKey[draftKey] ?? 0) + 1,
            },
          };
        });
      },

      getCreateModalDraft: () => {
        const record = get().createModalDraft;
        return toDraftInputIfReady(record) ?? null;
      },

      saveCreateModalDraft: (draft) => {
        const existing = get().createModalDraft;
        const next = draft
          ? createDraftRecord({
              draft,
              lifecycle: "active",
              previousVersion: existing?.version,
            })
          : null;
        if (
          existing === next ||
          (existing?.lifecycle === "active" && next && equal(existing.input, next.input))
        ) {
          return;
        }
        set({ createModalDraft: next });
        if (attachmentReferencesChanged(existing, next)) {
          scheduleAttachmentGc();
        }
      },

      collectActiveAttachmentIds: () => {
        return Array.from(collectReferencedAttachmentIdsFromState(get()).values());
      },
    }),
    {
      name: "omp-desktop-drafts",
      version: DRAFT_STORE_VERSION,
      storage: draftPersistStorage,
      partialize: ({ drafts, createModalDraft }) => ({ drafts, createModalDraft }),
      migrate: (state) =>
        migratePersistedState(state, {
          migrateLegacyImages,
          nowMs: Date.now(),
        }),
      onRehydrateStorage: () => {
        return () => {
          void migrateAllLegacyDrafts();
          scheduleAttachmentGc();
        };
      },
    },
  ),
);
