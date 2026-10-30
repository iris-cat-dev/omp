import { Stats } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currentDayUsage, OmpMonitorHistory } from "./history.js";
import { LIVE_WINDOW_MS, liveMetrics } from "./math.js";
import { emptyUsage, OmpNumericParser } from "./parser.js";
import type { NumericResponse, NumericSink } from "./parser.js";
import { projectActivity, scopeFiles, scopeResponses } from "./projection.js";
import { newFileState } from "./state.js";
import type { Candidate, FileState } from "./state.js";

const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const ROOT = path.resolve("telemetry-fixture");

function journal(type: string, id: string, at: number, extra: Record<string, unknown> = {}) {
  return { type, id, timestamp: new Date(at).toISOString(), ...extra };
}

function reply(id: string, at: number, extra: Record<string, unknown> = {}, parentId?: string) {
  return journal("message", id, at, {
    parentId,
    message: {
      role: "assistant",
      provider: "openai",
      model: "model-a",
      api: "openai-responses",
      timestamp: at - 1_000,
      duration: 1_000,
      stopReason: "stop",
      usage: { input: 10, output: 100 },
      ...extra,
    },
  });
}

function capture(agentId = "main") {
  const parser = new OmpNumericParser(agentId);
  const responses = new Map<string, NumericResponse>();
  const sink: NumericSink = {
    otherOwner: () => false,
    upsert: (response) => {
      responses.set(response.key, response);
      return true;
    },
    acceptTools: () => true,
    limit: () => {
      throw new Error("Unexpected telemetry retention limit");
    },
  };
  parser.apply(journal("session", "session", NOW - 60_000), sink);
  return {
    parser,
    sink,
    responses,
    latest: () => [...responses.values()].at(-1)!,
    feed: (entry: unknown, position = 0, historyOnly = false) =>
      parser.apply(entry, sink, historyOnly, position),
  };
}

function measured(
  agentId: string,
  key: string,
  start: number,
  end: number,
  output: number,
  reasoning: number | null,
  model = "model-a",
): NumericResponse {
  return {
    ...emptyUsage(),
    key,
    agentId,
    model,
    provider: "openai",
    serviceTier: null,
    speedMode: null,
    startMs: start,
    endMs: end,
    ttftMs: null,
    sideCall: false,
    completionState: "stop",
    requests: 1,
    inputTokens: 10,
    outputTokens: output,
    totalTokens: output + 10,
    reasoningTokens: reasoning ?? 0,
    reasoningKnownRequests: reasoning === null ? 0 : 1,
    reasoningKnownOutputTokens: reasoning === null ? 0 : output,
    measuredOutputTokens: output,
    measuredDurationMs: end - start,
    costUsd: 999,
  };
}

function file(relative: string, order: number): FileState {
  const stat = new Stats();
  stat.mtimeMs = NOW;
  const result = newFileState(
    {
      path: path.join(ROOT, relative),
      root: { path: ROOT, label: "default" },
      stat,
    },
    order,
  );
  result.parser.model = "model-a";
  result.parser.lastActivityAt = NOW;
  return result;
}

function candidate(sourceFile: FileState, response: NumericResponse): Candidate {
  return { file: sourceFile, response, position: 1 };
}

const ALL = { profile: null, project: null };

