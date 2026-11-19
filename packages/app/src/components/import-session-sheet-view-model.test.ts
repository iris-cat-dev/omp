import { describe, expect, it } from "vitest";
import type { FetchRecentProviderSessionEntry } from "@omp-desktop/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import {
  aggregateSessionEntries,
  ALL_FILTER_VALUE,
  buildProviderLabelMap,
  collectErroredProviderLabels,
  computeEmptyState,
  filterImportSessions,
  prepareImportSession,
  resolveProvidersToFetch,
  requiresImportSessionsHostUpgrade,
  type SessionsQueryResult,
  sumFilteredAlreadyImportedCount,
} from "@/components/import-session-sheet-view-model";

function entry(
  overrides: Partial<FetchRecentProviderSessionEntry> = {},
): FetchRecentProviderSessionEntry {
  return {
    providerId: "claude",
    providerLabel: "Claude Code",
    providerHandleId: "thread-1",
    cwd: "/repo/paseo",
    title: null,
    firstPromptPreview: null,
    lastPromptPreview: null,
    lastActivityAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

function settled(
  data: SessionsQueryResult["data"],
  flags?: Partial<Omit<SessionsQueryResult, "data">>,
): SessionsQueryResult {
  return {
    data,
    isError: false,
    isLoading: false,
    isPending: false,
    ...flags,
  };
}

describe("resolveProvidersToFetch", () => {
  it("returns null when the daemon does not support provider snapshots", () => {
    expect(resolveProvidersToFetch(false, [{ provider: "claude" }])).toBeNull();
  });

  it("returns null while snapshot entries have not loaded yet", () => {
    expect(resolveProvidersToFetch(true, undefined)).toBeNull();
  });

  it("returns enabled providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude" },
      { provider: "codex" },
      { provider: "opencode", enabled: false },
      { provider: "z-ai" },
    ]);
    expect(providers).toEqual(["claude", "codex", "z-ai"]);
  });

  it("returns an empty array when snapshot has no enabled providers", () => {
    const providers = resolveProvidersToFetch(true, [
      { provider: "claude", enabled: false },
      { provider: "z-ai", enabled: false },
    ]);
    expect(providers).toEqual([]);
  });
});

describe("requiresImportSessionsHostUpgrade", () => {
  it("allows home imports on hosts without workspace targeting", () => {
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: null,
        supportsWorkspaceTarget: false,
      }),
    ).toBe(false);
  });

  it("requires host support for imports opened from a workspace", () => {
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: "ws-current",
        supportsWorkspaceTarget: false,
      }),
    ).toBe(true);
    expect(
      requiresImportSessionsHostUpgrade({
        supportsSnapshot: true,
        workspaceId: "ws-current",
        supportsWorkspaceTarget: true,
      }),
    ).toBe(false);
  });
});

describe("buildProviderLabelMap", () => {
  it("returns an empty map when snapshot entries are missing", () => {
    expect(buildProviderLabelMap(undefined).size).toBe(0);
  });

  it("indexes labels by provider id, skipping entries without a label", () => {
    const labels = buildProviderLabelMap([
      { provider: "claude", label: "Claude Code" },
      { provider: "codex" },
      { provider: "z-ai", label: "Z.AI" },
    ]);
    expect(labels.get("claude")).toBe("Claude Code");
    expect(labels.get("codex")).toBeUndefined();
    expect(labels.get("z-ai")).toBe("Z.AI");
  });
});

describe("aggregateSessionEntries", () => {
  it("returns an empty array when no queries have data", () => {
    expect(aggregateSessionEntries([settled(undefined)])).toEqual([]);
  });

  it("dedupes by providerId+providerHandleId across query results", () => {
    const result = aggregateSessionEntries([
      settled({
        entries: [
          entry({ providerHandleId: "thread-1", lastActivityAt: "2026-04-30T10:00:00.000Z" }),
        ],
      }),
      settled({
        entries: [
          entry({ providerHandleId: "thread-1", lastActivityAt: "2026-04-30T11:00:00.000Z" }),
          entry({ providerHandleId: "thread-2", lastActivityAt: "2026-04-30T09:00:00.000Z" }),
        ],
      }),
    ]);
    expect(result.map((e) => e.providerHandleId)).toEqual(["thread-1", "thread-2"]);
  });

  it("sorts collected entries by lastActivityAt descending", () => {
    const result = aggregateSessionEntries([
      settled({
        entries: [
          entry({ providerHandleId: "old", lastActivityAt: "2026-04-29T10:00:00.000Z" }),
          entry({ providerHandleId: "new", lastActivityAt: "2026-04-30T10:00:00.000Z" }),
        ],
      }),
    ]);
    expect(result.map((e) => e.providerHandleId)).toEqual(["new", "old"]);
  });
});

