import { createHash } from "node:crypto";
import { readFileSync, Stats } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currentDayUsage, OmpMonitorHistory } from "./history.js";
import { calendarDay, LIVE_WINDOW_MS, liveMetrics } from "./math.js";
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

function capture(agentId = "main", headerAt = NOW - 60_000) {
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
  parser.apply(journal("session", "session", headerAt), sink);
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
    effortMode: null,
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
    ["azure", "default", "standard", "openai"],
    ["azure-openai-responses", "ultrafast", "ultrafast", "openai"],
    ["google-vertex", "priority", "fast", "google"],
    ["google-gemini-cli", "standard", "standard", "google"],
    ["google-antigravity", "flex", "flex", "google"],
    ["google", "none", null, "google"],
    ["custom", "priority", null, null],
    ["custom", "default", null, null],
    ["", "priority", null, null],
    ["custom", "Turbo-vNext", null, null],
  ])(
    "normalizes %s/%s without inferring a provider family",
    (provider, serviceTier, value, family) => {
      const current = capture();
      current.feed(reply("one", NOW, { provider, serviceTier }));
      expect(current.latest().speedMode).toEqual(
        value === null ? null : { value, evidence: "recorded", provider: family },
      );
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

  it("resolves late inherited modes without replacing an explicit clear in either dimension", () => {
    const current = capture();
    current.feed(journal("custom", "tail", NOW - 1_900, { parentId: "middle" }), 500);
    current.feed(reply("unresolved", NOW - 1_800, {}, "tail"), 600);
    expect(current.parser.speedMode).toBeNull();
    expect(current.parser.effortMode).toBeNull();
    current.feed(
      journal("thinking_level_change", "effort-clear", NOW - 1_700, {
        parentId: "tail",
        thinkingLevel: null,
      }),
      700,
    );
    current.feed(
      journal("service_tier_change", "tier-clear", NOW - 1_600, {
        parentId: "tail",
        serviceTier: {},
      }),
      800,
    );
    current.feed(
      journal("service_tier_change", "root", NOW - 5_000, { serviceTier: { openai: "priority" } }),
      100,
      true,
    );
    current.feed(
      journal("thinking_level_change", "high", NOW - 4_000, {
        parentId: "root",
        thinkingLevel: "high",
      }),
      200,
      true,
    );
    current.feed(journal("custom", "middle", NOW - 3_000, { parentId: "high" }), 300, true);
    expect(current.parser.speedMode).toBeNull();
    expect(current.parser.effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
    current.feed(journal("custom", "effort-head", NOW - 500, { parentId: "effort-clear" }), 900);
    expect(current.parser.effortMode).toBeNull();
    expect(current.parser.speedMode).toEqual({
      value: "fast",
      evidence: "selected",
      provider: "openai",
    });
    current.feed(journal("custom", "inherited-head", NOW, { parentId: "tail" }), 1_000);
    expect(current.parser.effortMode?.value).toBe("high");
    expect(current.parser.speedMode?.value).toBe("fast");
  });

  it("uses only a side call's selected family tier without adopting its provider or request effort", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "tiers", NOW - 3_000, {
        serviceTier: { openai: "ultrafast", anthropic: "priority" },
      }),
    );
    current.feed(
      journal("thinking_level_change", "effort", NOW - 2_000, {
        parentId: "tiers",
        thinkingLevel: "high",
      }),
    );
    current.feed(
      reply(
        "main",
        NOW - 1_000,
        {
          serviceTier: "default",
          requestControls: { effort: { tail: "max" } },
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "main-tool" }],
        },
        "effort",
      ),
    );
    current.feed(
      journal("model_usage", "side", NOW, {
        parentId: "main",
        provider: "anthropic",
        model: "side-model",
        api: "anthropic-messages",
        serviceTier: "default",
        requestControls: { effort: { tail: "low" } },
        usage: { input: 10, output: 500, reasoningTokens: 300 },
      }),
    );
    expect(current.latest()).toMatchObject({
      sideCall: true,
      startMs: null,
      measuredDurationMs: 0,
      speedMode: { value: "fast", evidence: "selected", provider: "anthropic" },
      effortMode: null,
    });
    expect(current.parser.model).toBe("model-a");
    expect(current.parser.phase).toBe("tools");
    expect(current.parser.speedMode).toEqual({
      value: "ultrafast",
      evidence: "selected",
      provider: "openai",
    });
    expect(current.parser.effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
  });
});

