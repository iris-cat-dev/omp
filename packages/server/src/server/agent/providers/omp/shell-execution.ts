import stripAnsi from "strip-ansi";
import { z } from "zod";
import type {
  ShellBuildProgress,
  ShellExecution,
  ShellExecutionState,
  ShellExecutionStep,
} from "@omp-desktop/protocol/agent-types";

const OffsetSchema = z.number().int().nonnegative();
const BytesSchema = z.union([z.string(), z.array(z.number().int().min(0).max(255))]);
const NodeSchema = z.object({
  k: z.enum([
    "and_or",
    "pipeline",
    "simple",
    "brace",
    "subshell",
    "if",
    "while",
    "until",
    "for",
    "arith_for",
    "select",
    "case",
    "arith",
    "cond",
    "func_def",
    "coproc",
    "assign",
    "word",
  ]),
  lo: OffsetSchema,
  hi: OffsetSchema,
  p: OffsetSchema.optional(),
  state: z.enum(["pending", "running", "ok", "fail", "skipped"]),
  st: z.number().int().optional(),
  at: OffsetSchema.optional(),
  end_ns: OffsetSchema.optional(),
  argv: z.array(BytesSchema).optional(),
});
// Parse only the fields used at this trust boundary. Syntax archives, environment,
// diagnostics and raw output journals never become Desktop/WebSocket payloads.
const TraceSchema = z.object({
  v: z.literal(1),
  seq: OffsetSchema,
  t_ns: OffsetSchema,
  script: z.string(),
  status: z.number().int().optional(),
  units: z.array(
    z.object({
      at: OffsetSchema.optional(),
      line: z.number().int().positive(),
      bytes: OffsetSchema.optional(),
      source: BytesSchema.optional(),
      callout: z.boolean().optional(),
      nodes: z.array(NodeSchema),
    }),
  ),
  history: z
    .array(
      z.object({
        kind: z.string(),
        seq: OffsetSchema,
        t_ns: OffsetSchema,
        u: OffsetSchema.optional(),
        n: OffsetSchema.optional(),
        text: BytesSchema.optional(),
        logicalEnd: z.boolean().optional(),
        logicalStatus: z.number().int().optional(),
      }),
    )
    .optional(),
});

type Trace = z.infer<typeof TraceSchema>;
export type ShellToolStatus = "running" | "completed" | "failed" | "canceled";

function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/.test(text[limit - 2] ?? "") ? limit - 2 : limit - 1;
  return `${text.slice(0, end)}…`;
}

/** Read measured CMake/Ninja progress; never infer a percentage from shell steps. */
export function parseShellBuildProgress(output: string): ShellBuildProgress | undefined {
  const lines = stripAnsi(output).split(/[\r\n]/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    const percent = /^\[\s*(\d+(?:\.\d+)?)%\]\s*(.*)$/.exec(line);
    if (percent) {
      const percentage = Number(percent[1]);
      if (percentage <= 100) {
        return { kind: "percentage", percentage, label: boundedText(percent[2]!, 256) };
      }
    }
    const fraction = /^\[\s*(\d+)\s*\/\s*(\d+)\]\s*(.*)$/.exec(line);
    if (fraction) {
      const completed = Number(fraction[1]);
      const total = Number(fraction[2]);
      if (
        Number.isSafeInteger(completed) &&
        Number.isSafeInteger(total) &&
        total > 0 &&
        completed <= total
      ) {
        return { kind: "fraction", completed, total, label: boundedText(fraction[3]!, 256) };
      }
    }
  }
  return undefined;
}

function traceState(trace: Trace, status?: ShellToolStatus): ShellExecutionState {
  if (status === "canceled") return "canceled";
  if (status === "failed") return "fail";
  const logicalEnd = trace.history?.findLast(
    (entry) => entry.kind === "RunEnd" && entry.logicalEnd,
  );
  const code = logicalEnd?.logicalStatus ?? trace.status;
  if (code !== undefined) return code === 0 ? "ok" : "fail";
  return status === "completed" ? "ok" : "running";
}

type TraceUnit = Trace["units"][number];
type TraceNode = TraceUnit["nodes"][number];

function unitSource(unit: TraceUnit, scriptBytes: Buffer): Buffer | undefined {
  if (unit.source !== undefined) {
    return Buffer.from(
      typeof unit.source === "string" ? unit.source : Uint8Array.from(unit.source),
    );
  }
  if (unit.at === undefined) return undefined;
  return scriptBytes.subarray(unit.at, unit.bytes === undefined ? undefined : unit.at + unit.bytes);
}

function nodeCommand(node: TraceNode, source?: Buffer): string | undefined {
  return (
    source?.subarray(node.lo, node.hi).toString("utf8").trim() ||
    node.argv
      ?.map((arg) => (typeof arg === "string" ? arg : Buffer.from(arg).toString("utf8")))
      .join(" ")
  );
}

interface ProjectedSteps {
  steps: ShellExecutionStep[];
  currentStepId?: string;
  currentAt: number;
  lastStepId?: string;
  lastAt: number;
  textTruncated: boolean;
}

