export type OmpMonitorPhase = "generating" | "tools" | "idle";
export type OmpMonitorAgentKind = "main" | "subagent" | "advisor";

/** Numeric log facts only. No conversation content, credentials, or transcript paths. */
export interface OmpMonitorUsage {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
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
  ttftMs: number | null;
}

export interface OmpMonitorPoint {
  timestamp: number;
  measuredTps: number;
  estimatedTps: number;
}

export interface OmpMonitorDay extends OmpMonitorUsage {
  /** Local calendar date, YYYY-MM-DD. History covers currently available logs only. */
  date: string;
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
    /** Latest successful, non-sidecall, positive-output completion in the retained scope. */
    lastResponseAt: number | null;
    /** Exclusive end of today's earliest winning measured three-second bucket window. */
    peakAt: number | null;
    /** Latest contributing measured completion, not the log's discovery time. */
    peakObservedAt: number | null;
  };
  rate: {
    measuredTps: number;
    estimatedTps: number;
    estimatedShare: number;
  };
  today: OmpMonitorUsage;
  days: OmpMonitorDay[];
  agents: OmpMonitorAgent[];
  series: OmpMonitorPoint[];
  coverage: OmpMonitorCoverage;
}

export type OmpMonitorWorkerRequest =
  | { type: "refresh" }
  | { type: "visibility"; visible: boolean }
  | { type: "pricing.configure"; networkEnabled?: boolean; currency?: string }
  | { type: "pricing.refresh" }
  | { type: "scopes"; scopes: Array<{ id: string; scope: OmpMonitorScope }> };

export type OmpMonitorWorkerResponse =
  | { type: "snapshot"; scopeId: string; snapshot: OmpMonitorSnapshot }
  | { type: "error" };
