import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelUsageEntry, ModelUsageSelection, useModelUsageStore } from "./model-usage-store";

const backing = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn<(name: string) => Promise<string | null>>(),
  setItem: vi.fn<(name: string, value: string) => Promise<void>>(),
  removeItem: vi.fn<(name: string) => Promise<void>>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: backing.getItem,
    setItem: backing.setItem,
    removeItem: backing.removeItem,
  },
}));

const selection: ModelUsageSelection = {
  serverId: "server-a",
  provider: "provider-a",
  modelId: "model-a",
  thinkingOptionId: "high",
  speed: "off",
};

function importFreshStore() {
  // Static imports cannot recreate the singleton's initial AsyncStorage hydration after resetModules.
  return import("./model-usage-store");
}

function waitForHydration(store: typeof useModelUsageStore): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = store.persist.onFinishHydration(() => {
    unsubscribe();
    resolve();
  });
  return promise;
}

async function loadStore() {
  const module = await importFreshStore();
  await waitForHydration(module.useModelUsageStore);
  return module;
}

function persistedEntries(): ModelUsageEntry[] {
  const raw = backing.values.get("model-usage-history");
  expect(raw).toBeDefined();
  return JSON.parse(raw!).state.entries;
}

function seed(entries: ModelUsageEntry[]) {
  backing.values.set("model-usage-history", JSON.stringify({ state: { entries }, version: 0 }));
}

