import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarViewStorage,
  hasActiveSidebarLabelFilter,
  migrateSidebarViewState,
  SIDEBAR_UNLABELLED_LABEL_KEY,
  useSidebarViewStore,
} from "./sidebar-view-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

interface MemoryStorage extends StateStorage<Promise<void>> {
  reads: string[];
}

function createMemoryStorage(entries: Record<string, string | null>): MemoryStorage {
  const reads: string[] = [];
  return {
    reads,
    getItem: async (name) => {
      reads.push(name);
      return entries[name] ?? null;
    },
    setItem: async (name, value) => {
      entries[name] = value;
    },
    removeItem: async (name) => {
      entries[name] = null;
    },
  };
}

describe("sidebar view store", () => {
  beforeEach(() => {
    useSidebarViewStore.setState({
      groupMode: "project",
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: { labels: [] },
      touchMode: "auto",
      reorderMode: false,
    });
  });

  it("toggles multiple hosts into and out of the filter", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);

    store.toggleHostFilter("host-a");

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-b"]);

    store.clearHostFilters();

    expect(useSidebarViewStore.getState().hostFilters).toEqual([]);
  });

  it("keeps host filters that still point at available hosts", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("host-b");

    store.reconcileHostFilters(["host-a", "host-b", "host-c"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a", "host-b"]);
  });

  it("drops a host filter after that host is removed", () => {
    const store = useSidebarViewStore.getState();
    store.toggleHostFilter("host-a");
    store.toggleHostFilter("removed-host");

    store.reconcileHostFilters(["host-a"]);

    expect(useSidebarViewStore.getState().hostFilters).toEqual(["host-a"]);
  });

  it("migrates legacy per-host group modes to the new global mode", () => {
    expect(
      migrateSidebarViewState({
        groupModeByServerId: {
          "host-a": "project",
          "host-b": "status",
        },
      }),
    ).toEqual({
      groupMode: "status",
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: { labels: [] },
      touchMode: "auto",
    });
  });

  it("migrates a pre-v2 single host filter to the multi-host list", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilter: "host-a",
      }),
    ).toEqual({
      groupMode: "status",
      hostFilters: ["host-a"],
      hiddenProjectViewKeys: [],
      labelFilter: { labels: [] },
      touchMode: "auto",
    });
  });

  it("keeps current persisted sidebar view state during version migration", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilters: ["host-a", "host-b"],
      }),
    ).toEqual({
      groupMode: "status",
      hostFilters: ["host-a", "host-b"],
      hiddenProjectViewKeys: [],
      labelFilter: { labels: [] },
      touchMode: "auto",
    });
  });

  it("clears only the label facet", () => {
    useSidebarViewStore.setState({
      groupMode: "status",
      hostFilters: ["host-a"],
      labelFilter: { labels: ["urgent", "blocked"] },
    });

    useSidebarViewStore.getState().clearLabelFilter();

    expect(useSidebarViewStore.getState()).toMatchObject({
      groupMode: "status",
      hostFilters: ["host-a"],
      labelFilter: { labels: [] },
    });
  });

  it("toggles a label on and off under one normalized identity", () => {
    const { toggleLabelFilter } = useSidebarViewStore.getState();
    const labels = () => useSidebarViewStore.getState().labelFilter.labels;

    toggleLabelFilter("Urgent");
    expect(labels()).toEqual(["urgent"]);
    expect(hasActiveSidebarLabelFilter(useSidebarViewStore.getState().labelFilter)).toBe(true);

    toggleLabelFilter(" URGENT ");
    expect(labels()).toEqual([]);
    expect(hasActiveSidebarLabelFilter(useSidebarViewStore.getState().labelFilter)).toBe(false);
  });

  it("filters Unlabelled alongside real labels without colliding with one", () => {
    const { toggleLabelFilter } = useSidebarViewStore.getState();

    toggleLabelFilter(SIDEBAR_UNLABELLED_LABEL_KEY);
    toggleLabelFilter("Urgent");
    expect(useSidebarViewStore.getState().labelFilter).toEqual({
      labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent"],
    });
  });

  it("drops deleted labels from the active filter but retains Unlabelled", () => {
    useSidebarViewStore.setState({
      labelFilter: { labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent", "removed"] },
    });

    useSidebarViewStore.getState().reconcileLabelFilter(["Urgent"]);

    expect(useSidebarViewStore.getState().labelFilter).toEqual({
      labels: [SIDEBAR_UNLABELLED_LABEL_KEY, "urgent"],
    });
  });

  it("re-keys a persisted label filter through the normalized identity, without duplicates", () => {
    expect(
      migrateSidebarViewState({
        labelFilter: { labels: [" Urgent ", "BLOCKED", "urgent"], match: "all" },
      }).labelFilter,
    ).toEqual({ labels: ["urgent", "blocked"] });
  });

  it("hides projects from either entry point and restores them from the project menu", () => {
    const store = useSidebarViewStore.getState();

    store.hideProject("project-a");
    store.hideProject("project-a");
    store.toggleProjectVisibility("project-b");
    expect(useSidebarViewStore.getState().hiddenProjectViewKeys).toEqual([
      "project-a",
      "project-b",
    ]);

    store.toggleProjectVisibility("project-a");
    expect(useSidebarViewStore.getState().hiddenProjectViewKeys).toEqual(["project-b"]);

    store.showAllProjects();
    expect(useSidebarViewStore.getState().hiddenProjectViewKeys).toEqual([]);
  });

  // v7 persisted the former project allowlist. It is accepted during migration so the remaining
  // settings survive, but discarded because project visibility now has one inverse-semantics list.
  it("discards the obsolete project filter without losing other persisted preferences", () => {
    expect(
      migrateSidebarViewState({
        groupMode: "status",
        hostFilters: ["host-a"],
        projectFilters: ["project-a"],
        hiddenProjectViewKeys: ["project-b"],
        labelFilter: { labels: ["urgent"] },
      }),
    ).toEqual({
      groupMode: "status",
      hostFilters: ["host-a"],
      hiddenProjectViewKeys: ["project-b"],
      labelFilter: { labels: ["urgent"] },
      touchMode: "auto",
    });
  });

  it("rejects malformed legacy project filters", () => {
    expect(migrateSidebarViewState({ projectFilters: "project-a" })).toEqual({
      groupMode: "project",
      hostFilters: [],
      hiddenProjectViewKeys: [],
      labelFilter: { labels: [] },
      touchMode: "auto",
    });
  });

  it("persists touchMode preference and resets transient reorderMode when leaving project/touch modes", () => {
    expect(migrateSidebarViewState({ touchMode: "on" }).touchMode).toBe("on");
    expect(migrateSidebarViewState({ touchMode: "invalid" }).touchMode).toBe("auto");

    const store = useSidebarViewStore.getState();
    store.setTouchMode("on");
    store.setReorderMode(true);
    expect(useSidebarViewStore.getState()).toMatchObject({ touchMode: "on", reorderMode: true });

    store.setGroupMode("status");
    expect(useSidebarViewStore.getState().reorderMode).toBe(false);

    store.setGroupMode("project");
    store.toggleReorderMode();
    expect(useSidebarViewStore.getState().reorderMode).toBe(true);

    store.setTouchMode("off");
    expect(useSidebarViewStore.getState()).toMatchObject({ touchMode: "off", reorderMode: false });
  });

  it("falls back to the legacy storage key when the new key is empty", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": null,
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupModeByServerId: { "host-a": "status" } },
        version: 0,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view", "sidebar-group-mode"]);
  });

  it("uses the new storage key without reading the legacy key when current state exists", async () => {
    const storage = createMemoryStorage({
      "sidebar-view": JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
      "sidebar-group-mode": JSON.stringify({
        state: { groupModeByServerId: { "host-b": "status" } },
        version: 0,
      }),
    });

    const value = await createSidebarViewStorage(storage).getItem("sidebar-view");

    expect(value).toBe(
      JSON.stringify({
        state: { groupMode: "project", hostFilters: ["host-a"] },
        version: 2,
      }),
    );
    expect(storage.reads).toEqual(["sidebar-view"]);
  });
});
