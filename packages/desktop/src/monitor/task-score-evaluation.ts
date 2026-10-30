// Agent Speed v1.5.0 (MIT), Copyright (c) 2026 zoefix.
// Port of spec/tools/task_score.py and Core/Tasks/Model at 29dffc4e6fbe1da435071e40781b1571dd45ac22.
// The complete upstream permission notice is retained in task-score.ts.
import type { MonitorTaskAction, MonitorTaskActionKind, MonitorTaskEvent } from "./task-events.js";
import type { MonitorCheckClass, MonitorTaskEvaluation, MonitorTaskState } from "./task-types.js";

export interface TaskSnapshotFeatures {
  passing: number;
  failing: number;
  conv: number;
  ig: number;
  loop: number;
  osc: number;
  size: number;
}
export interface TaskFixFeatures {
  attempts: number;
  errors: number;
  trend: number;
  osc: number;
  ig: number;
}
export interface TaskEvaluationEvidence {
  features: TaskSnapshotFeatures;
  fixFeatures: TaskFixFeatures | null;
  stallEnds: readonly number[];
}
// Numeric, derived evidence only. No command keys, digests, hunks or source events are retained here.
const taskEvidence = new WeakMap<MonitorTaskEvaluation, TaskEvaluationEvidence>();
export function taskEvaluationEvidence(
  evaluation: MonitorTaskEvaluation,
): TaskEvaluationEvidence | undefined {
  return taskEvidence.get(evaluation);
}

export function taskScoreRound(value: number): number {
  return value >= 0 ? Math.trunc(value + 0.5) : -Math.trunc(-value + 0.5) || 0;
}

type TaskRunResult = "pass" | "fail" | null;
interface TaskAct {
  index: number;
  kind: MonitorTaskActionKind;
  keyId: number;
  runClass: MonitorCheckClass | null;
  suite: string | null;
  targeted: boolean;
  outcomeMs: number | null;
  fingerprints: Set<string>;
  failedCount: number | null;
  errors: number;
  result: TaskRunResult;
  weight: number;
  block: number;
  effective: boolean;
  oscillating: boolean;
  gain: number;
  countedIndex: number;
  checkNo: number;
  editsAfter: number;
  oscillationsAfter: number;
  totalWeight: number;
  weightedGain: number;
}
interface TaskFileEdits {
  written: Set<string>;
  latest: string | null;
  current: Set<string>;
  superseded: Set<string>;
}
interface TaskEpisode {
  fails: TaskAct[];
  recovered: boolean;
}

function taskInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function taskRunResult(event: MonitorTaskAction, hasOutcome: boolean): TaskRunResult {
  if (!hasOutcome) return null;
  const failed = event.outcome?.failed;
  const failedCount = event.failures?.failedCount;
  const passedCount = event.failures?.passedCount;
  if (failed === true || (taskInteger(failedCount) && failedCount > 0)) return "fail";
  if (
    failed === false ||
    (taskInteger(failedCount) &&
      failedCount === 0 &&
      !(taskInteger(passedCount) && passedCount === 0))
  )
    return "pass";
  return null;
}

function taskApplyEdit(
  files: Map<string, TaskFileEdits>,
  act: TaskAct,
  event: MonitorTaskAction,
  hasOutcome: boolean,
): void {
  if (hasOutcome && event.outcome?.failed === true) return;
  if (!event.hunks?.length) {
    act.effective = true;
    return;
  }
  let changed = false;
  let oscillating = false;
  for (const hunk of event.hunks) {
    let file = files.get(hunk.file);
    if (!file) {
      file = { written: new Set(), latest: null, current: new Set(), superseded: new Set() };
      files.set(hunk.file, file);
    }
    if (hunk.old === null) {
      if (file.latest !== null && hunk.new === file.latest) continue;
      changed = true;
      if (file.written.has(hunk.new)) oscillating = true;
      file.written.add(hunk.new);
      file.latest = hunk.new;
      file.current.clear();
      file.superseded.clear();
    } else {
      if (hunk.old === hunk.new) continue;
      changed = true;
      if (file.current.has(hunk.old) && file.superseded.has(hunk.new)) oscillating = true;
      file.superseded.add(hunk.old);
      file.current.delete(hunk.old);
      file.current.add(hunk.new);
      file.latest = null;
    }
  }
  act.effective = changed;
  act.oscillating = changed && oscillating;
}

