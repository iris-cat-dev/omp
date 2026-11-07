import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { z } from "zod";
import type { FastModeTier } from "@/agent-controls/policy";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export interface ModelUsageSelection {
  serverId: string;
  provider: string;
  modelId: string;
  thinkingOptionId: string | null;
  speed: FastModeTier | null;
}

export interface ModelUsageEntry extends ModelUsageSelection {
  key: string;
  useCount: number;
  lastUsedAt: number;
}

interface ModelUsagePersistedState {
  entries: ModelUsageEntry[];
}

interface ModelUsageStoreState extends ModelUsagePersistedState {
  recordUsage: (selection: ModelUsageSelection) => void;
  removeUsage: (key: string) => void;
}

export function getModelUsageKey(selection: ModelUsageSelection): string {
  return JSON.stringify([
    selection.serverId,
    selection.provider,
    selection.modelId,
    selection.thinkingOptionId,
    selection.speed,
  ]);
}

const ModelUsageEntrySchema = z
  .strictObject({
    serverId: z.string(),
    provider: z.string(),
    modelId: z.string(),
    thinkingOptionId: z.string().nullable(),
    speed: z.enum(["off", "on", "ultrafast"]).nullable(),
    key: z.string(),
    useCount: z.number().int().positive(),
    lastUsedAt: z.number().int().nonnegative(),
  })
  .refine((entry) => entry.key === getModelUsageKey(entry));

const ModelUsagePersistedStateSchema: z.ZodType<ModelUsagePersistedState> = z.strictObject({
  entries: z
    .array(ModelUsageEntrySchema)
    .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length),
});

function sortEntries(entries: ModelUsageEntry[]): ModelUsageEntry[] {
  return entries.sort((a, b) => {
    const ranked = b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt;
    if (ranked) return ranked;
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });
}

type UsageOperation = { type: "record"; entry: ModelUsageEntry } | { type: "remove"; key: string };

function applyOperation(
  entries: readonly ModelUsageEntry[],
  operation: UsageOperation,
): ModelUsageEntry[] {
  if (operation.type === "remove") {
    return entries.filter((entry) => entry.key !== operation.key);
  }
  const recorded = operation.entry;
  const existing = entries.find((entry) => entry.key === recorded.key);
  return sortEntries([
    ...entries.filter((entry) => entry.key !== recorded.key),
    { ...recorded, useCount: (existing?.useCount ?? 0) + 1 },
  ]);
}

const STORAGE_KEY = "model-usage-history";
const validatedStorage = createValidatedPersistStorage(
  AsyncStorage,
  ModelUsagePersistedStateSchema,
);
let hydrating = false;
let hydrationBase: ModelUsageEntry[] = [];
let hydrationOperations: UsageOperation[] = [];

// AsyncStorage can finish its initial read after the user has already selected or deleted a row.
// Keep those operations visible immediately, but do not overwrite unread history with local state.
const storage: PersistStorage<ModelUsagePersistedState> = {
  getItem: (name) => validatedStorage.getItem(name),
  setItem: (name, value) => {
    if (!hydrating) return validatedStorage.setItem(name, value);
  },
  removeItem: (name) => validatedStorage.removeItem(name),
};

export const useModelUsageStore = create<ModelUsageStoreState>()(
  persist<ModelUsageStoreState, [], [], ModelUsagePersistedState>(
    (set) => {
      const apply = (operation: UsageOperation) => {
        if (hydrating) hydrationOperations.push(operation);
        set((state) => ({ entries: applyOperation(state.entries, operation) }));
      };
      return {
        entries: [],
        recordUsage: (selection) => {
          const { serverId, provider, modelId, thinkingOptionId, speed } = selection;
          apply({
            type: "record",
            entry: {
              serverId,
              provider,
              modelId,
              thinkingOptionId,
              speed,
              key: getModelUsageKey(selection),
              useCount: 1,
              lastUsedAt: Date.now(),
            },
          });
        },
        removeUsage: (key) => apply({ type: "remove", key }),
      };
    },
    {
      name: STORAGE_KEY,
      storage,
      partialize: (state) => ({ entries: state.entries }),
      merge: (persistedState, currentState) => {
        const result = ModelUsagePersistedStateSchema.safeParse(persistedState);
        let entries = sortEntries([...(result.success ? result.data.entries : hydrationBase)]);
        const operations = hydrationOperations;
        hydrationOperations = [];
        for (const operation of operations) entries = applyOperation(entries, operation);
        return { ...currentState, entries };
      },
      onRehydrateStorage: (state) => {
        hydrating = true;
        hydrationBase = state.entries;
        return (restoredState) => {
          hydrating = false;
          hydrationBase = [];
          hydrationOperations = [];
          if (restoredState) {
            void storage.setItem(STORAGE_KEY, {
              state: { entries: restoredState.entries },
              version: 0,
            });
          }
        };
      },
    },
  ),
);
