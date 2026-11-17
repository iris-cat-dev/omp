import { describe, expect, test } from "vitest";
import { AgentTimelineItemPayloadSchema } from "@omp-desktop/protocol/messages";
import type { AgentStreamEvent, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { mergeToolCallItems } from "../../timeline-projection.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { OmpHistoryMapper } from "./message-history.js";
import { OmpSubagentLiveMapper } from "./subagent-live-mapper.js";
import { parseShellBuildProgress, projectShellExecution } from "./shell-execution.js";
import { parseToolArgs, parseToolResult } from "./tool-call-detail.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

function buildTrace() {
  const first = "echo 中文";
  const second = "cmake --build 构建";
  return {
    v: 1,
    seq: 8,
    t_ns: 100,
    script: `${first}\n${second}`,
    units: [
      {
        at: 0,
        line: 1,
        bytes: Buffer.byteLength(first),
        nodes: [
          {
            k: "simple",
            lo: 0,
            hi: Buffer.byteLength(first),
            state: "ok",
            st: 0,
            at: 1,
            end_ns: 10,
          },
        ],
      },
      {
        at: Buffer.byteLength(first) + 1,
        line: 2,
        bytes: Buffer.byteLength(second),
        syntax: { opaque: true },
        nodes: [{ k: "simple", lo: 0, hi: Buffer.byteLength(second), state: "running", at: 11 }],
      },
    ],
    history: [
      { kind: "Output", seq: 6, t_ns: 12, u: 1, n: 0, fd: 1, text: "[12/" },
      { kind: "Output", seq: 7, t_ns: 13, u: 0, n: 0, fd: 2, text: "earlier command output\n" },
      {
        kind: "Output",
        seq: 8,
        t_ns: 14,
        u: 1,
        n: 0,
        fd: 1,
        text: "24] Building CXX object 中文.o\n",
      },
    ],
  };
}

function toolItem(events: AgentStreamEvent[]): ToolCallTimelineItem {
  const event = events.find(
    (entry) => entry.type === "timeline" && entry.item.type === "tool_call",
  );
  if (!event || event.type !== "timeline" || event.item.type !== "tool_call")
    throw new Error("Missing tool call");
  return event.item;
}

describe("shell execution display projection", () => {
  test("converts UTF-8 byte spans and joins attributed output fragments without leaking journals", () => {
    const trace = buildTrace();
    const execution = projectShellExecution(trace);
    expect(execution).toEqual({
      seq: 8,
      state: "running",
      steps: [
        { id: "0:0", command: "echo 中文", state: "ok", exitCode: 0 },
        { id: "1:0", command: "cmake --build 构建", state: "running" },
      ],
      currentStepId: "1:0",
      totalSteps: 2,
      truncated: false,
      progress: { kind: "fraction", completed: 12, total: 24, label: "Building CXX object 中文.o" },
    });
    expect(JSON.stringify(execution)).not.toContain("history");
    expect(JSON.stringify(execution)).not.toContain("opaque");
  });

  test("reads CMake carriage-return progress, rejects invalid counts and leaves unknown progress absent", () => {
    expect(
      parseShellBuildProgress(
        "\x1b[32m[ 25%] Building CXX object a.o\x1b[0m\r[ 50%] Linking CXX executable app\n",
      ),
    ).toEqual({ kind: "percentage", percentage: 50, label: "Linking CXX executable app" });
    expect(parseShellBuildProgress("Compiling...\n")).toBeUndefined();
    expect(parseShellBuildProgress("[101%] bad\n[5/4] bad\n[0/0] bad")).toBeUndefined();
  });

  test("does not attach a previous command's 100% to a new running command", () => {
    const trace = buildTrace();
    trace.history = [
      { kind: "Output", seq: 8, t_ns: 10, u: 0, n: 0, fd: 1, text: "[100%] Built target app\n" },
    ];
    expect(projectShellExecution(trace, "[100%] Built target app\n")?.progress).toBeUndefined();
  });

  test("keeps logs when a trace is malformed and supports unlocated non-UTF-8 source bytes", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: "Compiling..." }],
      details: {
        trace: {
          ...buildTrace(),
          units: [{ line: 1, nodes: [{ k: "simple", lo: -1, hi: 5, state: "running" }] }],
        },
      },
    });
    expect(mapOmpToolDetail(parseToolArgs("bash", { command: "build" }), result)).toEqual({
      type: "shell",
      command: "build",
      output: "Compiling...",
      exitCode: null,
    });
    expect(
      projectShellExecution({
        v: 1,
        seq: 1,
        t_ns: 1,
        script: "eval",
        units: [
          {
            line: 1,
            source: [101, 99, 104, 111, 32, 255],
            nodes: [{ k: "simple", lo: 0, hi: 6, state: "ok", st: 0 }],
          },
        ],
      })?.steps[0]?.command,
    ).toBe("echo �");
  });

  test("bounds large scripts while retaining the current command and the protocol accepts the projection", () => {
    const units = Array.from({ length: 200 }, (_, index) => ({
      line: 1,
      source: `echo ${index} ${"x".repeat(2000)}`,
      nodes: [
        {
          k: "simple",
          lo: 0,
          hi: 2006 + String(index).length,
          state: index === 0 ? "running" : "pending",
          at: index === 0 ? 1 : undefined,
        },
      ],
    }));
    const execution = projectShellExecution({ v: 1, seq: 2, t_ns: 2, script: "", units });
    expect(execution?.steps).toHaveLength(64);
    expect(execution?.currentStepId).toBe("0:0");
    expect(execution?.steps[0]?.command.length).toBeLessThanOrEqual(1024);
    expect(execution?.totalSteps).toBe(200);
    expect(execution?.truncated).toBe(true);
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "tool_call",
        callId: "build",
        name: "bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "build", execution },
      }),
    ).toMatchObject({ detail: { execution } });
  });

  test("live, persisted and subagent calls use the same measured execution projection", () => {
    const command = buildTrace().script;
    const result = {
      content: [{ type: "text" as const, text: "Compiling...\n" }],
      details: { trace: buildTrace() },
    };
    const live = mapOmpToolDetail(parseToolArgs("bash", { command }), parseToolResult(result), {
      toolCallId: "build",
      toolCallStatus: "running",
    });
    const child = new OmpSubagentLiveMapper();
    child.map({
      type: "tool_execution_start",
      toolCallId: "build",
      toolName: "bash",
      args: { command },
    });
    const childLive = toolItem(
      child.map({
        type: "tool_execution_update",
        toolCallId: "build",
        toolName: "bash",
        partialResult: result,
      }),
    );
    expect(childLive.detail).toEqual(live);
    const history = new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS);
    const events = history.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "build", name: "bash", arguments: { command } }],
      },
      { role: "toolResult", toolCallId: "build", toolName: "bash", ...result },
    ]);
    const finished = events.findLast(
      (event) => event.type === "timeline" && event.item.type === "tool_call",
    );
    expect(finished).toMatchObject({
      item: {
        status: "completed",
        detail: {
          type: "shell",
          output: result.content[0]!.text,
          execution: { state: "ok", progress: { kind: "fraction", completed: 12, total: 24 } },
        },
      },
    });
    const resultOnly = new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS);
    const recovered = toolItem(
      resultOnly.mapMessages([
        { role: "toolResult", toolCallId: "build", toolName: "bash", ...result },
      ]),
    );
    expect(recovered.detail).toMatchObject({
      type: "shell",
      command,
      execution: { state: "ok", progress: { kind: "fraction", completed: 12, total: 24 } },
    });
    expect(JSON.stringify(recovered.detail)).not.toContain("history");
  });

  test("history and subagent cancellation remain stopped when late frames arrive", () => {
    const command = buildTrace().script;
    const result = {
      content: [{ type: "text" as const, text: "Stopped" }],
      isError: true,
      details: { trace: buildTrace(), cancelled: true },
    };
    const history = new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS);
    history.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "build", name: "bash", arguments: { command } }],
      },
    ]);
    expect(
      toolItem(
        history.mapMessages([
          { role: "toolResult", toolCallId: "build", toolName: "bash", ...result },
        ]),
      ),
    ).toMatchObject({
      status: "canceled",
      error: null,
      detail: { execution: { state: "canceled", termination: "canceled" } },
    });
    const child = new OmpSubagentLiveMapper();
    child.map({
      type: "tool_execution_start",
      toolCallId: "build",
      toolName: "bash",
      args: { command },
    });
    expect(
      toolItem(
        child.map({
          type: "tool_execution_end",
          toolCallId: "build",
          toolName: "bash",
          result,
          isError: true,
        }),
      ),
    ).toMatchObject({
      status: "canceled",
      error: null,
      detail: { execution: { state: "canceled", steps: [{ state: "ok" }, { state: "canceled" }] } },
    });
    expect(
      child.map({
        type: "tool_execution_update",
        toolCallId: "build",
        toolName: "bash",
        partialResult: { details: { trace: buildTrace() } },
      }),
    ).toEqual([]);
  });

  test("cancellation and timeout preserve final trace but stop all running steps", () => {
    const command = buildTrace().script;
    for (const [field, termination, state] of [
      ["cancelled", "canceled", "canceled"],
      ["timedOut", "timed_out", "fail"],
    ] as const) {
      const result = parseToolResult({
        content: [{ type: "text", text: "Compiling..." }],
        isError: true,
        details: {
          trace: buildTrace(),
          [field]: true,
          exitCode: field === "cancelled" ? 130 : 124,
        },
      });
      const detail = mapOmpToolDetail(parseToolArgs("bash", { command }), result, {
        toolCallId: "build",
        toolCallStatus: "failed",
      });
      expect(detail).toMatchObject({
        execution: { state, termination, steps: [{ state: "ok" }, { state }] },
        exitCode: field === "cancelled" ? 130 : 124,
      });
    }
    const detail = mapOmpToolDetail(
      parseToolArgs("bash", { command }),
      parseToolResult({ details: { trace: buildTrace() } }),
      { toolCallId: "build", toolCallStatus: "running" },
    );
    if (!detail) throw new Error("Missing detail");
    const running: ToolCallTimelineItem = {
      type: "tool_call",
      callId: "build",
      name: "bash",
      status: "running",
      error: null,
      detail,
    };
    const canceled = mergeToolCallItems(running, {
      ...running,
      status: "canceled",
      detail: { type: "shell", command },
    });
    expect(canceled).toMatchObject({
      status: "canceled",
      detail: { execution: { state: "canceled", steps: [{ state: "ok" }, { state: "canceled" }] } },
    });
    expect(mergeToolCallItems(canceled, running)).toBe(canceled);
    expect(mergeToolCallItems(canceled, { ...running, status: "completed" })).toMatchObject({
      status: "canceled",
      detail: { execution: { state: "canceled" } },
    });
  });
});