function taskSameSignature(first: TaskAct, last: TaskAct): boolean {
  if (
    first.result !== last.result ||
    first.failedCount !== last.failedCount ||
    first.fingerprints.size !== last.fingerprints.size
  )
    return false;
  for (const fingerprint of first.fingerprints) {
    if (!last.fingerprints.has(fingerprint)) return false;
  }
  return true;
}

/** The exact loop marks of the reference, in O(3n) rather than a repeated substring scan. */
export function taskLoopActions(keys: readonly number[], count = keys.length): number {
  if (count < 3) return 0;
  const depth = new Int32Array(count + 1);
  const run = new Int32Array(count + 1);
  for (let block = 1; block <= 3 && count >= 3 * block; block++) {
    run[count] = 0;
    for (let position = count - 1; position >= block; position--) {
      run[position] = keys[position] === keys[position - block] ? run[position + 1]! + 1 : 0;
    }
    for (let start = 0; start <= count - 3 * block; start++) {
      const matched = run[start + block]!;
      if (matched < 2 * block) continue;
      depth[start + block] = depth[start + block]! + 1;
      const end = start + block + Math.trunc(matched / block) * block;
      depth[end] = depth[end]! - 1;
    }
  }
  let marked = 0;
  let open = 0;
  for (let position = 0; position < count; position++) {
    open += depth[position]!;
    if (open > 0) marked++;
  }
  return marked;
}

function taskHasOutcome(event: MonitorTaskAction, nowMs: number | undefined): boolean {
  return (
    event.outcome !== undefined &&
    !(nowMs !== undefined && event.outcome.t !== null && event.outcome.t > nowMs)
  );
}

function taskRunErrors(
  result: TaskRunResult,
  failures: MonitorTaskAction["failures"],
  failedCount: number | null,
): number {
  if (result !== "fail") return 0;
  return Math.max(
    1,
    failures?.fingerprints.length ?? 0,
    taskInteger(failedCount) ? failedCount : 0,
  );
}

function taskActionWeight(kind: MonitorTaskActionKind, runClass: MonitorCheckClass | null): number {
  if (kind === "other") return 0;
  return runClass === null ? 1 : 2;
}

function taskCreateAction(
  event: MonitorTaskAction,
  keyId: number,
  index: number,
  hasOutcome: boolean,
  previous: TaskAct | undefined,
): TaskAct {
  const command = event.kind === "command" ? event.command : undefined;
  const runClass = command && command.class !== "other" ? command.class : null;
  const result = runClass === null ? null : taskRunResult(event, hasOutcome);
  const failures = hasOutcome ? event.failures : undefined;
  const failedCount = failures?.failedCount ?? null;
  const edits = previous ? previous.editsAfter : 0;
  return {
    index,
    kind: event.kind,
    keyId,
    runClass,
    suite: command?.suite ?? null,
    targeted: command?.targeted ?? false,
    outcomeMs: hasOutcome ? event.outcome!.t : null,
    fingerprints: new Set(failures?.fingerprints ?? []),
    failedCount,
    errors: taskRunErrors(result, failures, failedCount),
    result,
    weight: taskActionWeight(event.kind, runClass),
    block: edits,
    effective: false,
    oscillating: false,
    gain: 0,
    countedIndex: 0,
    checkNo: -1,
    editsAfter: edits,
    oscillationsAfter: previous ? previous.oscillationsAfter : 0,
    totalWeight: previous ? previous.totalWeight : 0,
    weightedGain: previous ? previous.weightedGain : 0,
  };
}

function taskRecordEdit(
  files: Map<string, TaskFileEdits>,
  act: TaskAct,
  event: MonitorTaskAction,
  hasOutcome: boolean,
): void {
  taskApplyEdit(files, act, event, hasOutcome);
  act.gain = act.effective && !act.oscillating ? 1 : 0;
  if (act.effective) act.editsAfter++;
  if (act.oscillating) act.oscillationsAfter++;
}

function taskRecordRun(
  source: TaskScoreSource,
  act: TaskAct,
  command: NonNullable<MonitorTaskAction["command"]>,
  lastRun: Map<string, TaskAct>,
  checks: Map<string, number>,
): void {
  const previous = lastRun.get(command.key);
  act.gain = !previous || previous.block !== act.block || !taskSameSignature(previous, act) ? 1 : 0;
  lastRun.set(command.key, act);
  const check =
    command.targeted || command.suite === null ? `key:${command.key}` : `suite:${command.suite}`;
  let checkNo = checks.get(check);
  if (checkNo === undefined) {
    checkNo = checks.size;
    checks.set(check, checkNo);
  }
  act.checkNo = checkNo;
  source.runs.push(act);
  if (act.result === "pass" && !act.targeted && act.suite !== null) {
    let passes = source.fullPasses.get(act.suite);
    if (!passes) {
      passes = [];
      source.fullPasses.set(act.suite, passes);
    }
    passes.push(act);
  }
}

