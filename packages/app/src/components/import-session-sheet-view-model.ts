import type { FetchRecentProviderSessionEntry } from "@omp-desktop/client/internal/daemon-client";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import { getDirectoryName } from "@/attachments/directory";
import { i18n } from "@/i18n/i18next";

export const ALL_FILTER_VALUE = "__all__";

export function requiresImportSessionsHostUpgrade(input: {
  supportsSnapshot: boolean;
  workspaceId?: string | null;
  supportsWorkspaceTarget: boolean;
}): boolean {
  return !input.supportsSnapshot || (Boolean(input.workspaceId) && !input.supportsWorkspaceTarget);
}

export interface SessionsQueryResult {
  data:
    | {
        entries: FetchRecentProviderSessionEntry[];
        filteredAlreadyImportedCount?: number;
      }
    | undefined;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
}

export function resolveProvidersToFetch(
  supportsSnapshot: boolean,
  snapshotEntries: ReadonlyArray<{ provider: string; enabled?: boolean }> | undefined,
): AgentProvider[] | null {
  // COMPAT(providersSnapshot): the import-recent-sessions feature ships alongside
  // providersSnapshot (v0.1.48, 2026-04-05). Daemons older than that lack both —
  // we render an "update host" empty state instead of degrading. Drop this gate
  // when the supported daemon floor is >= v0.1.48 (target: 2026-10-05).
  if (!supportsSnapshot) return null;
  if (!snapshotEntries) return null;
  return snapshotEntries.filter((entry) => entry.enabled !== false).map((entry) => entry.provider);
}

export function buildProviderLabelMap(
  snapshotEntries: ReadonlyArray<{ provider: string; label?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!snapshotEntries) return map;
  for (const entry of snapshotEntries) {
    if (entry.label) {
      map.set(entry.provider, entry.label);
    }
  }
  return map;
}

