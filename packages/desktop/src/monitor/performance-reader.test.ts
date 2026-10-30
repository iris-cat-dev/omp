import { describe, expect, it } from "vitest";
import { OmpPerformanceLineReader, performanceModel } from "./performance-reader.js";
import { hashId } from "./parser.js";

const START = Date.parse("2026-10-30T10:00:00Z");
function line(id: string, atMs: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", id, timestamp: new Date(atMs).toISOString(), message });
}
function assistant(id: string, start: number, extra: Record<string, unknown> = {}): string {
  return line(id, start + 1000, {
    role: "assistant",
    model: "raw-model",
    provider: "fixture",
    api: "fixture",
    timestamp: start,
    duration: 1000,
    stopReason: "stop",
    usage: { input: 10, output: 50, cacheRead: 30, cacheWrite: 40 },
    content: [{ type: "text", text: "PRIVATE ANSWER" }],
    ...extra,
  });
}
function reader(atMs = START): OmpPerformanceLineReader {
  const stream = new OmpPerformanceLineReader();
  stream.read(
    JSON.stringify({
      type: "session",
      timestamp: new Date(atMs).toISOString(),
      cwd: "C:\\PRIVATE\\WORKSPACE",
    }),
  );
  return stream;
}

describe("OMP v1.6 numeric performance extraction", () => {
  it("keeps exact normalized OMP input and native measured timestamps, but never invents firstMs from ttft", () => {
    const stream = reader();
    stream.read(
      assistant("normal", START + 1000, {
        duration: 1000.9,
        ttft: 25,
        firstMs: START + 1025,
        usage: {
          input: 10,
          output: 50,
          cacheRead: 30,
          cacheWrite: 40,
          reasoningTokens: 15,
          totalTokens: 9999,
        },
      }),
    );
    expect(stream.facts(() => true).responses).toEqual([
      {
        key: hashId(`omp:normal:${START + 1000}`),
        model: "raw-model",
        startMs: START + 1000,
        endMs: START + 2000,
        firstMs: null,
        final: true,
        input: 80,
        cachedInput: 30,
        output: 50,
        reasoning: 15,
      },
    ]);
    const text = JSON.stringify(stream.facts(() => true));
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("totalTokens");
    expect(text).not.toContain("ttft");
  });

  it("uses the original completedAt/entry fallbacks, final values and failed/missing-stop timing boundaries", () => {
    const stream = reader();
    stream.read(
      assistant("fallback", START + 1000, { duration: undefined, completedAt: START + 2400.9 }),
    );
    stream.read(
      assistant("entry", START + 3000, {
        timestamp: undefined,
        duration: 99,
        completedAt: undefined,
      }),
    );
    stream.read(assistant("aborted", START + 5000, { stopReason: "aborted" }));
    stream.read(assistant("error", START + 7000, { stopReason: "error" }));
    stream.read(assistant("missing-stop", START + 9000, { stopReason: undefined }));
    stream.read(
      assistant("placeholder", START + 11_000, {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
      }),
    );
    const facts = stream.facts(() => true);
    expect(facts.responses).toHaveLength(5);
    expect(facts.responses[0]).toMatchObject({
      startMs: START + 1000,
      endMs: START + 2400,
      final: true,
    });
    expect(facts.responses[1]).toMatchObject({ startMs: null, endMs: START + 4000 });
    expect(
      facts.responses
        .slice(2)
        .every((response) => response.startMs === null && response.final === true),
    ).toBe(true);
    expect(facts.completions).toHaveLength(1);
  });

  it("does not count copied pre-header history, side calls, unguarded assistant entries or second headers", () => {
    const stream = reader(START + 10_000);
    stream.read(assistant("copied", START));
    stream.read(JSON.stringify({ type: "session", timestamp: new Date(START).toISOString() }));
    stream.read(assistant("copied-again", START + 1000));
    stream.read(assistant("guard", START + 11_000, { provider: undefined }));
    stream.read(
      JSON.stringify({
        type: "model_usage",
        id: "side",
        timestamp: new Date(START + 12_000).toISOString(),
        model: "side-model",
        api: "fixture",
        provider: "fixture",
        usage: { input: 1, output: 1000 },
      }),
    );
    stream.read(assistant("kept", START + 13_000));
    expect(stream.facts(() => true).responses).toHaveLength(1);
    expect(stream.facts(() => true).responses[0]?.key).toBe(hashId(`omp:kept:${START + 13_000}`));
  });

  it("takes the first valid result, requires a named call, and never grades result text or command arguments", () => {
    const stream = reader();
    stream.read(
      line("early-result", START + 1, { role: "toolResult", toolCallId: "later", isError: true }),
    );
    stream.read(
      assistant("calls", START + 1000, {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "one",
            name: "bash",
            arguments: { command: "PRIVATE COMMAND", path: "C:\\PRIVATE\\FILE" },
          },
          { type: "toolCall", id: "nameless", arguments: {} },
          { type: "toolCall", id: "later", name: "read", arguments: { path: "/PRIVATE" } },
        ],
      }),
    );
    stream.read(
      line("first", START + 2500, {
        role: "toolResult",
        toolCallId: "one",
        isError: false,
        content: [{ type: "text", text: "999 failed, exit code 99: PRIVATE OUTPUT" }],
        details: { exitCode: 99 },
      }),
    );
    stream.read(
      line("duplicate", START + 3000, { role: "toolResult", toolCallId: "one", isError: true }),
    );
    stream.read(
      line("later-result", START + 3200, {
        role: "toolResult",
        toolCallId: "later",
        isError: true,
      }),
    );
    const facts = stream.facts(() => true);
    expect(facts.actions).toEqual([
      { callMs: START + 2000, resultMs: START + 2500, failed: false, model: "raw-model" },
      { callMs: START + 2000, resultMs: START + 3200, failed: true, model: "raw-model" },
    ]);
    expect(JSON.stringify(facts)).not.toMatch(/PRIVATE|command|arguments|exitCode|bash|toolCallId/);
  });

  it("retains the last 64 calls in FILE order while history still sees every completion", () => {
    const stream = reader();
    for (let i = 0; i < 70; i++) {
      const atMs = START + 100_000 - i * 1000;
      stream.read(
        assistant(`response-${i}`, atMs - 1000, {
          content: [{ type: "toolCall", id: `call-${i}`, name: "fixture" }],
        }),
      );
      stream.read(line(`result-${i}`, atMs + 100, { role: "toolResult", toolCallId: `call-${i}` }));
    }
    const facts = stream.facts(() => true);
    expect(facts.actions).toHaveLength(64);
    expect(facts.actions[0]?.callMs).toBe(START + 94_000);
    expect(facts.actions.at(-1)?.callMs).toBe(START + 31_000);
    expect(facts.completions.filter((completion) => "action" in completion)).toHaveLength(70);
    // The live WorkLog forgets evicted IDs; the uncapped history log still counts an ID only once.
    stream.read(
      assistant("reused-id", START + 200_000, {
        content: [{ type: "toolCall", id: "call-0", name: "fixture" }],
      }),
    );
    stream.read(
      line("reused-result", START + 201_100, {
        role: "toolResult",
        toolCallId: "call-0",
        isError: true,
      }),
    );
    const reused = stream.facts(() => true);
    expect(reused.actions).toHaveLength(64);
    expect(reused.actions.at(-1)).toMatchObject({
      callMs: START + 201_000,
      resultMs: START + 201_100,
      failed: true,
    });
    expect(reused.completions.filter((completion) => "action" in completion)).toHaveLength(70);
  });

  it("resolves revisions at the first measured completion, not at their last upsert", () => {
    const stream = reader();
    stream.read(assistant("first", START + 1000, { stopReason: "aborted" }));
    stream.read(assistant("second", START + 3000));
    stream.read(assistant("first", START + 1000));
    stream.read(assistant("first", START + 1000, { usage: { input: 10, output: 125 } }));
    expect(stream.facts(() => true).completions).toEqual([
      { key: hashId(`omp:second:${START + 3000}`) },
      { key: hashId(`omp:first:${START + 1000}`) },
    ]);
    expect(
      stream
        .facts(() => true)
        .responses.find((response) => response.key === hashId(`omp:first:${START + 1000}`))?.output,
    ).toBe(125);
  });

  it("marks malformed gaps without inventing a failure or task boundary, and rejects another owner's calls", () => {
    const stream = reader();
    stream.read(
      assistant("owner", START + 1000, {
        content: [{ type: "toolCall", id: "call", name: "fixture" }],
      }),
    );
    stream.read("{not valid json}");
    stream.read(line("result", START + 2500, { role: "toolResult", toolCallId: "call" }));
    expect(stream.limited).toBe(true);
    expect(stream.facts(() => true).actions[0]).toMatchObject({
      resultMs: START + 2500,
      failed: false,
    });
    expect(stream.facts(() => false)).toEqual({ responses: [], actions: [], completions: [] });
    expect(performanceModel("C:\\PRIVATE\\model")).toBeNull();
    expect(performanceModel("https://PRIVATE/model")).toBeNull();
    expect(performanceModel("vendor/raw-model:20261030")).toBe("vendor/raw-model:20261030");
  });

  it("honors native same-key side-call corrections without ever turning a side call into a measured sample", () => {
    const stream = reader(),
      start = START + 1000;
    stream.read(assistant("shared-identity", start));
    expect(stream.facts(() => true).responses[0]?.startMs).toBe(start);
    stream.read(
      JSON.stringify({
        type: "model_usage",
        id: "shared-identity",
        timestamp: new Date(start).toISOString(),
        model: "side-model",
        provider: "fixture",
        api: "fixture",
        usage: { input: 1, output: 2 },
      }),
    );
    expect(stream.facts(() => true).responses).toEqual([
      expect.objectContaining({ startMs: null, endMs: start, model: "side-model" }),
    ]);
    expect(stream.facts(() => true).completions).toEqual([
      { key: hashId(`omp:shared-identity:${start}`) },
    ]);
    expect(stream.requests.size).toBe(1);
  });
});