describe("OMP native reasoning coverage", () => {
  it.each([
    [undefined, 0, 0],
    [null, 0, 0],
    ["3", 0, 0],
    [Number.NaN, 0, 0],
    [Number.POSITIVE_INFINITY, 0, 0],
    [0, 0, 1],
    [-3, 0, 1],
    [3.9, 3, 1],
    [500, 100, 1],
  ])("normalizes native reasoning %s without manufacturing coverage", (native, expected, known) => {
    const current = capture();
    current.feed(reply("one", NOW, { usage: { input: 10, output: 100, reasoningTokens: native } }));
    expect(current.latest()).toMatchObject({
      outputTokens: 100,
      totalTokens: 110,
      reasoningTokens: expected,
      reasoningKnownRequests: known,
      reasoningKnownOutputTokens: known ? 100 : 0,
    });
  });

  it("keeps absent and explicit-zero thinking distinct in the shared live window", () => {
    const missing = capture();
    missing.feed(reply("missing", NOW));
    const zero = capture();
    zero.feed(reply("zero", NOW, { usage: { input: 10, output: 100, reasoningTokens: 0 } }));
    expect(liveMetrics([missing.latest()], [], NOW)).toMatchObject({
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    });
    expect(liveMetrics([zero.latest()], [], NOW)).toMatchObject({
      measuredThinkingTps: 0,
      estimatedThinkingTps: null,
    });
    expect(liveMetrics([zero.latest()], [], NOW + LIVE_WINDOW_MS)).toMatchObject({
      measuredTps: 0,
      measuredThinkingTps: null,
    });
  });

  it("aggregates known reasoning as an output subset without adding it to totals or catalog cost", () => {
    const current = capture();
    current.feed(reply("missing", NOW - 3_000, { usage: { input: 10, output: 100 } }));
    current.feed(
      reply("zero", NOW - 2_000, { usage: { input: 10, output: 100, reasoningTokens: 0 } }),
    );
    current.feed(
      reply("known", NOW - 1_000, { usage: { input: 10, output: 100, reasoningTokens: 25 } }),
    );
    current.feed(
      reply("clamped", NOW, { usage: { input: 10, output: 100, reasoningTokens: 200 } }),
    );
    const history = new OmpMonitorHistory(
      (usage) =>
        (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) /
        1_000_000,
    );
    const projection = history.getDays(ALL, [...current.responses.values()], NOW, 1, "catalog-v3");
    expect(currentDayUsage(projection.days)).toMatchObject({
      requests: 4,
      outputTokens: 400,
      totalTokens: 440,
      reasoningTokens: 125,
      reasoningKnownRequests: 3,
      reasoningKnownOutputTokens: 300,
      measuredOutputTokens: 400,
      measuredDurationMs: 4_000,
      estimatedCostUsd: 440 / 1_000_000,
    });
  });
});

