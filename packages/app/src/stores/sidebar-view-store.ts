import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { workspaceLabelKey } from "@omp-desktop/protocol/workspace-labels";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { TouchInteractionPreference } from "@/utils/device-input";

export type SidebarGroupMode = "project" | "status";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 9;

/**
 * The key standing for "this workspace carries no labels at all".
 *
 * `normalizeWorkspaceLabelName` trims, so no real label can ever normalize to the empty string
 * and nothing in `labels` can collide with it. That is the whole reason the empty string is the
 * choice: a sentinel like `"__unlabelled__"` would be a name a person is free to type.
 */
export const SIDEBAR_UNLABELLED_LABEL_KEY = "";

/**
 * What the sidebar's Labels page currently says.
 *
 * The labels pinned to, keyed by `workspaceLabelKey`, exactly as `hostFilters` holds server ids:
 * empty means "every label", non-empty includes workspaces carrying any selected label.
 */
export interface SidebarLabelFilter {
  labels: string[];
}

export function hasActiveSidebarLabelFilter(filter: SidebarLabelFilter): boolean {
  return filter.labels.length > 0;
}

/**
 * Include/exclude toggle over the host allowlist.
 *
 * Project visibility has inverse semantics (checked means visible), so it is handled by
 * `toggleProjectVisibility` instead of sharing this operation.
 */
function toggleFilterEntry(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

interface SidebarViewStoreState {
  groupMode: SidebarGroupMode;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  /** Project view keys hidden from the sidebar until explicitly restored. */
  hiddenProjectViewKeys: string[];
  labelFilter: SidebarLabelFilter;
  /** Local per-device override for touch-sized sidebar/menu interaction density. */
  touchMode: TouchInteractionPreference;
  /** Transient touch reorder mode exposing explicit drag handles instead of whole-row drag. */
  reorderMode: boolean;
  setGroupMode: (mode: SidebarGroupMode) => void;
  setTouchMode: (mode: TouchInteractionPreference) => void;
  setReorderMode: (enabled: boolean) => void;
  toggleReorderMode: () => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  hideProject: (viewKey: string) => void;
  toggleProjectVisibility: (viewKey: string) => void;
  showAllProjects: () => void;
  toggleLabelFilter: (name: string) => void;
  clearLabelFilter: () => void;
  reconcileLabelFilter: (labels: readonly string[]) => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  groupMode: SidebarGroupMode;
  hostFilters: string[];
  hiddenProjectViewKeys: string[];
  labelFilter: SidebarLabelFilter;
  touchMode: TouchInteractionPreference;
}

const PersistedSidebarGroupModeSchema = z.enum(["project", "status", "label"]);
const TouchModeSchema = z.enum(["auto", "on", "off"]);
const SidebarLabelFilterSchema = z.object({
  labels: z.array(z.string()),
});
const SidebarViewPersistedStateSchema = z.strictObject({
  groupMode: PersistedSidebarGroupModeSchema.optional(),
  hostFilters: z.array(z.string()).optional(),
  hostFilter: z.string().nullable().optional(),
  // Accepted only so v7 persisted state can migrate without discarding the remaining preferences.
  projectFilters: z.array(z.string()).optional(),
  hiddenProjectViewKeys: z.array(z.string()).optional(),
  groupModeByServerId: z.record(z.string(), PersistedSidebarGroupModeSchema).optional(),
  labelFilter: SidebarLabelFilterSchema.optional(),
  touchMode: TouchModeSchema.optional(),
});

type SidebarViewStorageState = z.infer<typeof SidebarViewPersistedStateSchema>;

function readLegacyGroupMode(persistedState: SidebarViewStorageState): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!groupModeByServerId) {
    return null;
  }

  const modes = Object.values(groupModeByServerId);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

