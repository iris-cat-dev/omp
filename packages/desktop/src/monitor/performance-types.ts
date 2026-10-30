// Agent Speed v1.6.0 (MIT), ca460d7f899e7adc73391ea706b729f1fc481fde.
// Derived numeric facts only; no prompts, tool arguments, transcript bodies or paths.
export type MonitorPerformanceComponentId = "T" | "L" | "N" | "R" | "H" | "U" | "S";
export type MonitorPerformanceForm = "none" | "live" | "resting";
export interface MonitorPerformanceComponent {
  id: MonitorPerformanceComponentId;
  present: boolean;
  reason: "notRecorded" | "fewSamples" | null;
  samples: number;
  measure: number | null;
  ratio: number | null;
  subScore: number | null;
}
export interface MonitorPerformanceAgent {
  id: string;
  source: string;
  phase: "generating" | "tools" | "idle";
  lastLineMs?: number | null;
  parentId?: string | null;
}
export interface MonitorPerformanceResponse {
  key: string;
  agentId?: string;
  source?: string;
  model?: string | null;
  startMs: number | null;
  endMs: number;
  durationMs?: number | null;
  firstMs?: number | null;
  final?: boolean;
  input: number;
  cachedInput: number;
  output: number;
  reasoning?: number;
}
export interface MonitorPerformanceAction {
  callMs: number;
  resultMs: number | null;
  failed?: boolean | null;
  model?: string | null;
}
export interface MonitorPerformanceEvaluation {
  form: MonitorPerformanceForm;
  score: number | null;
  shown: number | null;
  provisional: boolean;
  n: number;
  tools: number;
  activeMs: number;
  spanStartMs: number | null;
  model: string | null;
  components: MonitorPerformanceComponent[];
  baseline: number | null;
  vsUsual: number | null;
  vsUsualPercent: number | null;
}
export interface MonitorPerformanceSums {
  n: number;
  outputSum: number;
  durationMsSum: number;
  latencyBins: number[];
  reasonN: number;
  reasonOutput: number;
  reasonDurationMsSum: number;
  cacheN: number;
  cacheInput: number;
  cacheCached: number;
  toolN: number;
  toolLnSum: number;
  toolFailed: number;
  activeMs: number;
}
export interface MonitorPerformanceRecord extends MonitorPerformanceSums {
  day: string;
  source: string;
  model: string;
  /** OMP keeps an opaque owner for local profile/project filtering. */
  agentId?: string;
}
export interface MonitorPerformancePooled {
  n: number;
  tools: number;
  activeMs: number;
  score: number | null;
  shown: number | null;
  components: MonitorPerformanceComponent[];
}
export interface MonitorPerformanceRangeRow extends MonitorPerformancePooled {
  source: string;
  model: string;
  trend: Array<{ day: string; score: number | null }>;
}
export interface MonitorPerformanceSetValue {
  form: MonitorPerformanceForm;
  score: number | null;
  shown: number | null;
  agent: string | null;
}
export interface OmpMonitorPerformance {
  current: Record<string, MonitorPerformanceEvaluation>;
  records: MonitorPerformanceRecord[];
  /** Computer-wide previous-14-day baselines, without unscoped agent history. */
  baselines: Array<{ source: string; model: string; score: number | null }>;
  scanning: boolean;
  limited: boolean;
}