describe("sumFilteredAlreadyImportedCount", () => {
  it("returns 0 when no queries report a filtered count", () => {
    expect(sumFilteredAlreadyImportedCount([settled({ entries: [] })])).toBe(0);
  });

  it("sums the filtered already-imported counts across queries", () => {
    const total = sumFilteredAlreadyImportedCount([
      settled({ entries: [], filteredAlreadyImportedCount: 2 }),
      settled({ entries: [], filteredAlreadyImportedCount: 3 }),
      settled(undefined),
    ]);
    expect(total).toBe(5);
  });
});

describe("collectErroredProviderLabels", () => {
  it("returns no labels when no providers are being fetched", () => {
    expect(collectErroredProviderLabels(null, [], new Map())).toEqual([]);
  });

  it("returns labels for each errored provider, falling back to provider id", () => {
    const labels = collectErroredProviderLabels(
      ["claude", "codex"],
      [settled(undefined, { isError: true }), settled({ entries: [] })],
      new Map([["claude", "Claude Code"]]),
    );
    expect(labels).toEqual(["Claude Code"]);
  });

  it("uses provider id when the label map has no entry", () => {
    const labels = collectErroredProviderLabels(
      ["codex"],
      [settled(undefined, { isError: true })],
      new Map(),
    );
    expect(labels).toEqual(["codex"]);
  });
});

describe("prepareImportSession", () => {
  it("keeps the original import target and pairs a real title with the latest prompt", () => {
    const original = entry({
      providerHandleId: "/private/session-files/thread-7.jsonl",
      title: " [123] Save ",
      firstPromptPreview: '{"title":"Earlier issue","description":"File an issue"}',
      lastPromptPreview: "  Fix the\nsave button  ",
    });
    const row = prepareImportSession(original, "Claude Code");
    expect(row.entry).toBe(original);
    expect(row).toMatchObject({ title: "[123] Save", preview: "Fix the save button" });
  });

  it("uses the first prompt as the title without repeating it as a preview", () => {
    const row = prepareImportSession(
      entry({
        title: " ",
        firstPromptPreview: "  Hello\nworld ",
        lastPromptPreview: "Hello world",
      }),
      "Claude Code",
    );
    expect(row).toMatchObject({ title: "Hello world", preview: null });
  });

  it("extracts a nested title and description even when the host cut both descriptors", () => {
    const source = JSON.stringify({
      rift: { name: "西玄域", description: "Earlier sibling, not the scene description" },
      scene: { title: "万剑无声", description: "山间的风吹动了树梢。".repeat(12) },
    });
    const firstPromptPreview = source.slice(0, 160);
    const row = prepareImportSession(
      entry({
        title: source.slice(0, 60),
        firstPromptPreview,
        lastPromptPreview: firstPromptPreview,
      }),
      "Claude Code",
    );
    expect(row.title).toBe("万剑无声");
    expect(row.preview).toBe(`${firstPromptPreview.split('"description":"').at(-1)}…`);
  });

  it("decodes complete string fields without mistaking quoted examples for real fields", () => {
    const firstPromptPreview = JSON.stringify({
      example: '{"title":"Example only"}',
      topic: { name: 'Release "Alpha"', description: "Freeze\non Friday" },
    });
    const row = prepareImportSession(entry({ firstPromptPreview }), "Claude Code");
    expect(row).toMatchObject({ title: 'Release "Alpha"', preview: "Freeze on Friday" });
  });

  it.each([
    '{"title":"unclosed',
    '{"opaque":"raw machine data"}',
    '{"opaque":"anything","title": ["not a title"]}',
    '[{"description":"\\u0',
  ])("does not turn an opaque or unfinished field into a title: %s", (title) => {
    expect(prepareImportSession(entry({ title }), "Claude Code")).toMatchObject({
      title: i18n.t("importSession.preview.untitledSession"),
      preview: null,
    });
  });

  it.each<[string, string | null]>([
    ["/home/me/project/", "project"],
    ["C:\\source\\project\\", "project"],
    ["\\\\server\\share\\project", "project"],
    ["/", "/"],
    ["", null],
  ])("uses the directory name as context for %s", (cwd, project) => {
    expect(prepareImportSession(entry({ cwd }), "Claude Code").project).toBe(project);
  });
});