// Reads the host filter from any persisted shape: the current `hostFilters` array, or the
// pre-v2 single `hostFilter` string (null/absent meant "all hosts").
function readHostFilters(persistedState: SidebarViewStorageState): string[] {
  const hostFilters = persistedState.hostFilters;
  if (hostFilters) {
    return hostFilters;
  }
  // COMPAT(sidebarHostFilters): added in v0.1.102, remove after 2026-12-30 once pre-v2 persisted
  // sidebar state (a single `hostFilter` string) has aged out.
  const legacyHostFilter = persistedState.hostFilter;
  return legacyHostFilter ? [legacyHostFilter] : [];
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  const result = SidebarViewPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      groupMode: "project",
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: emptyLabelFilter(),
      touchMode: "auto",
    };
  }
  const state = result.data;

  const legacyGroupMode = readLegacyGroupMode(state);
  if (legacyGroupMode) {
    return {
      groupMode: legacyGroupMode,
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: emptyLabelFilter(),
      touchMode: "auto",
    };
  }

  return {
    groupMode: state.groupMode === "status" ? "status" : "project",
    hostFilters: readHostFilters(state),
    hiddenProjectViewKeys: state.hiddenProjectViewKeys ?? [],
    labelFilter: state.labelFilter
      ? normalizeSidebarLabelFilter(state.labelFilter)
      : emptyLabelFilter(),
    touchMode: state.touchMode ?? "auto",
  };
}

/**
 * Re-keys a persisted filter through `workspaceLabelKey`, so the invariant on `labels` holds for
 * state that was written by an older build of this page rather than by the current one.
 */
function normalizeSidebarLabelFilter(filter: SidebarLabelFilter): SidebarLabelFilter {
  const labels = new Set(filter.labels.map(workspaceLabelKey));
  return { labels: [...labels] };
}

export function createSidebarViewStorage(
  backingStorage: StateStorage = AsyncStorage,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await backingStorage.getItem(name);
      if (value !== null || name !== SIDEBAR_VIEW_STORAGE_KEY) {
        return value;
      }
      return backingStorage.getItem(LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY);
    },
    setItem: (name, value) => backingStorage.setItem(name, value),
    removeItem: (name) => backingStorage.removeItem(name),
  };
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set) => ({
      groupMode: "project",
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: emptyLabelFilter(),
      touchMode: "auto",
      reorderMode: false,
      setGroupMode: (mode) =>
        set((state) => ({
          groupMode: mode,
          reorderMode: mode === "project" ? state.reorderMode : false,
        })),
      setTouchMode: (mode) =>
        set((state) => ({
          touchMode: mode,
          reorderMode: mode === "off" ? false : state.reorderMode,
        })),
      setReorderMode: (enabled) => set({ reorderMode: enabled }),
      toggleReorderMode: () => set((state) => ({ reorderMode: !state.reorderMode })),
      toggleHostFilter: (serverId) =>
        set((state) => ({ hostFilters: toggleFilterEntry(state.hostFilters, serverId) })),
      clearHostFilters: () => set({ hostFilters: [] }),
      hideProject: (viewKey) =>
        set((state) =>
          state.hiddenProjectViewKeys.includes(viewKey)
            ? state
            : { hiddenProjectViewKeys: [...state.hiddenProjectViewKeys, viewKey] },
        ),
      toggleProjectVisibility: (viewKey) =>
        set((state) => ({
          hiddenProjectViewKeys: toggleFilterEntry(state.hiddenProjectViewKeys, viewKey),
        })),
      showAllProjects: () => set({ hiddenProjectViewKeys: [] }),
      toggleLabelFilter: (name) =>
        set((state) => {
          const key = workspaceLabelKey(name);
          const labels = state.labelFilter.labels.includes(key)
            ? state.labelFilter.labels.filter((label) => label !== key)
            : [...state.labelFilter.labels, key];
          return { labelFilter: { ...state.labelFilter, labels } };
        }),
      clearLabelFilter: () => set({ labelFilter: emptyLabelFilter() }),
      reconcileLabelFilter: (labels) =>
        set((state) => {
          const available = new Set(labels.map(workspaceLabelKey));
          const next = state.labelFilter.labels.filter(
            (label) => label === SIDEBAR_UNLABELLED_LABEL_KEY || available.has(label),
          );
          if (next.length === state.labelFilter.labels.length) return state;
          return { labelFilter: { labels: next } };
        }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return { hostFilters: next };
        }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createValidatedPersistStorage(
        createSidebarViewStorage(),
        SidebarViewPersistedStateSchema,
      ),
      partialize: (state) => ({
        groupMode: state.groupMode,
        hostFilters: state.hostFilters,
        hiddenProjectViewKeys: state.hiddenProjectViewKeys,
        labelFilter: state.labelFilter,
        touchMode: state.touchMode,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);

function emptyLabelFilter(): SidebarLabelFilter {
  return { labels: [] };
}
