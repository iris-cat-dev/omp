import type { OmpMonitorPerformance } from "./performance-types.js";

export type OmpMonitorPhase = "generating" | "tools" | "idle";
export type OmpMonitorAgentKind = "main" | "subagent" | "advisor";

/** Numeric log facts only. No conversation content, credentials, or transcript paths. */
export interface OmpMonitorUsage {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** Known reasoning subset of output, never additional output or billable tokens. */
  reasoningTokens: number;
  /** Native reasoning coverage; an explicit zero is known, absence is not. */
  reasoningKnownRequests: number;
  reasoningKnownOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedRequests: number;
  /** Estimate at the currently selected public catalog, distinct from recorded OMP cost. */
  estimatedCostUsd: number;
  unestimatedRequests: number;
  measuredOutputTokens: number;
  measuredDurationMs: number;
  peakOutputTps: number;
  peakTotalTps: number;
}

export interface OmpMonitorExecutionModeFact {
  value: string;
  evidence: "selected" | "recorded";
  provider: string | null;
}

export interface OmpMonitorAgent {
  id: string;
  parentId: string | null;
  name: string;
  project: string;
  profile: string;
  kind: OmpMonitorAgentKind;
  model: string | null;
  phase: OmpMonitorPhase;
  lastActivityAt: number;
  outputTps: number | null;
  /** Same measured-request reference set as outputTps, including native cached input. */
  totalTps: number | null;
  /** Own-agent output in the shared three-second live window, not recent request speed. */
  liveMeasuredTps: number;
  liveEstimatedTps: number;
  liveMeasuredTotalTps: number;
  liveEstimatedTotalTps: number;
  thinkingTps: number | null;
  liveCostUsdPerSecond: number | null;
  speedMode: OmpMonitorExecutionModeFact | null;
  effortMode: OmpMonitorExecutionModeFact | null;
  ttftMs: number | null;
}

export interface OmpMonitorPoint {
  timestamp: number;
  measuredTps: number;
  estimatedTps: number;
  measuredTotalTps: number;
  estimatedTotalTps: number;
}

export interface OmpMonitorDay extends OmpMonitorUsage {
  /** Local calendar date, YYYY-MM-DD. History covers currently available logs only. */
  date: string;
  /** Distinct canonical request agents on this completion date, not the currently visible agent list. */
  agentCount: number;
}

/** Pool the raw sums over a date range; never average per-day or per-request speeds. */
export interface OmpMonitorBreakdownCounts {
  requests: number;
  outputTokens: number;
  measuredOutputTokens: number;
  measuredDurationMs: number;
}

export interface OmpMonitorModelBreakdown extends OmpMonitorBreakdownCounts {
  date: string;
  source: "omp";
  model: string | null;
  costUsd: number;
  unpricedRequests: number;
  estimatedCostUsd: number;
  unestimatedRequests: number;
}

export interface OmpMonitorModeBreakdown extends OmpMonitorBreakdownCounts {
  date: string;
  source: "omp";
  model: string | null;
  kind: "effort" | "speed";
  /** A null attribution is the real unknown bucket, not Standard or reasoning off. */
  value: string | null;
  evidence: OmpMonitorExecutionModeFact["evidence"] | null;
  provider: string | null;
}

export interface OmpMonitorBreakdowns {
  models: OmpMonitorModelBreakdown[];
  modes: OmpMonitorModeBreakdown[];
}

export interface OmpMonitorHistoryRange {
  /** Earliest retained usage or positive measured-overlap day in this scope; null without numeric history. */
  startDate: string | null;
  /** Current local date. Missing interior dates are empty, not synthetic recovered history. */
  endDate: string;
  limited: boolean;
  scanning: boolean;
}

export interface OmpMonitorRoot {
  path: string;
  label: string;
}

export interface OmpMonitorCoverage {
  roots: Array<{ label: string; available: boolean }>;
  discoveredFiles: number;
  readFiles: number;
  skippedFiles: number;
  malformedLines: number;
  limited: boolean;
  issues: Array<"unreadable" | "line_limit" | "file_limit" | "record_limit" | "scan_pending">;
}

export interface OmpMonitorScope {
  profile: string | null;
  project: string | null;
}

export interface OmpMonitorResources {
  status: "available" | "unavailable" | "partial";
  sampledAt: number;
  processCount: number;
  /** Percentage of total logical CPU capacity, not a per-core percentage. */
  cpuPercent: number | null;
  workingSetBytes: number | null;
  privateBytes: number | null;
  reason: "no_processes" | "unsupported" | "unreadable" | "timeout" | null;
}

export interface OmpMonitorDataFeed {
  status: "bundled" | "fresh" | "stale" | "error" | "updating";
  version: string;
  updatedAt: string | null;
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  source: string;
}

export interface OmpMonitorPricing {
  networkEnabled: boolean;
  autoSyncPrices: boolean;
  currency: string;
  currencies: string[];
  prices: OmpMonitorDataFeed;
  rates: OmpMonitorDataFeed;
  exchangeRate: number | null;
  attribution: { label: string; url: string } | null;
}

export interface OmpMonitorSnapshot {
  updatedAt: number;
  scope: OmpMonitorScope;
  scopes: { profiles: string[]; projects: string[] };
  /** Always all identifiable local native OMP processes, not attributable to a project. */
  resources: OmpMonitorResources;
  pricing: OmpMonitorPricing;
  status: "scanning" | "ready" | "unavailable" | "partial" | "error";
  activity: {
    /** Latest successful positive-output completion eligible for feedback; fast-tail catchup is excluded. */
    lastResponseAt: number | null;
    /** Exclusive end of today's earliest winning measured three-second bucket window. */
    peakAt: number | null;
    /** Latest feedback-eligible measured completion contributing to the peak, never discovery time. */
    peakObservedAt: number | null;
    totalPeakAt: number | null;
    totalPeakObservedAt: number | null;
  };
  rate: {
    measuredTps: number;
    estimatedTps: number;
    measuredTotalTps: number;
    estimatedTotalTps: number;
    estimatedShare: number;
    measuredThinkingTps: number | null;
    estimatedThinkingTps: number | null;
  };
  today: OmpMonitorUsage;
  days: OmpMonitorDay[];
  breakdowns: OmpMonitorBreakdowns;
  historyRange: OmpMonitorHistoryRange;
  performance: OmpMonitorPerformance;
  agents: OmpMonitorAgent[];
  series: OmpMonitorPoint[];
  coverage: OmpMonitorCoverage;
}

export type OmpMonitorWorkerRequest =
  | { type: "refresh" }
  | { type: "shutdown"; requestId: number }
  | { type: "visibility"; visible: boolean }
  | {
      type: "pricing.configure";
      requestId: number;
      networkEnabled?: boolean;
      autoSyncPrices?: boolean;
      currency?: string;
    }
  | { type: "pricing.refresh"; target?: "prices" | "rates" }
  | { type: "scopes"; scopes: Array<{ id: string; scope: OmpMonitorScope }> };

export type OmpMonitorWorkerResponse =
  | {
      type: "snapshots";
      snapshots: Array<{ scopeId: string; snapshot: OmpMonitorSnapshot }>;
    }
  | { type: "command-result"; requestId: number; ok: boolean }
  | { type: "error" };
