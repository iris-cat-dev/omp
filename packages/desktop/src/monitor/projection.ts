import type { EstimateInterval } from "./math.js";
import type { NumericResponse } from "./parser.js";
import { FALLBACK_MS, MONITOR_LIMITS, normalizedPath, RECENT_MS, STALE_MS } from "./state.js";
import type { Candidate, FileState, MonitorIssue, RootState } from "./state.js";
import type {
  OmpMonitorAgent,
  OmpMonitorAgentKind,
  OmpMonitorCoverage,
  OmpMonitorScope,
  OmpMonitorSnapshot,
} from "./types.js";

export interface ScopedFiles {
  all: FileState[];
  selected: FileState[];
  ids: Set<string>;
  byPath: Map<string, FileState>;
  projects: Map<string, string>;
}

function inheritedProject(file: FileState, byPath: Map<string, FileState>): string {
  let current: FileState | undefined = file;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parser.project) return current.parser.project;
    current = current.parentPath ? byPath.get(normalizedPath(current.parentPath)) : undefined;
  }
  return "";
}

export function scopeFiles(files: Iterable<FileState>, scope: OmpMonitorScope): ScopedFiles {
  const all = [...files];
  const byPath = new Map<string, FileState>();
  for (const file of all) byPath.set(normalizedPath(file.path), file);
  const projects = new Map<string, string>();
  const selected: FileState[] = [];
  const ids = new Set<string>();
  for (const file of all) {
    const project = inheritedProject(file, byPath);
    projects.set(file.id, project);
    if (scope.profile !== null && file.root.label !== scope.profile) continue;
    if (scope.project !== null && project !== scope.project) continue;
    selected.push(file);
    ids.add(file.id);
  }
  return { all, selected, ids, byPath, projects };
}

function speedOf(responses: readonly NumericResponse[], limit = responses.length): number | null {
  let output = 0;
  let duration = 0;
  const count = Math.min(limit, responses.length);
  for (let position = 0; position < count; position++) {
    output += responses[position]!.outputTokens;
    duration += responses[position]!.measuredDurationMs;
  }
  return duration > 0 ? Math.min(Number.MAX_SAFE_INTEGER, (output * 1_000) / duration) : null;
}

interface SpeedReferences {
  agents: Map<string, NumericResponse[]>;
  models: Map<string, NumericResponse[]>;
  source: number | null;
}
export interface ScopedResponses {
  responses: NumericResponse[];
  references: SpeedReferences;
}

function speedReferences(measured: NumericResponse[], now: number): SpeedReferences {
  measured.sort((a, b) => b.endMs - a.endMs || a.key.localeCompare(b.key));
  const agents = new Map<string, NumericResponse[]>();
  const models = new Map<string, NumericResponse[]>();
  for (const response of measured) {
    if (response.endMs >= now - RECENT_MS) {
      const list = agents.get(response.agentId) ?? [];
      if (list.length < 3) {
        list.push(response);
        agents.set(response.agentId, list);
      }
    }
    if (response.model) {
      const list = models.get(response.model) ?? [];
      if (list.length < 10) {
        list.push(response);
        models.set(response.model, list);
      }
    }
  }
  return { agents, models, source: speedOf(measured, 10) };
}

export function scopeResponses(
  candidates: Iterable<Candidate>,
  ids: Set<string>,
  now: number,
): ScopedResponses {
  const responses: NumericResponse[] = [];
  const measured: NumericResponse[] = [];
  for (const candidate of candidates) {
    const response = candidate.response;
    if (ids.has(candidate.file.id)) responses.push(response);
    // References are global priors; only selected agents contribute actual/estimated output.
    if (response.startMs !== null && response.endMs >= now - FALLBACK_MS && response.endMs <= now)
      measured.push(response);
  }
  return { responses, references: speedReferences(measured, now) };
}

const AGENT_NAMES: Record<OmpMonitorAgentKind, string> = {
  main: "OMP",
  subagent: "Subagent",
  advisor: "Advisor",
};

function agentSpeed(file: FileState, references: SpeedReferences): number | null {
  const own = references.agents.get(file.id);
  if (own?.length) return speedOf(own);
  const sameModel = file.parser.model ? references.models.get(file.parser.model) : undefined;
  if (sameModel?.length) return speedOf(sameModel);
  return references.source;
}

function projectAgent(
  file: FileState,
  files: ScopedFiles,
  references: SpeedReferences,
  now: number,
): OmpMonitorAgent {
  const parser = file.parser;
  const phase =
    now - parser.lastActivityAt > STALE_MS || parser.lastActivityAt > now + STALE_MS
      ? "idle"
      : parser.phase;
  const parent = file.parentPath ? files.byPath.get(normalizedPath(file.parentPath)) : undefined;
  const parentId = parent && files.ids.has(parent.id) && parent.id !== file.id ? parent.id : null;
  return {
    id: file.id,
    parentId,
    name: `${AGENT_NAMES[file.kind]} ${file.id.slice(0, 6)}`,
    project: files.projects.get(file.id) ?? "",
    profile: file.root.label,
    kind: file.kind,
    model: parser.model,
    phase,
    lastActivityAt: parser.lastActivityAt,
    outputTps: agentSpeed(file, references),
    ttftMs: parser.ttftMs,
  };
}

function estimateInterval(
  file: FileState,
  agent: OmpMonitorAgent,
  latestEnd: Map<string, number>,
  now: number,
): EstimateInterval | null {
  if (
    agent.phase !== "generating" ||
    file.parser.inFlightStartMs === null ||
    agent.outputTps === null
  )
    return null;
  const start = Math.max(
    file.parser.inFlightStartMs,
    latestEnd.get(file.id) ?? file.parser.inFlightStartMs,
  );
  if (start > now) return null;
  return { agentId: file.id, start, end: now, speed: agent.outputTps };
}