function trackStep(result: ProjectedSteps, node: TraceNode, id: string): void {
  if (node.state === "running" && (node.at ?? 0) >= result.currentAt) {
    result.currentStepId = id;
    result.currentAt = node.at ?? 0;
  }
  if (
    (node.end_ns ?? node.at ?? -1) >= result.lastAt &&
    node.state !== "pending" &&
    node.state !== "skipped"
  ) {
    result.lastStepId = id;
    result.lastAt = node.end_ns ?? node.at ?? 0;
  }
}

function projectSteps(trace: Trace): ProjectedSteps | undefined {
  const scriptBytes = Buffer.from(trace.script, "utf8");
  const result: ProjectedSteps = {
    steps: [],
    currentAt: -1,
    lastAt: -1,
    textTruncated: false,
  };
  for (let u = 0; u < trace.units.length; u += 1) {
    const unit = trace.units[u]!;
    if (unit.callout) continue;
    const source = unitSource(unit, scriptBytes);
    for (let n = 0; n < unit.nodes.length; n += 1) {
      const node = unit.nodes[n]!;
      // Simple commands and executable leaves, not structural wrappers or words.
      if (!["simple", "arith", "cond", "func_def"].includes(node.k)) continue;
      if (node.hi < node.lo || (source && node.hi > source.length)) return undefined;
      const command = nodeCommand(node, source);
      if (!command) continue;
      const id = `${u}:${n}`;
      result.textTruncated ||= command.length > 1024;
      result.steps.push({
        id,
        command: boundedText(command, 1024),
        state: node.state,
        ...(node.st === undefined ? {} : { exitCode: node.st }),
      });
      trackStep(result, node, id);
    }
  }
  result.currentStepId ??=
    result.lastStepId ?? result.steps.find((step) => step.state === "pending")?.id;
  return result;
}

function projectProgress(
  trace: Trace,
  currentStepId: string | undefined,
  currentAt: number,
  output?: string,
): ShellBuildProgress | undefined {
  let progress: ShellBuildProgress | undefined;
  // Attribution prevents an earlier build's 100% appearing on a later command.
  let attributedOutput = false;
  if (trace.history && currentStepId) {
    const fragments: string[] = [];
    let length = 0;
    for (let index = trace.history.length - 1; index >= 0 && length < 65536; index -= 1) {
      const entry = trace.history[index]!;
      if (entry.kind !== "Output" || typeof entry.text !== "string") continue;
      if (entry.u !== undefined && entry.n !== undefined) {
        attributedOutput = true;
        if (`${entry.u}:${entry.n}` !== currentStepId) continue;
      }
      if (currentAt >= 0 && entry.t_ns < currentAt) continue;
      const fragment = entry.text.slice(-(65536 - length));
      fragments.push(fragment);
      length += fragment.length;
    }
    progress = parseShellBuildProgress(fragments.toReversed().join(""));
  }
  if (!progress && !attributedOutput && output) return parseShellBuildProgress(output);
  return progress;
}

function executionState(
  trace: Trace,
  status: ShellToolStatus | undefined,
  termination: ShellExecution["termination"],
): ShellExecutionState {
  if (termination === "canceled") return "canceled";
  if (termination === "timed_out") return "fail";
  return traceState(trace, status);
}

function visibleExecutionSteps(
  steps: ShellExecutionStep[],
  currentStepId: string | undefined,
  state: ShellExecutionState,
): ShellExecutionStep[] {
  const visibleSteps = steps.length <= 64 ? steps : steps.slice(-63);
  const current = steps.find((step) => step.id === currentStepId);
  if (current && !visibleSteps.includes(current)) visibleSteps.unshift(current);
  if (state !== "running") {
    // These steps are owned by this projection, not the source trace.
    for (const step of visibleSteps) {
      if (step.state === "pending") step.state = "skipped";
      else if (step.state === "running") step.state = state;
    }
  }
  return visibleSteps;
}

/** Validate native/RPC data once, then return a bounded display-only domain value. */
export function projectShellExecution(
  rawTrace: unknown,
  output?: string,
  status?: ShellToolStatus,
  termination?: "canceled" | "timed_out",
): ShellExecution | undefined {
  const parsed = TraceSchema.safeParse(rawTrace);
  if (!parsed.success) return undefined;
  const trace = parsed.data;
  const projected = projectSteps(trace);
  if (!projected) return undefined;
  const { steps, currentStepId, currentAt, textTruncated } = projected;
  const state = executionState(trace, status, termination);
  const progress = projectProgress(trace, currentStepId, currentAt, output);
  return {
    seq: trace.seq,
    state,
    ...(termination ? { termination } : {}),
    steps: visibleExecutionSteps(steps, currentStepId, state),
    ...(currentStepId ? { currentStepId } : {}),
    totalSteps: steps.length,
    truncated: textTruncated || steps.length > 64,
    ...(progress ? { progress } : {}),
  };
}