export function aggregateSessionEntries(
  queries: ReadonlyArray<SessionsQueryResult>,
): FetchRecentProviderSessionEntry[] {
  const seen = new Set<string>();
  const collected: FetchRecentProviderSessionEntry[] = [];
  for (const query of queries) {
    if (!query.data) continue;
    for (const entry of query.data.entries) {
      const key = `${entry.providerId}:${entry.providerHandleId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(entry);
    }
  }
  collected.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
  return collected;
}

export function sumFilteredAlreadyImportedCount(
  queries: ReadonlyArray<SessionsQueryResult>,
): number {
  let total = 0;
  for (const query of queries) {
    total += query.data?.filteredAlreadyImportedCount ?? 0;
  }
  return total;
}

export function collectErroredProviderLabels(
  providersToFetch: AgentProvider[] | null,
  queries: ReadonlyArray<SessionsQueryResult>,
  providerLabelById: ReadonlyMap<string, string>,
): string[] {
  if (providersToFetch === null) return [];
  const labels: string[] = [];
  for (let index = 0; index < queries.length; index++) {
    if (queries[index]?.isError) {
      const provider = providersToFetch[index];
      labels.push(providerLabelById.get(provider) ?? provider);
    }
  }
  return labels;
}

type DisplayFields = Partial<Record<"title" | "name" | "description", string>>;

function looksStructured(text: string): boolean {
  if (text.startsWith("{")) return true;
  // Keep human-authored headings such as "[123] Fix startup".
  return (
    /^\[\s*(?:$|[[\]{"\d-]|true\b|false\b|null\b)/.test(text) && !/^\[[^\][{"]+\]\s+\S/.test(text)
  );
}

function displayFields(source: string | null): DisplayFields {
  const text = source?.trim();
  if (!text) return {};
  if (!looksStructured(text)) return { title: text.replace(/\s+/g, " ") };

  // The host can slice a JSON prompt at 60/80 characters for the title and
  // 160 for the preview, without an ellipsis or closing quote. Read string
  // tokens rather than matching field-like text inside an escaped string.
  const objects: DisplayFields[] = [];
  const stack: DisplayFields[] = [];
  let previousKey: keyof DisplayFields | null = null;
  let previousEnd = 0;
  for (const match of text.matchAll(/[{}]|"((?:[^"\\]|\\.)*)("|\\?$)/gs)) {
    if (match[0] === "{") {
      const object: DisplayFields = {};
      stack.push(object);
      objects.push(object);
      continue;
    }
    if (match[0] === "}") {
      stack.pop();
      continue;
    }
    const fields = stack.at(-1);
    const [, raw, ending] = match;
    const closed = ending === '"';
    if (
      fields &&
      previousKey &&
      !fields[previousKey] &&
      (closed || previousKey === "description") &&
      /^\s*:\s*$/.test(text.slice(previousEnd, match.index))
    ) {
      try {
        const decoded = (JSON.parse(`"${raw}"`) as string).trim().replace(/\s+/g, " ");
        if (decoded && !looksStructured(decoded)) {
          fields[previousKey] = closed ? decoded : `${decoded}…`;
        }
      } catch (error) {
        // A descriptor can end inside a Unicode escape. Ignore that value.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    previousKey = raw === "title" || raw === "name" || raw === "description" ? raw : null;
    previousEnd = match.index + match[0].length;
  }
  // Keep the description with the object it describes, not an earlier sibling.
  return (
    objects.find((object) => object.title) ??
    objects.find((object) => object.name) ??
    objects.find((object) => object.description) ??
    {}
  );
}

export interface PreparedImportSession {
  entry: FetchRecentProviderSessionEntry;
  title: string;
  preview: string | null;
  project: string | null;
  searchText: string;
}

export function prepareImportSession(
  entry: FetchRecentProviderSessionEntry,
  providerLabel: string,
): PreparedImportSession {
  const heading = displayFields(entry.title);
  const first =
    entry.firstPromptPreview === entry.title ? heading : displayFields(entry.firstPromptPreview);
  const last =
    entry.lastPromptPreview === entry.firstPromptPreview
      ? first
      : displayFields(entry.lastPromptPreview);
  const title =
    heading.title ??
    first.title ??
    heading.name ??
    first.name ??
    last.title ??
    last.name ??
    first.description ??
    last.description ??
    heading.description ??
    i18n.t("importSession.preview.untitledSession");
  const titleKey = title.toLowerCase();
  const preview =
    [
      last.description,
      last.title,
      last.name,
      first.description,
      heading.description,
      first.title,
      first.name,
    ].find((value) => value && value.toLowerCase() !== titleKey) ?? null;
  const project = getDirectoryName(entry.cwd) || null;
  const searchable = new Set([
    entry.title,
    entry.firstPromptPreview,
    entry.lastPromptPreview,
    entry.cwd,
    entry.providerId,
    entry.providerLabel,
    providerLabel,
    title,
    preview,
    project,
  ]);
  const searchText = [...searchable].join("\n").toLowerCase();
  return { entry, title, preview, project, searchText };
}

export function filterImportSessions(
  rows: readonly PreparedImportSession[],
  selectedProvider: string,
  query: string,
): PreparedImportSession[] {
  const terms = query.toLowerCase().match(/\S+/g) ?? [];
  return rows.filter(
    (row) =>
      (selectedProvider === ALL_FILTER_VALUE || row.entry.providerId === selectedProvider) &&
      terms.every((term) => row.searchText.includes(term)),
  );
}

export interface EmptyStateInputs {
  isLoadingSessions: boolean;
  allQueriesErrored: boolean;
  isQueryingProviders: boolean;
  allQueriesSettled: boolean;
  selectedProvider: string;
  aggregatedCount: number;
  visibleCount: number;
  totalAlreadyImportedCount: number;
  providerLabelById: ReadonlyMap<string, string>;
}

export function computeEmptyState(input: EmptyStateInputs): {
  showEmptyState: boolean;
  emptyStateTitle: string;
} {
  const showEmptyState =
    !input.isLoadingSessions &&
    !input.allQueriesErrored &&
    input.isQueryingProviders &&
    input.allQueriesSettled &&
    input.visibleCount === 0;
  if (!showEmptyState) {
    return { showEmptyState, emptyStateTitle: "" };
  }
  const isFilteredEmpty = input.selectedProvider !== ALL_FILTER_VALUE && input.aggregatedCount > 0;
  if (isFilteredEmpty) {
    const label = input.providerLabelById.get(input.selectedProvider) ?? input.selectedProvider;
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.noProviderSessions", { provider: label }),
    };
  }
  if (input.totalAlreadyImportedCount > 0) {
    return {
      showEmptyState,
      emptyStateTitle: i18n.t("importSession.empty.alreadyImported"),
    };
  }
  return { showEmptyState, emptyStateTitle: i18n.t("importSession.empty.noRecent") };
}