beforeEach(() => {
  vi.resetModules();
  backing.values.clear();
  backing.getItem.mockReset().mockImplementation(async (name) => backing.values.get(name) ?? null);
  backing.setItem.mockReset().mockImplementation(async (name, value) => {
    backing.values.set(name, value);
  });
  backing.removeItem.mockReset().mockImplementation(async (name) => {
    backing.values.delete(name);
  });
  vi.spyOn(Date, "now").mockReturnValue(100);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model usage history", () => {
  it("counts exact combinations independently across every selection dimension", async () => {
    const { useModelUsageStore, getModelUsageKey } = await loadStore();
    const variants: ModelUsageSelection[] = [
      selection,
      { ...selection, serverId: "server-b" },
      { ...selection, provider: "provider-b" },
      { ...selection, modelId: "model-b" },
      { ...selection, thinkingOptionId: "low" },
      { ...selection, thinkingOptionId: null },
      { ...selection, speed: "on" },
      { ...selection, speed: "ultrafast" },
      { ...selection, speed: null },
    ];
    for (const variant of variants) useModelUsageStore.getState().recordUsage(variant);
    vi.mocked(Date.now).mockReturnValue(200);
    useModelUsageStore.getState().recordUsage({ ...selection });

    const entries = useModelUsageStore.getState().entries;
    expect(entries).toHaveLength(variants.length);
    expect(new Set(variants.map(getModelUsageKey)).size).toBe(variants.length);
    expect(entries[0]).toEqual({
      ...selection,
      key: getModelUsageKey(selection),
      useCount: 2,
      lastUsedAt: 200,
    });
    expect(entries.slice(1).every((entry) => entry.useCount === 1)).toBe(true);
  });

  it("keeps delimiter-containing identifiers and null distinct from string values", async () => {
    const { getModelUsageKey } = await loadStore();
    const variants: ModelUsageSelection[] = [
      { ...selection, serverId: "a::b", provider: "c" },
      { ...selection, serverId: "a", provider: "b::c" },
      { ...selection, thinkingOptionId: null },
      { ...selection, thinkingOptionId: "null" },
      { ...selection, thinkingOptionId: "" },
    ];
    expect(new Set(variants.map(getModelUsageKey)).size).toBe(variants.length);
  });

  it("ranks by frequency, then recency, then a deterministic key tie-break", async () => {
    const { useModelUsageStore, getModelUsageKey } = await loadStore();
    const a = { ...selection, modelId: "a" };
    const b = { ...selection, modelId: "b" };
    const c = { ...selection, modelId: "c" };
    const record = useModelUsageStore.getState().recordUsage;
    record(b);
    record(a);
    expect(useModelUsageStore.getState().entries.map((entry) => entry.key)).toEqual([
      getModelUsageKey(a),
      getModelUsageKey(b),
    ]);
    vi.mocked(Date.now).mockReturnValue(200);
    record(b);
    vi.mocked(Date.now).mockReturnValue(300);
    record(a);
    vi.mocked(Date.now).mockReturnValue(400);
    record(c);
    expect(useModelUsageStore.getState().entries.map((entry) => entry.modelId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(useModelUsageStore.getState().entries.map((entry) => entry.useCount)).toEqual([2, 2, 1]);
  });

  it("deletes only the requested full key without mutating the caller's selection", async () => {
    const { useModelUsageStore, getModelUsageKey } = await loadStore();
    const current = Object.freeze({ ...selection });
    const otherSpeed = { ...selection, speed: "on" as const };
    const otherServer = { ...selection, serverId: "server-b" };
    const { recordUsage, removeUsage } = useModelUsageStore.getState();
    recordUsage(current);
    recordUsage(otherSpeed);
    recordUsage(otherServer);
    const kept = useModelUsageStore
      .getState()
      .entries.filter((entry) => entry.key !== getModelUsageKey(current));

    removeUsage(getModelUsageKey(current));
    expect(useModelUsageStore.getState().entries).toEqual(kept);
    expect(current).toEqual(selection);
    expect(persistedEntries()).toEqual(kept);
    removeUsage("missing-key");
    expect(useModelUsageStore.getState().entries).toEqual(kept);
  });

  it("reloads sorted persisted counts, timestamps, and deletions", async () => {
    const { useModelUsageStore, getModelUsageKey } = await loadStore();
    const removed = { ...selection, modelId: "removed" };
    const newer = { ...selection, speed: "on" as const };
    const { recordUsage, removeUsage } = useModelUsageStore.getState();
    recordUsage(selection);
    recordUsage(selection);
    recordUsage(removed);
    vi.mocked(Date.now).mockReturnValue(200);
    recordUsage(newer);
    removeUsage(getModelUsageKey(removed));
    const expected = useModelUsageStore.getState().entries;
    expect(persistedEntries()).toEqual(expected);

    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.useModelUsageStore.getState().entries).toEqual(expected);
    reloaded.useModelUsageStore.getState().recordUsage(selection);
    expect(reloaded.useModelUsageStore.getState().entries[0].useCount).toBe(3);
  });

  it("sorts an unsorted valid persisted history during hydration and persists that order", async () => {
    const { getModelUsageKey } = await loadStore();
    const entry = (modelId: string, useCount: number, lastUsedAt: number): ModelUsageEntry => {
      const combo = { ...selection, modelId };
      return { ...combo, key: getModelUsageKey(combo), useCount, lastUsedAt };
    };
    const oldest = entry("a", 1, 100);
    const newest = entry("b", 1, 200);
    const frequent = entry("c", 2, 50);
    seed([oldest, newest, frequent]);
    vi.resetModules();

    const { useModelUsageStore } = await loadStore();
    expect(useModelUsageStore.getState().entries).toEqual([frequent, newest, oldest]);
    expect(persistedEntries()).toEqual([frequent, newest, oldest]);
  });

  it("replays selections and deletions made during an async read without losing persisted history", async () => {
    const { getModelUsageKey } = await loadStore();
    const removed = { ...selection, modelId: "removed" };
    const untouched = { ...selection, serverId: "server-b" };
    seed(
      [selection, removed, untouched].map((combo) => ({
        serverId: combo.serverId,
        provider: combo.provider,
        modelId: combo.modelId,
        thinkingOptionId: combo.thinkingOptionId,
        speed: combo.speed,
        key: getModelUsageKey(combo),
        useCount: 4,
        lastUsedAt: 50,
      })),
    );
    const saved = backing.values.get("model-usage-history")!;
    const { promise: read, resolve: finishRead } = Promise.withResolvers<string>();
    backing.getItem.mockImplementationOnce(() => read);
    backing.setItem.mockClear();
    vi.resetModules();
    const { useModelUsageStore } = await importFreshStore();
    const { recordUsage, removeUsage } = useModelUsageStore.getState();
    recordUsage(selection);
    recordUsage(selection);
    removeUsage(getModelUsageKey(removed));
    expect(useModelUsageStore.getState().entries[0].useCount).toBe(2);
    expect(backing.setItem).not.toHaveBeenCalled();
    expect(backing.values.get("model-usage-history")).toBe(saved);

    const finished = waitForHydration(useModelUsageStore);
    finishRead(saved);
    await finished;
    expect(useModelUsageStore.getState().entries).toEqual([
      { ...selection, key: getModelUsageKey(selection), useCount: 6, lastUsedAt: 100 },
      { ...untouched, key: getModelUsageKey(untouched), useCount: 4, lastUsedAt: 50 },
    ]);
    expect(persistedEntries()).toEqual(useModelUsageStore.getState().entries);
  });

  it("preserves remove-then-record order while hydration is pending", async () => {
    const { getModelUsageKey } = await loadStore();
    seed([{ ...selection, key: getModelUsageKey(selection), useCount: 9, lastUsedAt: 50 }]);
    const saved = backing.values.get("model-usage-history")!;
    const { promise: read, resolve: finishRead } = Promise.withResolvers<string>();
    backing.getItem.mockImplementationOnce(() => read);
    vi.resetModules();
    const { useModelUsageStore } = await importFreshStore();
    useModelUsageStore.getState().removeUsage(getModelUsageKey(selection));
    useModelUsageStore.getState().recordUsage(selection);
    const finished = waitForHydration(useModelUsageStore);
    finishRead(saved);
    await finished;
    expect(useModelUsageStore.getState().entries).toEqual([
      { ...selection, key: getModelUsageKey(selection), useCount: 1, lastUsedAt: 100 },
    ]);
  });

  it.each(["invalid-speed", "invalid-key", "duplicate-key"])(
    "rejects %s at the persisted-storage boundary",
    async (invalid) => {
      const { getModelUsageKey } = await loadStore();
      const entry = {
        ...selection,
        key: getModelUsageKey(selection),
        useCount: 1,
        lastUsedAt: 100,
      };
      const entries =
        invalid === "duplicate-key"
          ? [entry, entry]
          : [{ ...entry, ...(invalid === "invalid-speed" ? { speed: "fast" } : { key: "wrong" }) }];
      backing.values.set("model-usage-history", JSON.stringify({ state: { entries }, version: 0 }));
      backing.removeItem.mockClear();
      vi.resetModules();
      const { useModelUsageStore } = await loadStore();
      expect(useModelUsageStore.getState().entries).toEqual([]);
      expect(backing.removeItem).toHaveBeenCalledWith("model-usage-history");
    },
  );
});