describe("OMP native branch and request effort", () => {
  it("matches the original v1.6.1 branch fixture without promoting message facts into descendants", () => {
    const bytes = readFileSync(
      new URL("../../test-fixtures/omp-execution-modes-v161/branch.jsonl", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "bd163e5ed688f11d200ddf9093e1885ebe956e5231d098292a4b7e3b71fb228a",
    );
    const fixtureAt = Date.parse("2026-10-20T11:30:00.000Z");
    const current = capture("fixture", fixtureAt);
    for (const line of bytes.toString("utf8").trimEnd().split("\n")) current.feed(JSON.parse(line));
    const responses = [...current.responses.values()];
    expect(
      responses.map((item) => [
        item.effortMode?.value ?? null,
        item.effortMode?.evidence ?? null,
        item.speedMode?.value ?? null,
        item.speedMode?.evidence ?? null,
        item.speedMode?.provider ?? null,
      ]),
    ).toEqual([
      ["high", "selected", "standard", "recorded", "openai"],
      ["max", "recorded", "standard", "selected", "anthropic"],
      ["low", "recorded", "standard", "selected", "anthropic"],
      [null, null, "fast", "selected", "openai"],
      [null, null, "fast", "selected", "openai"],
      ["high", "selected", "standard", "selected", "anthropic"],
    ]);
    expect(responses.reduce((sum, item) => sum + item.totalTokens, 0)).toBe(995);
    expect(responses.reduce((sum, item) => sum + item.measuredOutputTokens, 0)).toBe(350);
    expect(current.parser.effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
    expect(current.parser.speedMode).toEqual({
      value: "standard",
      evidence: "selected",
      provider: "anthropic",
    });
    expect(JSON.stringify(responses)).not.toMatch(
      /One\.|Five\.|configured|requestControls|parentId/,
    );
  });

  it("changes and clears effort independently of tiers and restores the branch instead of prior request facts", () => {
    const current = capture();
    current.feed(
      journal("service_tier_change", "tier", NOW - 9_000, {
        serviceTier: { openai: "priority" },
      }),
    );
    current.feed(
      journal("thinking_level_change", "high", NOW - 8_000, {
        parentId: "tier",
        thinkingLevel: "high",
        configured: "auto",
      }),
    );
    current.feed(
      reply(
        "recorded",
        NOW - 7_000,
        {
          serviceTier: "default",
          requestControls: { effort: { tail: "max" } },
        },
        "high",
      ),
    );
    expect(current.parser.effortMode?.value).toBe("max");
    current.feed(
      journal("message", "next", NOW - 6_000, {
        parentId: "recorded",
        message: { role: "user" },
      }),
    );
    expect(current.parser.effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
    expect(current.parser.speedMode?.value).toBe("fast");
    current.feed(
      journal("thinking_level_change", "missing", NOW - 5_000, {
        parentId: "next",
        configured: "max",
      }),
    );
    expect(current.parser.effortMode?.value).toBe("high");
    current.feed(
      journal("thinking_level_change", "clear", NOW - 4_000, {
        parentId: "missing",
        thinkingLevel: null,
        configured: "max",
      }),
    );
    expect(current.parser.effortMode).toBeNull();
    expect(current.parser.speedMode?.value).toBe("fast");
    current.feed(reply("cleared", NOW - 3_000, {}, "clear"));
    expect(current.latest().effortMode).toBeNull();
    current.feed(reply("fork", NOW - 2_000, {}, "high"));
    expect(current.latest().effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
    current.feed(reply("missing-parent", NOW - 1_000, { thinkingLevel: "max" }, "absent"));
    expect(current.latest().effortMode).toBeNull();
    current.feed(reply("root", NOW, { model: "model-max", effort: "high" }));
    expect(current.parser.effortMode).toBeNull();
    expect(current.parser.speedMode).toBeNull();
  });

  it.each([
    ["none", "off"],
    ["DISABLED", "off"],
    ["enabled", "on"],
    ["HIGH", "high"],
    ["extra-low", "extra-low"],
    ["auto", null],
    ["default", null],
    ["inherit", null],
    ["inherited", null],
    ["unknown", null],
    ["thinking_level_unspecified", null],
    ["high/path", null],
    ["max\nprivate", null],
    ["x".repeat(65), null],
    [null, null],
  ])("retains only native safe effort identifiers from %s", (native, value) => {
    const current = capture();
    current.feed(
      journal("thinking_level_change", "effort", NOW - 1_000, {
        thinkingLevel: native,
        configured: "max",
      }),
    );
    current.feed(reply("one", NOW, {}, "effort"));
    expect(current.latest().effortMode).toEqual(
      value === null ? null : { value, evidence: "selected", provider: null },
    );
    expect(current.latest().speedMode).toBeNull();
  });

  it.each([
    ["max", "low", "max", "recorded"],
    [null, "LOW", "low", "recorded"],
    [undefined, "low", "low", "recorded"],
    [42, "low", "low", "recorded"],
    ["auto", "low", "high", "selected"],
    ["", "low", "high", "selected"],
    ["max/private", "low", "high", "selected"],
    [null, null, "high", "selected"],
  ])(
    "uses native tail string precedence before validating it: %s / %s",
    (tail, topLevel, value, evidence) => {
      const current = capture();
      current.feed(
        journal("thinking_level_change", "effort", NOW - 1_000, {
          thinkingLevel: "high",
        }),
      );
      current.feed(
        reply("one", NOW, { requestControls: { effort: { tail, topLevel } } }, "effort"),
      );
      expect(current.latest().effortMode).toEqual({ value, evidence, provider: null });
      expect(current.parser.effortMode).toEqual(current.latest().effortMode);
      current.feed(journal("custom", "next", NOW + 1, { parentId: "one" }));
      expect(current.parser.effortMode).toEqual({
        value: "high",
        evidence: "selected",
        provider: null,
      });
    },
  );

  it("resolves each missing ancestor dimension without losing a later independent selection", () => {
    const current = capture();
    current.feed(
      journal("thinking_level_change", "tail-effort", NOW - 2_000, {
        parentId: "middle",
        thinkingLevel: "max",
      }),
      1_000,
    );
    current.feed(reply("latest", NOW - 1_000, {}, "tail-effort"), 1_100);
    expect(current.parser.effortMode?.value).toBe("max");
    expect(current.parser.speedMode).toBeNull();
    current.feed(
      journal("thinking_level_change", "old-effort", NOW + 5_000, {
        thinkingLevel: "low",
      }),
      100,
      true,
    );
    current.feed(
      journal("service_tier_change", "old-tier", NOW + 6_000, {
        parentId: "old-effort",
        serviceTier: { openai: "priority" },
      }),
      200,
      true,
    );
    current.feed(journal("custom", "middle", NOW + 7_000, { parentId: "old-tier" }), 300, true);
    expect(current.parser.effortMode?.value).toBe("max");
    expect(current.parser.speedMode?.value).toBe("fast");
    current.feed(
      journal("service_tier_change", "tail-tier", NOW, {
        parentId: "unknown-effort",
        serviceTier: { openai: "ultrafast" },
      }),
      1_200,
    );
    expect(current.parser.effortMode).toBeNull();
    expect(current.parser.speedMode?.value).toBe("ultrafast");
    current.feed(
      journal("thinking_level_change", "unknown-effort", NOW + 8_000, {
        thinkingLevel: "xhigh",
      }),
      400,
      true,
    );
    expect(current.parser.effortMode?.value).toBe("xhigh");
    expect(current.parser.speedMode?.value).toBe("ultrafast");
  });

  it("does not roll a newer recorded effort or provider family back during historical prefix replay", () => {
    const current = capture();
    current.feed(
      journal("thinking_level_change", "latest-effort", NOW - 2_000, {
        thinkingLevel: "high",
      }),
      1_000,
    );
    current.feed(
      reply(
        "latest",
        NOW - 1_000,
        {
          provider: "anthropic",
          serviceTier: "priority",
          requestControls: { effort: { tail: "max" } },
        },
        "latest-effort",
      ),
      1_100,
    );
    current.feed(
      journal("thinking_level_change", "latest-effort", NOW + 5_000, {
        thinkingLevel: "off",
      }),
      100,
      true,
    );
    current.feed(
      reply("history", NOW + 6_000, {
        provider: "openai",
        serviceTier: "default",
        requestControls: { effort: { topLevel: "low" } },
      }),
      200,
      true,
    );
    expect(current.parser.effortMode).toEqual({
      value: "max",
      evidence: "recorded",
      provider: null,
    });
    expect(current.parser.speedMode).toEqual({
      value: "fast",
      evidence: "recorded",
      provider: "anthropic",
    });
    expect(current.parser.provider).toBe("anthropic");
    current.feed(
      journal("message", "next", NOW, {
        parentId: "latest",
        message: { role: "user" },
      }),
      1_200,
    );
    expect(current.parser.effortMode).toEqual({
      value: "high",
      evidence: "selected",
      provider: null,
    });
    expect(current.parser.speedMode).toBeNull();
    expect(current.parser.phase).toBe("generating");
  });
});

describe("OMP local-day model and mode history", () => {
  it("keeps pooled range sums, unknown buckets, native evidence and model pricing separate", () => {
    const todayStart = new Date(NOW).setHours(0, 0, 0, 0);
    const previous = measured("one", "previous", todayStart - 2_000, todayStart - 1_000, 100, 20);
    const large = measured("one", "large", NOW - 13_000, NOW - 10_000, 600, 100);
    const small = measured("one", "small", NOW - 8_000, NOW - 6_000, 100, null);
    for (const response of [previous, small]) {
      response.effortMode = { value: "high", evidence: "selected", provider: null };
      response.speedMode = { value: "fast", evidence: "selected", provider: "openai" };
    }
    large.effortMode = { value: "high", evidence: "recorded", provider: null };
    large.speedMode = { value: "fast", evidence: "recorded", provider: "google" };
    const failed = {
      ...measured("two", "failed", NOW - 5_000, NOW - 4_000, 50, null, "model-b"),
      startMs: null,
      measuredOutputTokens: 0,
      measuredDurationMs: 0,
      failedRequests: 1,
    };
    const side: NumericResponse = {
      ...measured("one", "side", NOW - 3_000, NOW - 2_000, 100, null),
      model: null,
      sideCall: true,
      startMs: null,
      measuredOutputTokens: 0,
      measuredDurationMs: 0,
      speedMode: { value: "standard", evidence: "selected", provider: "anthropic" },
    };
    const responses = [previous, large, small, failed, side];
    const history = new OmpMonitorHistory((response) =>
      response.model === "model-a" ? response.outputTokens / 1_000 : null,
    );
    const projection = history.getDays(ALL, responses, NOW, 1, "prices-one");
    const today = projection.days.at(-1)!;
    expect(today.agentCount).toBe(2);
    expect(projection.days.at(-2)!.agentCount).toBe(1);
    expect(projection.breakdowns.models.filter((row) => row.date === today.date)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "model-a",
          source: "omp",
          requests: 2,
          outputTokens: 700,
          measuredOutputTokens: 700,
          measuredDurationMs: 5_000,
          costUsd: 1_998,
          estimatedCostUsd: 0.7,
          unestimatedRequests: 0,
        }),
        expect.objectContaining({
          model: "model-b",
          requests: 1,
          outputTokens: 50,
          measuredOutputTokens: 0,
          measuredDurationMs: 0,
          unestimatedRequests: 1,
        }),
        expect.objectContaining({
          model: null,
          requests: 1,
          outputTokens: 100,
          measuredOutputTokens: 0,
          measuredDurationMs: 0,
          unestimatedRequests: 1,
        }),
      ]),
    );
    const effort = projection.breakdowns.modes.filter(
      (row) => row.date === today.date && row.kind === "effort",
    );
    expect(effort).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "high", evidence: "recorded", outputTokens: 600 }),
        expect.objectContaining({ value: "high", evidence: "selected", outputTokens: 100 }),
        expect.objectContaining({
          value: null,
          evidence: null,
          provider: null,
          model: "model-b",
          outputTokens: 50,
        }),
        expect.objectContaining({
          value: null,
          evidence: null,
          provider: null,
          model: null,
          outputTokens: 100,
        }),
      ]),
    );
    for (const day of projection.days) {
      const models = projection.breakdowns.models.filter((row) => row.date === day.date);
      for (const rows of [
        models,
        projection.breakdowns.modes.filter((row) => row.date === day.date && row.kind === "effort"),
        projection.breakdowns.modes.filter((row) => row.date === day.date && row.kind === "speed"),
      ]) {
        expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(day.requests);
        expect(rows.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(day.outputTokens);
        expect(rows.reduce((sum, row) => sum + row.measuredOutputTokens, 0)).toBe(
          day.measuredOutputTokens,
        );
        expect(rows.reduce((sum, row) => sum + row.measuredDurationMs, 0)).toBe(
          day.measuredDurationMs,
        );
      }
    }
    const selectedModel = projection.breakdowns.models.filter((row) => row.model === "model-a");
    expect(
      (selectedModel.reduce((sum, row) => sum + row.measuredOutputTokens, 0) * 1_000) /
        selectedModel.reduce((sum, row) => sum + row.measuredDurationMs, 0),
    ).toBeCloseTo(800 / 6);
    expect(today.measuredOutputTokens / (today.measuredDurationMs / 1_000)).toBe(140);
    expect(JSON.stringify(projection.breakdowns)).not.toMatch(
      /agentId|completionState|requestControls|previous|private/,
    );
    const revised = history.getDays(
      ALL,
      [previous, { ...large, effortMode: null }, small, failed, side],
      NOW,
      2,
      "prices-one",
    );
    expect(revised.days).toEqual(projection.days);
    expect(
      revised.breakdowns.modes
        .filter((row) => row.date === today.date && row.kind === "effort" && row.value === "high")
        .reduce((sum, row) => sum + row.outputTokens, 0),
    ).toBe(100);
    expect(
      revised.breakdowns.modes
        .filter((row) => row.date === today.date && row.kind === "effort" && row.value === null)
        .reduce((sum, row) => sum + row.outputTokens, 0),
    ).toBe(750);
  });

  it("keeps total peak provenance on its own actual winning window", () => {
    const outputWinner = {
      ...measured("one", "output", NOW - 12_000, NOW - 11_000, 300, null),
      feedbackEligible: false,
    };
    const totalWinner = {
      ...measured("one", "total", NOW - 2_000, NOW - 1_000, 30, null),
      inputTokens: 3_000,
      totalTokens: 999_999,
      feedbackEligible: true,
    };
    const history = new OmpMonitorHistory();
    const projection = history.getDays(ALL, [outputWinner, totalWinner], NOW, 1, "prices");
    expect(projection.peaks.at(-1)).toEqual({
      value: 100,
      at: NOW - 11_000,
      observedAt: null,
    });
    expect(projection.totalPeaks.at(-1)).toEqual({
      value: 1_010,
      at: NOW - 1_000,
      observedAt: NOW - 1_000,
    });
    expect(projection.days.at(-1)).toMatchObject({ peakOutputTps: 100, peakTotalTps: 1_010 });
    const captured = history.getDays(
      ALL,
      [outputWinner, { ...totalWinner, feedbackEligible: false }],
      NOW,
      2,
      "prices",
    );
    expect(captured.totalPeaks.at(-1)).toEqual({
      value: 1_010,
      at: NOW - 1_000,
      observedAt: null,
    });
  });

  it("retains sparse 90-day, year and All facts without expanding extreme calendar spans", () => {
    const ancient = new Date(0);
    ancient.setFullYear(1, 0, 1);
    ancient.setHours(12, 0, 0, 0);
    const earliest: NumericResponse = {
      ...measured("one", "ancient", ancient.getTime() - 1_000, ancient.getTime(), 10, null),
      startMs: null,
      measuredOutputTokens: 0,
      measuredDurationMs: 0,
    };
    const responses = [earliest];
    for (const ago of [45, 120, 400]) {
      const at = new Date(NOW);
      at.setDate(at.getDate() - ago);
      responses.push(measured("one", `past-${ago}`, at.getTime() - 1_000, at.getTime(), ago, null));
    }
    const history = new OmpMonitorHistory();
    const projection = history.getDays(
      ALL,
      [
        ...responses,
        { ...earliest, key: "unsafe-date", endMs: Number.MAX_SAFE_INTEGER },
        { ...earliest, key: "year-zero", endMs: Date.parse("0000-01-01T12:00:00Z") },
      ],
      NOW,
      1,
      "prices",
    );
    expect(projection.days).toHaveLength(34);
    expect(projection.startDate).toBe("0001-01-01");
    expect(projection.endDate).toBe(calendarDay(NOW)!.date);
    expect(projection.days.reduce((sum, day) => sum + day.requests, 0)).toBe(4);
    expect(projection.days.reduce((sum, day) => sum + day.outputTokens, 0)).toBe(575);
    expect(projection.breakdowns.models).toHaveLength(4);
    expect(projection.breakdowns.modes).toHaveLength(8);
    expect(projection.limited).toBe(true);
    expect(currentDayUsage(projection.days).requests).toBe(0);
    const next = history.getDays(ALL, responses, NOW + 31 * 86_400_000, 2, "prices");
    expect(next.startDate).toBe("0001-01-01");
    expect(next.days.reduce((sum, day) => sum + day.requests, 0)).toBe(4);
    expect(next.days.length).toBeLessThanOrEqual(34);
  });

  it("keeps real archived cross-midnight peak days in the available range without inventing gap days", () => {
    const midnight = new Date(2020, 3, 6).getTime();
    const response = measured("one", "cross-midnight", midnight - 500, midnight + 500, 100, null);
    const projection = new OmpMonitorHistory().getDays(ALL, [response], NOW, 1, "prices");
    const first = calendarDay(midnight - 500)!.date;
    const last = calendarDay(midnight + 500)!.date;
    expect(projection.startDate).toBe(first);
    expect(projection.days).toHaveLength(32);
    expect(projection.days.find((day) => day.date === first)).toMatchObject({
      requests: 0,
      agentCount: 0,
    });
    expect(projection.days.find((day) => day.date === last)).toMatchObject({
      requests: 1,
      measuredOutputTokens: 100,
      measuredDurationMs: 1_000,
      agentCount: 1,
    });
    expect(projection.days.find((day) => day.date === first)!.peakOutputTps).toBeCloseTo(50 / 3);
    expect(projection.days.find((day) => day.date === last)!.peakOutputTps).toBeCloseTo(50 / 3);
    expect(projection.limited).toBe(false);
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
      totalTps: 130,
      liveMeasuredTps: 40,
      liveEstimatedTps: 40,
      thinkingTps: 40,
      liveCostUsdPerSecond: 4,
      parentId: null,
    });
    expect(subagent).toMatchObject({
      outputTps: 100,
      totalTps: 610 / 6,
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
    expect(parent.liveMeasuredTotalTps).toBeCloseTo(130 / 3);
    expect(parent.liveEstimatedTotalTps).toBeCloseTo(130 / 3);
    expect(subagent.liveMeasuredTotalTps).toBeCloseTo(610 / 6);
    expect(subagent.liveEstimatedTotalTps).toBe(0);
    expect(total.measuredTotalTps).toBeCloseTo(145);
    expect(total.estimatedTotalTps).toBeCloseTo(130 / 3);
    expect(activity.agents.reduce((sum, agent) => sum + agent.liveMeasuredTotalTps, 0)).toBeCloseTo(
      total.measuredTotalTps,
    );
    expect(
      activity.agents.reduce((sum, agent) => sum + agent.liveEstimatedTotalTps, 0),
    ).toBeCloseTo(total.estimatedTotalTps);
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
      totalTps: 210,
      liveEstimatedTotalTps: 210,
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
      const expectedTotalSpeed = sameModel ? 105 : 1_120 / 3;
      expect(activity.agents[0]).toMatchObject({ liveMeasuredTps: 0, liveCostUsdPerSecond: 2 });
      expect(activity.agents[0]!.outputTps).toBeCloseTo(expectedSpeed);
      expect(activity.agents[0]!.liveEstimatedTps).toBeCloseTo(expectedSpeed);
      expect(activity.agents[0]!.totalTps).toBeCloseTo(expectedTotalSpeed);
      expect(activity.agents[0]!.liveEstimatedTotalTps).toBeCloseTo(expectedTotalSpeed);
      expect(activity.agents[0]!.thinkingTps).toBeCloseTo(expectedThinking);
      const live = liveMetrics(facts.responses, activity.estimates, NOW);
      expect(live).toMatchObject({ measuredTps: 0, measuredThinkingTps: null });
      expect(live.estimatedTps).toBeCloseTo(expectedSpeed);
      expect(live.estimatedTotalTps).toBeCloseTo(expectedTotalSpeed);
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
      totalTps: 110,
      liveMeasuredTps: 0,
      liveEstimatedTps: 0,
      liveMeasuredTotalTps: 0,
      liveEstimatedTotalTps: 0,
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
      totalTps: null,
      liveMeasuredTps: 0,
      liveEstimatedTps: 0,
      liveMeasuredTotalTps: 0,
      liveEstimatedTotalTps: 0,
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

describe("OMP native total throughput", () => {
  it("includes cached input but never double-counts reasoning or billed orchestration", () => {
    const current = capture();
    current.feed(
      reply("one", NOW, {
        timestamp: NOW - 3_000,
        duration: 3_000,
        usage: {
          input: 100,
          output: 300,
          cacheRead: 200,
          cacheWrite: 400,
          reasoningTokens: 200,
          totalTokens: 999_999,
        },
      }),
    );
    const main = file(path.join("bucket", "main.jsonl"), 0);
    const response = { ...current.latest(), agentId: main.id };
    const side = { ...response, key: "side", sideCall: true };
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses(
      [candidate(main, response), candidate(main, side)],
      files.ids,
      NOW,
    );
    const activity = projectActivity(files, facts, NOW);
    const live = liveMetrics(facts.responses, activity.estimates, NOW);
    expect(response.totalTokens).toBe(999_999);
    expect(live.measuredTps).toBe(100);
    expect(live.measuredTotalTps).toBeCloseTo(1_000 / 3);
    expect(live.estimatedTotalTps).toBe(0);
    expect(activity.agents[0]!.totalTps).toBeCloseTo(1_000 / 3);
    expect(activity.agents[0]!.liveMeasuredTotalTps).toBeCloseTo(1_000 / 3);
    for (const seriesPoint of live.series.filter(
      (point) => point.timestamp >= NOW - 3_000 && point.timestamp < NOW,
    )) {
      expect(seriesPoint.measuredTps).toBe(100);
      expect(seriesPoint.measuredTotalTps).toBeCloseTo(1_000 / 3);
      expect(seriesPoint.estimatedTotalTps).toBe(0);
    }
  });

  it("can estimate a real input-only reference without manufacturing output throughput", () => {
    const main = file(path.join("bucket", "main.jsonl"), 0);
    main.parser.phase = "generating";
    main.parser.inFlightStartMs = NOW - 3_000;
    const response = measured(main.id, "input-only", NOW - 11_000, NOW - 10_000, 0, null);
    const files = scopeFiles([main], ALL);
    const facts = scopeResponses([candidate(main, response)], files.ids, NOW);
    const activity = projectActivity(files, facts, NOW);
    expect(activity.agents[0]).toMatchObject({
      outputTps: 0,
      totalTps: 10,
      liveEstimatedTps: 0,
      liveEstimatedTotalTps: 10,
    });
    expect(liveMetrics(facts.responses, activity.estimates, NOW)).toMatchObject({
      measuredTps: 0,
      estimatedTps: 0,
      measuredTotalTps: 0,
      estimatedTotalTps: 10,
    });
  });
});
