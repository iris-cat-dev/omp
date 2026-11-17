import { createRequire } from "node:module";
import { z } from "zod";

import type {
  WorkspaceTextSearchRequest,
  WorkspaceTextSearchResponse,
} from "@omp-desktop/protocol/messages";

import type { ProviderRuntimeSettings } from "./agent/provider-launch-config.js";
import { resolveOmpSdkInstallation } from "./agent/providers/omp/sdk-installation.js";

const DEFAULT_VISIBLE_LINE_LIMIT = 2_000;
const DEFAULT_MATCH_LIMIT = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_LENGTH = 4_000;
const PREVIEW_LEADING_CONTEXT = 1_200;

export type WorkspaceTextSearchPayload = WorkspaceTextSearchResponse["payload"];

export interface SearchWorkspaceTextOptions extends Omit<
  WorkspaceTextSearchRequest,
  "type" | "requestId" | "searchId"
> {
  signal?: AbortSignal;
  runtimeSettings?: Pick<ProviderRuntimeSettings, "ompSdkPath" | "env">;
  visibleLineLimit?: number;
  matchLimit?: number;
  timeoutMs?: number;
}

interface NativeFileSearchMatch {
  path: string;
  lineNumber: number;
  line: string;
  ranges: Array<{ start: number; length: number }>;
}

interface NativeFileSearchOptions {
  path: string;
  pattern: string;
  ignoreCase: boolean;
  fixedStrings: boolean;
  wholeWord: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxMatches: number;
  signal: AbortSignal;
  onMatches: (matches: NativeFileSearchMatch[]) => void;
}

type NativeFileSearch = (options: NativeFileSearchOptions) => Promise<unknown>;

const nativeSearchModuleSchema = z.object({
  searchFiles: z.custom<NativeFileSearch>(
    (value) => typeof value === "function",
    "The selected OMP SDK does not provide structured file search. Rebuild or update the SDK.",
  ),
});

function createPreview(
  rawText: string,
  rawRanges: Array<{ start: number; length: number }>,
): { text: string; ranges: Array<{ start: number; length: number }> } {
  const text = rawText.replace(/[\r\n]+$/, "");
  if (text.length <= MAX_PREVIEW_LENGTH) return { text, ranges: rawRanges };

  const firstMatchStart = rawRanges[0]?.start ?? 0;
  const sliceStart = Math.max(0, firstMatchStart - PREVIEW_LEADING_CONTEXT);
  const sliceEnd = Math.min(text.length, sliceStart + MAX_PREVIEW_LENGTH);
  const hasPrefix = sliceStart > 0;
  const hasSuffix = sliceEnd < text.length;
  const prefix = hasPrefix ? "…" : "";
  const previewText = `${prefix}${text.slice(sliceStart, sliceEnd)}${hasSuffix ? "…" : ""}`;
  const ranges = rawRanges.flatMap((range) => {
    const start = Math.max(range.start, sliceStart);
    const end = Math.min(range.start + range.length, sliceEnd);
    if (end <= start) return [];
    return [{ start: start - sliceStart + prefix.length, length: end - start }];
  });
  return { text: previewText, ranges };
}

export async function searchWorkspaceText(
  options: SearchWorkspaceTextOptions,
): Promise<Omit<WorkspaceTextSearchPayload, "requestId">> {
  const visibleLineLimit = options.visibleLineLimit ?? DEFAULT_VISIBLE_LINE_LIMIT;
  const matchLimit = options.matchLimit ?? DEFAULT_MATCH_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let cancelled = options.signal?.aborted ?? false;
  let timedOut = false;
  let matchLimitHit = false;
  let visibleLimitHit = false;
  let settled = false;
  let error: string | null = null;

  const abortFromCaller = () => {
    cancelled = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (cancelled) controller.abort();

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref();

  const filesByPath = new Map<string, WorkspaceTextSearchPayload["files"][number]>();
  const matchingPaths = new Set<string>();
  let visibleLineCount = 0;
  let matchCount = 0;

  const onMatches = (matches: NativeFileSearchMatch[]): void => {
    if (settled || cancelled || timedOut || matchLimitHit) return;
    for (const match of matches) {
      const remainingMatches = matchLimit - matchCount;
      if (remainingMatches <= 0) {
        matchLimitHit = true;
        controller.abort();
        return;
      }

      const path = match.path.replaceAll("\\", "/").replace(/^\.\//, "");
      const ranges =
        match.ranges.length <= remainingMatches
          ? match.ranges
          : match.ranges.slice(0, remainingMatches);
      matchCount += ranges.length;
      matchingPaths.add(path);
      if (ranges.length < match.ranges.length) matchLimitHit = true;

      if (visibleLineCount < visibleLineLimit) {
        const preview = createPreview(
          match.line,
          ranges.map((range) => ({ start: range.start, length: Math.max(1, range.length) })),
        );
        let file = filesByPath.get(path);
        if (!file) {
          file = { path, matches: [] };
          filesByPath.set(path, file);
        }
        file.matches.push({
          lineNumber: match.lineNumber,
          text: preview.text,
          ranges: preview.ranges,
        });
        visibleLineCount += 1;
      } else {
        visibleLimitHit = true;
      }

      if (matchLimitHit) {
        controller.abort();
        return;
      }
    }
  };

  try {
    if (!cancelled) {
      const installation = await resolveOmpSdkInstallation(options.runtimeSettings);
      const native = nativeSearchModuleSchema.parse(
        createRequire(installation.sdkEntry)("@oh-my-pi/pi-natives"),
      );
      await native.searchFiles({
        path: options.cwd,
        pattern: options.query,
        ignoreCase: !options.caseSensitive,
        fixedStrings: !options.regexp,
        wholeWord: options.wholeWord,
        includeGlobs: options.includeGlobs,
        excludeGlobs: options.excludeGlobs,
        maxMatches: matchLimit + 1,
        signal: controller.signal,
        onMatches,
      });
    }
  } catch (cause) {
    if (!cancelled && !timedOut && !matchLimitHit) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (timedOut) error = "Search timed out.";

  return {
    files: [...filesByPath.values()],
    matchCount,
    fileCount: matchingPaths.size,
    complete: !cancelled && !timedOut && !matchLimitHit && error === null,
    visibleLimitHit,
    cancelled,
    error,
  };
}