function visibleAgents(agents: Map<string, OmpMonitorAgent>, now: number): Set<string> {
  const visible = new Set<string>();
  for (const agent of agents.values()) {
    if (
      agent.lastActivityAt > now + STALE_MS ||
      !(agent.lastActivityAt >= now - RECENT_MS || agent.phase === "generating")
    )
      continue;
    let current: OmpMonitorAgent | undefined = agent;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      visible.add(current.id);
      current = current.parentId ? agents.get(current.parentId) : undefined;
    }
  }
  return visible;
}

interface ActivityRank {
  generating: boolean;
  activity: number;
}

function orderAgents(
  agents: Map<string, OmpMonitorAgent>,
  visible: Set<string>,
): OmpMonitorAgent[] {
  const children = new Map<string | null, OmpMonitorAgent[]>();
  for (const id of visible) {
    const agent = agents.get(id)!;
    if (!agent.parentId || !visible.has(agent.parentId)) agent.parentId = null;
    const list = children.get(agent.parentId) ?? [];
    list.push(agent);
    children.set(agent.parentId, list);
  }
  const ranks = new Map<string, ActivityRank>();
  const rank = (agent: OmpMonitorAgent): ActivityRank => {
    const cached = ranks.get(agent.id);
    if (cached) return cached;
    const value = { generating: agent.phase === "generating", activity: agent.lastActivityAt };
    ranks.set(agent.id, value);
    const descendants = children.get(agent.id);
    if (!descendants) return value;
    for (const child of descendants) {
      const childRank = rank(child);
      value.generating ||= childRank.generating;
      value.activity = Math.max(value.activity, childRank.activity);
    }
    return value;
  };
  const ordered: OmpMonitorAgent[] = [];
  const visit = (siblings: OmpMonitorAgent[]): void => {
    siblings.sort(
      (a, b) =>
        Number(rank(b).generating) - Number(rank(a).generating) ||
        rank(b).activity - rank(a).activity ||
        a.id.localeCompare(b.id),
    );
    for (const agent of siblings) {
      if (ordered.length >= MONITOR_LIMITS.agents) break;
      ordered.push(agent);
      const descendants = children.get(agent.id);
      if (descendants) visit(descendants);
    }
  };
  const roots = children.get(null);
  if (roots) visit(roots);
  return ordered;
}

export interface ActivityProjection {
  agents: OmpMonitorAgent[];
  estimates: EstimateInterval[];
  visibleCount: number;
}

export function projectActivity(
  files: ScopedFiles,
  facts: ScopedResponses,
  now: number,
): ActivityProjection {
  const latestEnd = new Map<string, number>();
  for (const response of facts.responses) {
    if (!response.sideCall)
      latestEnd.set(
        response.agentId,
        Math.max(latestEnd.get(response.agentId) ?? 0, response.endMs),
      );
  }
  const byId = new Map<string, OmpMonitorAgent>();
  const estimates: EstimateInterval[] = [];
  for (const file of files.selected) {
    const agent = projectAgent(file, files, facts.references, now);
    byId.set(file.id, agent);
    const estimate = estimateInterval(file, agent, latestEnd, now);
    if (estimate) estimates.push(estimate);
  }
  const visible = visibleAgents(byId, now);
  return { agents: orderAgents(byId, visible), estimates, visibleCount: visible.size };
}

export interface CoverageFacts {
  issues: ReadonlySet<MonitorIssue>;
  skipped: number;
  droppedRecords: boolean;
  visibleCount: number;
  numericLimited: boolean;
}

export function projectCoverage(
  files: readonly FileState[],
  roots: readonly RootState[],
  facts: CoverageFacts,
): OmpMonitorCoverage {
  const issues = new Set<MonitorIssue>(facts.issues);
  let malformedLines = 0;
  let skippedFiles = facts.skipped;
  let readFiles = 0;
  let pending = false;
  for (const file of files) {
    for (const issue of file.issues) issues.add(issue);
    malformedLines += file.malformed;
    if (file.read) readFiles++;
    if (file.issues.size) skippedFiles++;
    if (!file.complete || file.dirty) pending = true;
  }
  if (facts.droppedRecords || facts.visibleCount > MONITOR_LIMITS.agents || facts.numericLimited)
    issues.add("record_limit");
  if (pending) issues.add("scan_pending");
  return {
    roots: roots.map(({ root, available }) => ({ label: root.label, available })),
    discoveredFiles: files.length,
    readFiles,
    skippedFiles,
    malformedLines,
    limited: issues.size > 0 || malformedLines > 0,
    issues: [...issues].sort(),
  };
}

export function coverageStatus(coverage: OmpMonitorCoverage): OmpMonitorSnapshot["status"] {
  if (!coverage.roots.some((root) => root.available)) return "unavailable";
  if (
    coverage.issues.length === 1 &&
    coverage.issues[0] === "scan_pending" &&
    !coverage.malformedLines &&
    coverage.readFiles === 0
  )
    return "scanning";
  // Backfill is incomplete coverage, not an unusable live feed. Consumers deliberately
  // suppress "scanning" snapshots; keep numeric facts already read available as partial.
  if (coverage.limited) return "partial";
  return "ready";
}

export function filterOptions(
  files: ScopedFiles,
  roots: readonly RootState[],
): OmpMonitorSnapshot["scopes"] {
  const projects = new Set<string>();
  const profiles = new Set<string>();
  for (const project of files.projects.values()) if (project) projects.add(project);
  for (const { root } of roots) profiles.add(root.label);
  return { projects: [...projects].sort(), profiles: [...profiles].sort() };
}