/** A processed task is shared by history's bounded snapshots; raw event content is never part of its DTO. */
export class TaskScoreSource {
  readonly acts: TaskAct[] = [];
  readonly counted: TaskAct[] = [];
  readonly countedKeys: number[] = [];
  readonly runs: TaskAct[] = [];
  readonly fullPasses = new Map<string, TaskAct[]>();
  readonly stallEnds: number[] = [];

  constructor(events: readonly MonitorTaskEvent[], nowMs?: number, start = 0, end = events.length) {
    const keys = new Map<string, Map<string, number>>();
    let keyCount = 0;
    const files = new Map<string, TaskFileEdits>();
    const lastSeen = new Map<number, number>();
    const lastRun = new Map<string, TaskAct>();
    const checks = new Map<string, number>();
    let windowWeight = 0;
    let windowGain = 0;
    for (let eventIndex = start; eventIndex < end; eventIndex++) {
      const event = events[eventIndex]!;
      if (event.type !== "action" || (nowMs !== undefined && event.t > nowMs)) continue;
      let toolKeys = keys.get(event.tool);
      if (!toolKeys) {
        toolKeys = new Map();
        keys.set(event.tool, toolKeys);
      }
      let keyId = toolKeys.get(event.digest);
      if (keyId === undefined) {
        keyId = keyCount++;
        toolKeys.set(event.digest, keyId);
      }
      const hasOutcome = taskHasOutcome(event, nowMs);
      const act = taskCreateAction(
        event,
        keyId,
        this.acts.length,
        hasOutcome,
        this.acts[this.acts.length - 1],
      );
      if (event.kind === "edit") {
        taskRecordEdit(files, act, event, hasOutcome);
      } else if (act.result !== null) {
        taskRecordRun(this, act, event.command!, lastRun, checks);
      } else if (act.weight > 0) {
        act.gain = lastSeen.get(keyId) !== act.block ? 1 : 0;
      }
      if (event.kind !== "edit" && act.weight > 0 && act.result === null)
        lastSeen.set(keyId, act.editsAfter);
      if (act.weight > 0) {
        this.counted.push(act);
        this.countedKeys.push(keyId);
        act.countedIndex = this.counted.length;
        act.totalWeight += act.weight;
        act.weightedGain += act.weight * act.gain;
        windowWeight += act.weight;
        windowGain += act.weight * act.gain;
        if (this.counted.length > 8) {
          const oldest = this.counted[this.counted.length - 9]!;
          windowWeight -= oldest.weight;
          windowGain -= oldest.weight * oldest.gain;
        }
        if (this.counted.length >= 8 && 4 * windowGain <= windowWeight)
          this.stallEnds.push(this.counted.length);
      }
      this.acts.push(act);
    }
  }
}