describe("filterImportSessions", () => {
  const primary = prepareImportSession(
    entry({
      providerId: "custom-id",
      providerLabel: "Host label",
      title: '{"title":"Readable \\u4e66","ticket":"T-317"}',
      firstPromptPreview: "Early decisions",
      lastPromptPreview: "Revisit later",
      cwd: "/work/one/project",
    }),
    "Snapshot label",
  );
  const other = prepareImportSession(
    entry({ providerId: "codex", cwd: "/work/two/project" }),
    "Codex",
  );
  const rows = [primary, other];

  it("ANDs case-insensitive terms across the raw descriptor, decoded text and both labels", () => {
    const query = "  t-317\tEARLY   later\n书 /One/ CUSTOM-id  snapshot HOST  ";
    expect(filterImportSessions(rows, ALL_FILTER_VALUE, query)).toEqual([primary]);
    expect(filterImportSessions(rows, ALL_FILTER_VALUE, `${query} missing`)).toEqual([]);
  });

  it("intersects the provider filter with the query without changing row order", () => {
    expect(filterImportSessions(rows, ALL_FILTER_VALUE, "  ")).toEqual(rows);
    expect(filterImportSessions(rows, ALL_FILTER_VALUE, "project")).toEqual(rows);
    expect(filterImportSessions(rows, "codex", "project")).toEqual([other]);
    expect(filterImportSessions(rows, "codex", "/one/project")).toEqual([]);
  });
});

describe("computeEmptyState", () => {
  const baseInputs = {
    isLoadingSessions: false,
    allQueriesErrored: false,
    isQueryingProviders: true,
    allQueriesSettled: true,
    selectedProvider: ALL_FILTER_VALUE,
    aggregatedCount: 0,
    visibleCount: 0,
    totalAlreadyImportedCount: 0,
    providerLabelById: new Map<string, string>(),
  };

  it("hides the empty state while sessions are still loading", () => {
    const result = computeEmptyState({ ...baseInputs, isLoadingSessions: true });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state when every query errored", () => {
    const result = computeEmptyState({ ...baseInputs, allQueriesErrored: true });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state until every provider query has settled", () => {
    const result = computeEmptyState({ ...baseInputs, allQueriesSettled: false });
    expect(result.showEmptyState).toBe(false);
  });

  it("hides the empty state when there are visible entries", () => {
    const result = computeEmptyState({
      ...baseInputs,
      aggregatedCount: 2,
      visibleCount: 2,
    });
    expect(result.showEmptyState).toBe(false);
  });

  it("shows the default no-sessions message when nothing is loaded and nothing is filtered", () => {
    const result = computeEmptyState(baseInputs);
    expect(result).toEqual({
      showEmptyState: true,
      emptyStateTitle: i18n.t("importSession.empty.noRecent"),
    });
  });

  it("shows the already-imported message when imported entries were filtered out", () => {
    const result = computeEmptyState({
      ...baseInputs,
      totalAlreadyImportedCount: 4,
    });
    expect(result.emptyStateTitle).toBe(i18n.t("importSession.empty.alreadyImported"));
  });

  it("shows a provider-scoped message when a filter hides aggregated entries", () => {
    const result = computeEmptyState({
      ...baseInputs,
      selectedProvider: "claude",
      aggregatedCount: 3,
      providerLabelById: new Map([["claude", "Claude Code"]]),
    });
    expect(result.emptyStateTitle).toBe(
      i18n.t("importSession.empty.noProviderSessions", { provider: "Claude Code" }),
    );
  });

  it("falls back to the provider id when the filtered provider lacks a label", () => {
    const result = computeEmptyState({
      ...baseInputs,
      selectedProvider: "z-ai",
      aggregatedCount: 1,
    });
    expect(result.emptyStateTitle).toBe(
      i18n.t("importSession.empty.noProviderSessions", { provider: "z-ai" }),
    );
  });
});