describe("OMP branch-scoped speed evidence", () => {
  it("keeps selected, recorded, explicit clear and an older branch distinct", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "selection", NOW - 5_000, {
        serviceTier: { openai: "priority", anthropic: "ultrafast" },
      }),
    );
    current.feed(reply("selected", NOW - 4_000, {}, "selection"));
    expect(current.latest().speedMode).toEqual({
      value: "fast",
      evidence: "selected",
      provider: "openai",
    });
    current.feed(reply("recorded", NOW - 3_000, { serviceTier: "default" }, "selection"));
    expect(current.parser.speedMode).toEqual({
      value: "standard",
      evidence: "recorded",
      provider: "openai",
    });
    current.feed(
      journal("service_tier_change", "clear", NOW - 2_000, {
        parentId: "selection",
        serviceTier: null,
      }),
    );
    current.feed(reply("cleared", NOW - 1_000, {}, "clear"));
    expect(current.latest().speedMode).toBeNull();
    expect(current.parser.speedMode).toBeNull();
    current.feed(reply("fork", NOW, {}, "selection"));
    expect(current.parser.speedMode).toEqual({
      value: "fast",
      evidence: "selected",
      provider: "openai",
    });
    expect([...current.responses.values()].map((response) => response.speedMode?.evidence)).toEqual(
      ["selected", "recorded", undefined, "selected"],
    );
  });

  it("inherits only through parentId and treats an absent map differently from a clear", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "root", NOW - 5_000, { serviceTier: { openai: "ultrafast" } }),
    );
    current.feed(journal("service_tier_change", "inherit", NOW - 4_000, { parentId: "root" }));
    current.feed(reply("inherited", NOW - 3_000, {}, "inherit"));
    expect(current.parser.speedMode?.value).toBe("ultrafast");
    current.feed(reply("unrelated", NOW - 2_000));
    expect(current.parser.speedMode).toBeNull();
    current.feed(
      journal("service_tier_change", "empty", NOW - 1_000, { parentId: "root", serviceTier: {} }),
    );
    current.feed(reply("empty-response", NOW, {}, "empty"));
    expect(current.parser.speedMode).toBeNull();
  });

  it("suppresses rejected recorded priority but retains explicit selected fallback", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "root", NOW - 3_000, { serviceTier: { openai: "ultrafast" } }),
    );
    current.feed(
      reply(
        "rejected",
        NOW - 2_000,
        {
          serviceTier: "priority",
          disabledFeatures: ["priority"],
        },
        "root",
      ),
    );
    expect(current.latest().speedMode).toEqual({
      value: "ultrafast",
      evidence: "selected",
      provider: "openai",
    });
    current.feed(
      reply("rejected-without-selection", NOW - 1_000, {
        serviceTier: "priority",
        disabledFeatures: ["priority"],
      }),
    );
    expect(current.latest().speedMode).toBeNull();
    current.feed(reply("automatic-recorded", NOW, { serviceTier: "auto" }, "root"));
    expect(current.latest().speedMode).toBeNull();
  });

  it.each([
    ["openai-codex", "priority", "fast", "openai"],
    ["anthropic", "priority", "fast", "anthropic"],
    ["google", "none", "standard", "google"],
    ["custom", "priority", "priority", "custom"],
    ["custom", "default", "default", "custom"],
    ["", "priority", "priority", null],
    ["custom", "Turbo-vNext", "turbo-vnext", "custom"],
  ])(
    "normalizes %s/%s without inferring a provider family",
    (provider, serviceTier, value, family) => {
      const current = capture();
      current.feed(reply("one", NOW, { provider, serviceTier }));
      expect(current.latest().speedMode).toEqual({ value, evidence: "recorded", provider: family });
    },
  );

  it("does not apply another family, unsafe identifiers, model names or Pi effort as speed evidence", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "root", NOW - 4_000, {
        serviceTier: { openai: "priority", anthropic: "fast<script>", custom: "fast" },
      }),
    );
    current.feed(
      reply(
        "custom",
        NOW - 3_000,
        { provider: "custom", model: "gpt-ultrafast", thinkingLevel: "max" },
        "root",
      ),
    );
    expect(current.parser.speedMode).toBeNull();
    current.feed(
      journal("thinking_level_change", "effort", NOW - 2_000, {
        parentId: "root",
        thinkingLevel: "max",
      }),
    );
    current.feed(
      reply("unsafe", NOW - 1_000, { provider: "anthropic", serviceTier: "fast/path" }, "effort"),
    );
    expect(current.parser.speedMode).toBeNull();
    current.feed(reply("family", NOW, { provider: "anthropic", serviceTier: "ultrafast" }, "root"));
    expect(current.parser.speedMode).toEqual({
      value: "ultrafast",
      evidence: "recorded",
      provider: "anthropic",
    });
  });

  it("never rolls a newer tail mode back when an old prefix has later wall-clock timestamps", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "new", NOW - 2_000, { serviceTier: { openai: "ultrafast" } }),
      1_000,
    );
    current.feed(reply("latest", NOW - 1_000, {}, "new"), 1_100);
    current.feed(
      journal("service_tier_change", "old", NOW + 5_000, { serviceTier: { openai: "default" } }),
      100,
      true,
    );
    current.feed(reply("historical", NOW + 6_000, { serviceTier: "default" }, "old"), 200, true);
    current.feed(
      journal("service_tier_change", "new", NOW + 7_000, { serviceTier: { openai: "default" } }),
      300,
      true,
    );
    expect(current.parser.speedMode).toEqual({
      value: "ultrafast",
      evidence: "selected",
      provider: "openai",
    });
    current.feed(
      journal("message", "next", NOW, { parentId: "new", message: { role: "user" } }),
      1_200,
    );
    expect(current.parser.speedMode).toEqual({
      value: "ultrafast",
      evidence: "selected",
      provider: "openai",
    });
  });

  it("resolves missing branch ancestors after prefix catch-up without replacing the tail head", () => {
    const current = capture();
    let parentId = "middle";
    for (let index = 0; index < 128; index++) {
      const id = `tail-${index}`;
      current.feed(journal("custom", id, NOW - 1_900 + index, { parentId }), 500 + index);
      parentId = id;
    }
    current.feed(reply("latest", NOW - 1_000, {}, parentId), 1_000);
    expect(current.parser.speedMode).toBeNull();
    current.feed(
      journal("service_tier_change", "root", NOW - 3_000, { serviceTier: { openai: "priority" } }),
      100,
      true,
    );
    current.feed(journal("custom", "middle", NOW - 2_000, { parentId: "root" }), 200, true);
    expect(current.parser.speedMode).toEqual({
      value: "fast",
      evidence: "selected",
      provider: "openai",
    });
  });

  it("records side-call evidence without changing the main request's current model or mode", () => {
    const current = capture();
    current.feed(reply("main", NOW - 1_000, { serviceTier: "default" }));
    current.feed(
      journal("model_usage", "side", NOW, {
        provider: "anthropic",
        model: "side-model",
        api: "anthropic-messages",
        serviceTier: "priority",
        usage: { input: 10, output: 500, reasoningTokens: 300 },
      }),
    );
    expect(current.latest()).toMatchObject({
      sideCall: true,
      startMs: null,
      measuredDurationMs: 0,
      speedMode: { value: "fast", evidence: "recorded", provider: "anthropic" },
    });
    expect(current.parser.model).toBe("model-a");
    expect(current.parser.speedMode).toEqual({
      value: "standard",
      evidence: "recorded",
      provider: "openai",
    });
  });
});