/** Only A.2's fixed labels may be exposed by a score card, even for an incorrectly normalized input. */
const taskSafeSuites = new Set(
  `astro check|ava|basedpyright|bazel build|bazel test|biome|black|bun build|bun run build|bun run check|bun run lint|bun run test|bun run typecheck|bun test|cabal build|cabal test|cargo build|cargo check|cargo clippy|cargo fmt|cargo nextest|cargo test|cc|clang-tidy|cmake --build|composer build|composer check|composer lint|composer test|composer typecheck|cppcheck|ctest|cypress run|dart analyze|dart test|deno check|deno fmt|deno lint|deno task build|deno task check|deno task lint|deno task test|deno task typecheck|deno test|django test|dotnet build|dotnet format|dotnet msbuild|dotnet pack|dotnet publish|dotnet test|esbuild|eslint|flake8|flutter analyze|flutter build|flutter test|go build|go test|go vet|golangci-lint|gradle assemble|gradle build|gradle check|gradle lint|gradle test|hadolint|isort|javac|jest|just build|just check|just lint|just test|just typecheck|kotlinc|make|make build|make check|make lint|make test|make typecheck|meson compile|meson test|mise run build|mise run check|mise run lint|mise run test|mise run typecheck|mix compile|mix credo|mix dialyzer|mix test|mocha|msbuild|mvn compile|mvn deploy|mvn install|mvn integration-test|mvn package|mvn process-classes|mvn test|mvn test-compile|mvn verify|mypy|next build|next lint|ng build|ng lint|ng test|ninja|ninja build|ninja check|ninja lint|ninja test|ninja typecheck|node --test|nox|npm run build|npm run check|npm run lint|npm run typecheck|npm test|nuxt build|nx build|nx check|nx lint|nx test|nx typecheck|oxlint|pest|phpstan|phpunit|playwright test|pnpm run build|pnpm run check|pnpm run lint|pnpm run typecheck|pnpm test|pre-commit|prettier|psalm|pylint|pyright|pytest|rails test|rake build|rake check|rake lint|rake test|rake typecheck|rollup|rspec|rubocop|ruff|ruff format|rustc|setup.py test|shellcheck|stack build|stack test|staticcheck|stylelint|svelte-check|swift build|swift test|swift-format|swiftc|swiftlint|tap|task build|task check|task lint|task test|task typecheck|terraform validate|tox|tsc|tsup|turbo build|turbo check|turbo lint|turbo test|turbo typecheck|unittest|vite build|vitest|vstest|vue-tsc|webpack|xcodebuild analyze|xcodebuild build|xcodebuild test|yarn run build|yarn run check|yarn run lint|yarn run typecheck|yarn test|zig build|zig test`.split(
    "|",
  ),
);
function taskSafeSuite(suite: string | null): string | null {
  return suite !== null && taskSafeSuites.has(suite) ? suite : null;
}

/** Prefixes may end in an uncounted action. */
function taskCountedPrefix(acts: readonly TaskAct[], length: number): number {
  for (let index = length - 1; index >= 0; index--) {
    if (acts[index]!.weight > 0) return acts[index]!.countedIndex;
  }
  return 0;
}

function taskCheckSequence(
  source: TaskScoreSource,
  ownRuns: TaskAct[],
  checkNo: number,
  length: number,
): TaskAct[] {
  const first = ownRuns[0]!;
  if (!first.targeted || first.suite === null) return ownRuns;
  const full = source.fullPasses.get(first.suite);
  if (!full) return ownRuns;
  const covered = full.filter(
    (run) => run.index > first.index && run.index < length && run.checkNo !== checkNo,
  );
  if (covered.length === 0) return ownRuns;
  const sequence: TaskAct[] = [];
  let left = 0;
  let right = 0;
  while (left < ownRuns.length || right < covered.length) {
    sequence.push(
      right >= covered.length ||
        (left < ownRuns.length && ownRuns[left]!.index < covered[right]!.index)
        ? ownRuns[left++]!
        : covered[right++]!,
    );
  }
  return sequence;
}

function taskSequenceConvergence(sequence: readonly TaskAct[], peak: number): number {
  const last = sequence[sequence.length - 1]!;
  let fresh = 0;
  if (last.result === "fail") {
    const known = new Set<string>();
    for (const run of sequence) {
      for (const fingerprint of run.fingerprints) known.add(fingerprint);
      if (run.errors === peak) break;
    }
    for (const fingerprint of last.fingerprints) {
      if (!known.has(fingerprint)) fresh++;
    }
  }
  return peak * Math.max(0, 1 - (last.errors + fresh) / peak);
}

function taskBlockFails(block: readonly TaskAct[], sequences: readonly TaskAct[][]): boolean {
  const members = new Set(block.map((run) => run.index));
  const checks = new Set(block.map((run) => run.checkNo));
  for (const checkNo of checks) {
    const sequence = sequences[checkNo]!;
    for (let index = sequence.length - 1; index >= 0; index--) {
      const run = sequence[index]!;
      if (!members.has(run.index)) continue;
      if (run.result === "fail") return true;
      break;
    }
  }
  return false;
}

function taskVerificationCredit(buildOnly: boolean): number {
  return buildOnly ? 20 : 40;
}

function taskCoverage(currentBlock: readonly TaskAct[], passingTests: readonly TaskAct[]): number {
  let coverage = 0;
  if (
    currentBlock.some((run) => run.runClass === "build" || run.runClass === "check") ||
    passingTests.length
  )
    coverage += 4;
  if (currentBlock.some((run) => run.runClass === "test")) coverage += 4;
  let lastFailingTest = -1;
  for (const run of currentBlock) {
    if (run.runClass === "test" && run.result === "fail") lastFailingTest = run.index;
  }
  if (passingTests.some((run) => !run.targeted && run.index > lastFailingTest)) coverage += 2;
  return coverage;
}

function taskLastPass(
  state: MonitorTaskState,
  lastPass: TaskAct | undefined,
  buildOnly: boolean,
): MonitorTaskEvaluation["lastPass"] {
  if ((state !== "passing" && state !== "pending") || !lastPass) return null;
  return {
    suite: taskSafeSuite(lastPass.suite),
    runClass: lastPass.runClass!,
    buildOnly,
  };
}

export class TaskScoreEvaluation {
  readonly result: MonitorTaskEvaluation;
  readonly features: TaskSnapshotFeatures;
  readonly stallEnds: number[];
  readonly fixFeatures = new Map<number, TaskFixFeatures>();
  readonly fixLabels = new Map<number, number>();
  readonly runs: TaskAct[];
  private openRun: TaskAct | null = null;
  private openPeak = 0;
  private convergenceWeighted = 0;
  private convergenceTotal = 0;
  private recovered = 0;
  private recoverAttempts = 0;
  private fixAttempts = 0;
  private fixFailures = 0;
  private firstPassMs: number | null = null;

  constructor(
    readonly source: TaskScoreSource,
    length = source.acts.length,
  ) {
    const lastAct = length > 0 ? source.acts[length - 1]! : null;
    const edits = lastAct?.editsAfter ?? 0;
    const oscillations = lastAct?.oscillationsAfter ?? 0;
    const counted = taskCountedPrefix(source.acts, length);
    const ig = lastAct && lastAct.totalWeight > 0 ? lastAct.weightedGain / lastAct.totalWeight : 0;
    const osc = edits > 0 ? oscillations / edits : 0;
    const loopActions = taskLoopActions(source.countedKeys, counted);
    const loop = counted > 0 ? loopActions / counted : 0;
    this.stallEnds = source.stallEnds.filter((end) => end <= counted);
    this.runs = source.runs.filter((run) => run.index < length);
    const sequences: TaskAct[][] = [];
    const episodes: TaskEpisode[] = [];
    this.analyzeChecks(length, sequences, episodes);
    const latestBlockNo = this.runs[this.runs.length - 1]?.block;
    const currentBlock = this.runs.filter((run) => run.block === edits);
    const latestBlock = this.runs.filter((run) => run.block === latestBlockNo);
    const state = this.stateForBlocks(currentBlock, latestBlock, sequences, edits);
    const passingTests = currentBlock.filter(
      (run) => run.runClass === "test" && run.result === "pass",
    );
    const V = state === "passing" ? taskVerificationCredit(passingTests.length === 0) : 0;
    const C = this.convergenceValue();
    const R = this.recoveryValue(episodes);
    const E = counted > 0 ? 10 * Math.min(1, counted / 8) * ig * (1 - loop) * (1 - osc) : 0;
    const K = taskCoverage(currentBlock, passingTests);
    const score = state === "none" ? null : V + C + R + E + K;
    this.summarizeFixes();
    const passBlock = state === "passing" ? currentBlock : latestBlock;
    const lastPass = passBlock[passBlock.length - 1];
    const buildOnly = !passBlock.some((run) => run.runClass === "test" && run.result === "pass");
    this.result = {
      state,
      score,
      shown: score === null ? null : taskScoreRound(score),
      dims: { V, C, R, E, K },
      counts: {
        actions: length,
        counted,
        edits,
        oscillations,
        loopActions,
        runs: this.runs.length,
        failingRuns: this.fixAttempts,
        episodes: episodes.length,
        recovered: this.recovered,
        recoverAttempts: this.recoverAttempts,
        fixAttempts: this.fixAttempts,
        fixFailures: this.fixFailures,
      },
      firstPassMs: this.firstPassMs,
      heldV: state === "pending" ? taskVerificationCredit(buildOnly) : null,
      openFailure: this.openFailure(state, edits),
      lastPass: taskLastPass(state, lastPass, buildOnly),
    };
    this.features = {
      passing: state === "passing" ? 1 : 0,
      failing: state === "failing" ? 1 : 0,
      conv: C / 25,
      ig,
      loop,
      osc,
      size: Math.min(1, Math.log2(1 + counted) / 9),
    };
    taskEvidence.set(this.result, {
      features: this.features,
      fixFeatures: this.openFixFeatures(state),
      stallEnds: this.stallEnds,
    });
  }