describe("OMP additive three-second agent telemetry", () => {
  it("splits concurrent main/child measured and in-flight rates without side-call duplication", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    const child = file(path.join("bucket", "main", "child.jsonl"), 1);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 2_000;
    const own = measured(main.id, "main-response", NOW - 2_000, NOW - 1_000, 120, 60);
    const nested = measured(child.id, "child-response", NOW - 6_000, NOW, 600, 60);
    const side = {
      ...measured(main.id, "side", NOW - 1_000, NOW - 100, 900_000, 800_000),
      sideCall: true,
      startMs: null,
      measuredDurationMs: 0,
      measuredOutputTokens: 0,
    };
    const files = scopeFiles([main, child], ALL);
    const facts = scopeResponses(
      [candidate(main, own), candidate(child, nested), candidate(main, side)],
      files.ids,
      NOW,
    );
    const activity = projectActivity(files, facts, NOW, (usage) => {
      if (usage === own) return 6;
      if (usage === nested) return 12;
      return null;
    });
    const parent = activity.agents.find((agent) => agent.id === main.id)!;
    const subagent = activity.agents.find((agent) => agent.id === child.id)!;
    expect(parent).toMatchObject({
      outputTps: 120,
      liveMeasuredTps: 40,
      liveEstimatedTps: 40,
      thinkingTps: 40,
      liveCostUsdPerSecond: 4,
      parentId: null,
    });
    expect(subagent).toMatchObject({
      outputTps: 100,
      liveMeasuredTps: 100,
      liveEstimatedTps: 0,
      thinkingTps: 10,
      liveCostUsdPerSecond: 2,
      parentId: main.id,
    });
    expect(activity.estimates[0]!.start).toBe(NOW - 1_000);
    const total = liveMetrics(facts.responses, activity.estimates, NOW);
    expect(total).toMatchObject({
      measuredTps: 140,
      estimatedTps: 40,
      measuredThinkingTps: 30,
      estimatedThinkingTps: 20,
    });
    expect(activity.agents.reduce((sum, agent) => sum + agent.liveMeasuredTps, 0)).toBe(
      total.measuredTps,
    );
    expect(activity.agents.reduce((sum, agent) => sum + agent.liveEstimatedTps, 0)).toBe(
      total.estimatedTps,
    );
    expect(activity.agents.reduce((sum, agent) => sum + (agent.thinkingTps ?? 0), 0)).toBe(50);
  });

  it("uses the same newest-three reference set for output, reasoning share and known catalog cost", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 3_000;
    const responses = [
      measured(main.id, "one", NOW - 11_000, NOW - 10_000, 100, 10),
      measured(main.id, "two", NOW - 21_000, NOW - 20_000, 200, 40),
      measured(main.id, "three", NOW - 31_000, NOW - 30_000, 300, 90),
      measured(main.id, "excluded", NOW - 41_000, NOW - 40_000, 10_000, 10_000),
    ];
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses(
      responses.map((response) => candidate(main, response)),
      files.ids,
      NOW,
    );
    const activity = projectActivity(files, facts, NOW, (usage) => {
      if (usage === responses[0]) return 0;
      if (usage === responses[1]) return 2;
      return null;
    });
    expect(activity.agents[0]).toMatchObject({
      liveMeasuredTps: 0,
      liveEstimatedTps: 200,
      liveCostUsdPerSecond: 1,
    });
    expect(activity.agents[0]!.thinkingTps).toBeCloseTo(200 * (140 / 600));
    expect(activity.estimates[0]!.thinkingSpeed).toBeCloseTo(200 * (140 / 600));
  });

  it.each([true, false])(
    "uses model then source fallback without counting the reference as this agent's measured output (%s)",
    (sameModel) => {
      const main = file(path.join("bucket", "main.jsonl"), 0);
      const reference = file(path.join("other", "reference.jsonl"), 1);
      const distractor = file(path.join("other", "different.jsonl"), 2);
      reference.parser.model = sameModel ? "model-a" : "other-model";
      main.parser.phase = "generating";
      main.parser.inFlightStartMs = NOW - 3_000;
      const response = measured(
        reference.id,
        "reference",
        NOW - 12_000,
        NOW - 10_000,
        200,
        50,
        reference.parser.model!,
      );
      const files = scopeFiles([main], ALL);
      const unrelated = measured(
        distractor.id,
        "unrelated",
        NOW - 6_000,
        NOW - 5_000,
        900,
        0,
        "different-model",
      );
      const facts = scopeResponses(
        [candidate(reference, response), candidate(distractor, unrelated)],
        files.ids,
        NOW,
      );
      const activity = projectActivity(files, facts, NOW, (usage) =>
        usage === response ? 4 : null,
      );
      const expectedSpeed = sameModel ? 100 : 1_100 / 3;
      const expectedThinking = sameModel ? 25 : 50 / 3;
      expect(activity.agents[0]).toMatchObject({ liveMeasuredTps: 0, liveCostUsdPerSecond: 2 });
      expect(activity.agents[0]!.outputTps).toBeCloseTo(expectedSpeed);
      expect(activity.agents[0]!.liveEstimatedTps).toBeCloseTo(expectedSpeed);
      expect(activity.agents[0]!.thinkingTps).toBeCloseTo(expectedThinking);
      const live = liveMetrics(facts.responses, activity.estimates, NOW);
      expect(live).toMatchObject({ measuredTps: 0, measuredThinkingTps: null });
      expect(live.estimatedTps).toBeCloseTo(expectedSpeed);
      expect(live.estimatedThinkingTps).toBeCloseTo(expectedThinking);
    },
  );

  it.each([null, 0])("preserves unknown versus known-zero reference thinking (%s)", (reasoning) => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 3_000;
    const response = measured(main.id, "reference", NOW - 12_000, NOW - 10_000, 200, reasoning);
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses([candidate(main, response)], files.ids, NOW);
    const activity = projectActivity(files, facts, NOW, () => null);
    expect(activity.agents[0]).toMatchObject({
      liveEstimatedTps: 100,
      thinkingTps: reasoning,
      liveCostUsdPerSecond: null,
    });
    expect(liveMetrics(facts.responses, activity.estimates, NOW).estimatedThinkingTps).toBe(
      reasoning,
    );
  });

  it("does not let a stale generating phase create estimates, while recent request speed remains available", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 400_000;
    main.parser.lastActivityAt = NOW - 300_001;
    const response = measured(main.id, "reference", NOW - 302_000, NOW - 301_000, 100, 20);
    const files = scopeFiles([main], ALL);
    const activity = projectActivity(
      files,
      scopeResponses([candidate(main, response)], files.ids, NOW),
      NOW,
      () => 0,
    );
    expect(activity.estimates).toEqual([]);
    expect(activity.agents[0]).toMatchObject({
      phase: "idle",
      outputTps: 100,
      liveMeasuredTps: 0,
      liveEstimatedTps: 0,
      thinkingTps: null,
      liveCostUsdPerSecond: null,
    });
  });

  it("does not manufacture an output or thinking reference beyond the thirty-minute fallback window", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 3_000;
    const response = measured(main.id, "expired", NOW - 1_802_000, NOW - 1_801_000, 100, 50);
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses([candidate(main, response)], files.ids, NOW);
    const activity = projectActivity(files, facts, NOW, () => 8);
    expect(activity.estimates).toEqual([]);
    expect(activity.agents[0]).toMatchObject({
      outputTps: null,
      liveMeasuredTps: 0,
      liveEstimatedTps: 0,
      thinkingTps: null,
      liveCostUsdPerSecond: null,
    });
  });

  it("clips every measured rate to its actual overlap instead of using recent request speed", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    const response = measured(main.id, "one", NOW - 6_000, NOW - 2_000, 400, 100);
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses([candidate(main, response)], files.ids, NOW);
    let catalogCost = 8;
    const history = new OmpMonitorHistory(() => catalogCost);
    const activity = projectActivity(files, facts, NOW, (input) => history.quoteCost(input, "v3"));
    expect(activity.agents[0]!.outputTps).toBe(100);
    expect(activity.agents[0]!.liveMeasuredTps).toBeCloseTo(100 / 3);
    expect(activity.agents[0]!.thinkingTps).toBeCloseTo(25 / 3);
    expect(activity.agents[0]!.liveCostUsdPerSecond).toBeCloseTo(2 / 3);
    expect(liveMetrics(facts.responses, activity.estimates, NOW).measuredThinkingTps).toBeCloseTo(
      25 / 3,
    );
    catalogCost = 16;
    const repriced = projectActivity(files, facts, NOW, (input) =>
      history.quoteCost(input, "v3-new"),
    );
    expect(repriced.agents[0]!.liveCostUsdPerSecond).toBeCloseTo(4 / 3);
    expect(
      currentDayUsage(history.getDays(ALL, facts.responses, NOW, 1, "v3-new").days),
    ).toMatchObject({ estimatedCostUsd: 16, costUsd: 999 });
  });
});