  private analyzeChecks(length: number, sequences: TaskAct[][], episodes: TaskEpisode[]): void {
    const own: TaskAct[][] = [];
    for (const run of this.runs) (own[run.checkNo] ??= []).push(run);
    for (let checkNo = 0; checkNo < own.length; checkNo++) {
      const sequence = taskCheckSequence(this.source, own[checkNo]!, checkNo, length);
      sequences.push(sequence);
      const peak = this.recordEpisodes(sequence, checkNo, episodes);
      const last = sequence[sequence.length - 1]!;
      if (
        last.result === "fail" &&
        last.checkNo === checkNo &&
        (!this.openRun || last.index > this.openRun.index)
      ) {
        this.openRun = last;
        this.openPeak = peak;
      }
      if (peak > 0) {
        this.convergenceWeighted += taskSequenceConvergence(sequence, peak);
        this.convergenceTotal += peak;
      }
    }
  }

  private recordEpisodes(
    sequence: readonly TaskAct[],
    checkNo: number,
    episodes: TaskEpisode[],
  ): number {
    let episode: TaskEpisode | null = null;
    let peak = 0;
    for (let index = 0; index < sequence.length; index++) {
      const run = sequence[index]!;
      peak = Math.max(peak, run.errors);
      if (run.result === "fail") {
        if (!episode) {
          episode = { fails: [], recovered: false };
          episodes.push(episode);
        }
        episode.fails.push(run);
        if (run.checkNo === checkNo) {
          this.fixLabels.set(run.index, sequence[index + 1]?.result === "pass" ? 0 : 1);
          this.fixFeatures.set(run.index, {
            attempts: Math.min(1, (episode.fails.length - 1) / 4),
            errors: Math.min(1, Math.log2(1 + run.errors) / 8),
            trend: run.errors / peak,
            osc: run.editsAfter > 0 ? run.oscillationsAfter / run.editsAfter : 0,
            ig: run.totalWeight > 0 ? run.weightedGain / run.totalWeight : 0,
          });
        }
      } else if (episode) {
        episode.recovered = true;
        episode = null;
      }
    }
    return peak;
  }

  private stateForBlocks(
    currentBlock: readonly TaskAct[],
    latestBlock: readonly TaskAct[],
    sequences: readonly TaskAct[][],
    edits: number,
  ): MonitorTaskState {
    if (currentBlock.length) return taskBlockFails(currentBlock, sequences) ? "failing" : "passing";
    if (this.runs.length) return taskBlockFails(latestBlock, sequences) ? "failing" : "pending";
    return edits > 0 ? "unverified" : "none";
  }

  private convergenceValue(): number {
    if (this.runs.length === 0) return 0;
    if (this.convergenceTotal === 0) return 25;
    return (25 * this.convergenceWeighted) / this.convergenceTotal;
  }

  private recoveryValue(episodes: readonly TaskEpisode[]): number {
    let recoverySum = 0;
    for (const episode of episodes) {
      recoverySum += episode.recovered ? 2 / (episode.fails.length + 1) : 0;
      if (episode.recovered) {
        this.recovered++;
        this.recoverAttempts += episode.fails.length;
      }
    }
    if (episodes.length) return (15 * recoverySum) / episodes.length;
    return this.runs.some((run) => run.result === "pass") ? 15 : 0;
  }

  private summarizeFixes(): void {
    for (const run of this.runs) {
      if (run.result === "fail") {
        this.fixAttempts++;
        this.fixFailures += this.fixLabels.get(run.index)!;
      } else if (
        run.outcomeMs !== null &&
        (this.firstPassMs === null || run.outcomeMs < this.firstPassMs)
      ) {
        this.firstPassMs = run.outcomeMs;
      }
    }
  }

  private openFailure(
    state: MonitorTaskState,
    edits: number,
  ): MonitorTaskEvaluation["openFailure"] {
    const run = this.openRun;
    if (state !== "failing" || !run) return null;
    return {
      suite: taskSafeSuite(run.suite),
      runClass: run.runClass!,
      errors: run.errors,
      peak: this.openPeak,
      counted: run.fingerprints.size > 0 || (taskInteger(run.failedCount) && run.failedCount > 0),
      edited: run.block < edits,
    };
  }

  private openFixFeatures(state: MonitorTaskState): TaskFixFeatures | null {
    if (state !== "failing" || !this.openRun) return null;
    return this.fixFeatures.get(this.openRun.index) ?? null;
  }
}

export function evaluateTask(
  events: readonly MonitorTaskEvent[],
  nowMs?: number,
): MonitorTaskEvaluation {
  return new TaskScoreEvaluation(new TaskScoreSource(events, nowMs)).result;
}
