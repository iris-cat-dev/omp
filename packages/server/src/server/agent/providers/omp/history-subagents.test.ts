import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamOmpHistory, streamOmpSubagentHistory, type OmpHistoryInput } from "./history.js";
import type { OmpAgentMessage } from "./rpc-types.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { parent: string; child: (id: string) => string } {
  const directory = mkdtempSync(join(tmpdir(), "omp-native-history-"));
  directories.push(directory);
  return {
    parent: join(directory, "parent.jsonl"),
    child: (id) => join(directory, "parent", `${id}.jsonl`),
  };
}

function writeMessages(file: string, messages: OmpAgentMessage[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const entries = [
    { type: "session", id: "root", timestamp: "2026-10-01T00:00:00Z" },
    ...messages.map((message, index) => ({
      type: message.role === "custom" ? "custom_message" : "message",
      id: `entry-${index}`,
      parentId: index === 0 ? "root" : `entry-${index - 1}`,
      timestamp: `2026-10-01T00:00:${String(index + 1).padStart(2, "0")}Z`,
      ...(message.role === "custom" ? message : { message }),
    })),
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function taskDispatch(callId: string, details: object, isError = false): OmpAgentMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "task", arguments: { tasks: [{ task: "Inspect" }] } }],
    },
    { role: "toolResult", toolName: "task", toolCallId: callId, content: [{ type: "text", text: "Dispatched" }], details, isError },
  ];
}

async function recover(input: OmpHistoryInput): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamOmpSubagentHistory(input)) events.push(event);
  return events;
}

function children(events: AgentStreamEvent[]) {
  return events.flatMap((event) => event.type === "provider_subagent" ? [event.event] : []);
}

describe("native persisted subagent recovery", () => {
  test("recovers async results=[] transcripts without leaking the parent's timeline", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, [
      { role: "user", content: "Parent prompt" },
      ...taskDispatch("spawn", {
        results: [],
        progress: [{ id: "Worker", agent: "scout", status: "running" }],
        async: { type: "task", state: "running", jobId: "Worker" },
      }),
    ]);
    const raw: OmpAgentMessage = {
      role: "assistant", responseId: "child-response", timestamp: 1234,
      content: [{ type: "thinking", thinking: "Inspecting" }, { type: "text", text: "Recovered answer" }],
    };
    writeMessages(child("Worker"), [raw]);
    const native: Array<{ id: string; messages: readonly OmpAgentMessage[] }> = [];
    const events = await recover({ sessionFile: parent, provider: "omp", onSubagentTranscript: (id, messages) => native.push({ id, messages }) });
    expect(events.every((event) => event.type === "provider_subagent")).toBe(true);
    const recovered = children(events);
    expect(recovered[0]).toMatchObject({ type: "upsert", id: "Worker", title: "scout", toolCallId: "spawn" });
    expect(recovered[0]).not.toHaveProperty("status");
    expect(recovered).toContainEqual(expect.objectContaining({ type: "timeline", id: "Worker", item: expect.objectContaining({ type: "assistant_message", text: "Recovered answer" }) }));
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "completed" });
    expect(native).toEqual([{ id: "Worker", messages: [raw] }]);
  });

  test("replays one transcript across multiple calls and keeps the latest child outcome", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, [
      ...taskDispatch("first", { results: [{ id: "Worker", exitCode: 0 }] }),
      ...taskDispatch("resume", { results: [{ id: "Worker", aborted: true, exitCode: 1 }] }),
    ]);
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Once" }] }]);
    const nativeIds: string[] = [];
    const recovered = children(await recover({ sessionFile: parent, provider: "omp", onSubagentTranscript: (id) => nativeIds.push(id) }));
    expect(recovered.filter((event) => event.type === "timeline" && event.item.type === "assistant_message")).toHaveLength(1);
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "canceled", toolCallId: "resume" });
    expect(nativeIds).toEqual(["Worker"]);
  });

  test("a failed batch does not mark a successful sibling failed", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("batch", { results: [{ id: "Success", exitCode: 0 }, { id: "Failure", exitCode: 2 }] }, true));
    writeMessages(child("Success"), [{ role: "assistant", content: [{ type: "text", text: "Success" }] }]);
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Success", status: "completed" }));
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Failure", status: "failed" }));
  });

  test("an explicit kill tombstone wins over an older completed task result", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [{ id: "Worker", exitCode: 0 }] }));
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Old answer" }] }]);
    writeFileSync(`${child("Worker")}.tombstone`, "killed");
    expect(children(await recover({ sessionFile: parent, provider: "omp" })).at(-1)).toMatchObject({ id: "Worker", status: "canceled" });
  });

  test("async delivery uses agentId rather than a distinct job id for transcript ownership", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, [
      ...taskDispatch("spawn", { results: [], progress: [{ id: "Worker", status: "running" }], async: { type: "task", state: "running", jobId: "Worker" } }),
      { role: "custom", customType: "async-result", content: "Background task failed", details: { jobs: [{ type: "task", jobId: "followup-job", agentId: "Worker", status: "failed" }] } },
    ]);
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Saved work" }] }]);
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered.filter((event) => event.type === "timeline" && event.item.type === "assistant_message")).toHaveLength(1);
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "failed" });
    expect(recovered.some((event) => event.id === "followup-job")).toBe(false);
  });

  test("preserves complete nested ids and seeds each nested transcript exactly once", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [{ id: "Parent", exitCode: 0 }] }));
    writeMessages(child("Parent"), [
      ...taskDispatch("nested", { results: [], progress: [{ id: "Parent.Helper", status: "running" }], async: { type: "task", state: "running", jobId: "Parent.Helper" } }),
    ]);
    writeMessages(join(dirname(child("Parent")), "Parent", "Parent.Helper.jsonl"), [{ role: "assistant", content: [{ type: "text", text: "Nested answer" }] }]);
    const ids: string[] = [];
    const recovered = children(await recover({ sessionFile: parent, provider: "omp", onSubagentTranscript: (id) => ids.push(id) }));
    expect(recovered).toContainEqual(expect.objectContaining({ type: "timeline", id: "Parent.Helper", item: expect.objectContaining({ text: "Nested answer" }) }));
    expect(ids).toEqual(["Parent", "Parent.Helper"]);
    expect(recovered.some((event) => event.id === "Helper")).toBe(false);
  });

  test("an authoritative current running snapshot corrects terminal persisted history", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [{ id: "Worker", exitCode: 0 }] }));
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Previous run" }] }]);
    const recovered = children(await recover({ sessionFile: parent, provider: "omp", subagentSnapshots: [{ id: "Worker", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1234, sessionFile: child("Worker") }] }));
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "running" });
  });

  test("missing or unfinished async transcripts are not permanently reported running", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [], progress: [{ id: "Missing", status: "running" }, { id: "Interrupted", status: "pending" }], async: { type: "task", state: "running", jobId: "Missing" } }));
    writeMessages(child("Interrupted"), [{ role: "user", content: "Not answered" }]);
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Missing", status: "canceled" }));
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Interrupted", status: "canceled" }));
    expect(recovered.some((event) => event.type === "upsert" && event.status === "running")).toBe(false);
  });

  test("recovers async primary job identity even when progress is empty", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [], progress: [], async: { type: "task", state: "running", jobId: "Worker" } }));
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Done" }] }]);
    expect(children(await recover({ sessionFile: parent, provider: "omp" })).at(-1)).toMatchObject({ id: "Worker", status: "completed" });
  });

  test.each([streamOmpHistory, streamOmpSubagentHistory])("snapshot-only children recover before the parent task result exists", async (stream) => {
    const { parent, child } = fixture();
    writeMessages(parent, [{ role: "user", content: "Parent prompt" }]);
    writeMessages(child("Parent"), taskDispatch("nested", { results: [{ id: "Parent.Helper", exitCode: 0 }] }));
    const nestedFile = join(dirname(child("Parent")), "Parent", "Parent.Helper.jsonl");
    writeMessages(nestedFile, [{ role: "assistant", content: [{ type: "text", text: "Nested answer" }] }]);
    const nativeIds: string[] = [];
    const events: AgentStreamEvent[] = [];
    for await (const event of stream({
      sessionFile: parent, provider: "omp",
      subagentSnapshots: [
        { id: "Parent", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1234, sessionFile: child("Parent"), parentToolCallId: "early-spawn" },
        { id: "Parent.Helper", index: 1, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1234, sessionFile: nestedFile, parentToolCallId: "nested" },
      ],
      onSubagentTranscript: (id) => nativeIds.push(id),
    })) events.push(event);
    const recovered = children(events);
    expect(nativeIds).toEqual(["Parent", "Parent.Helper"]);
    expect(recovered.filter((event) => event.type === "timeline" && event.item.type === "assistant_message")).toHaveLength(1);
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Parent", status: "running", toolCallId: "early-spawn" }));
    expect(recovered).toContainEqual(expect.objectContaining({ id: "Parent.Helper", status: "running", toolCallId: "nested" }));
  });

  test.each([
    { stopReason: "error", status: "failed" },
    { stopReason: "aborted", status: "canceled" },
  ])("preserves $stopReason child outcome after normal process teardown", async ({ stopReason, status }) => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [], progress: [{ id: "Worker", status: "running" }] }));
    writeMessages(child("Worker"), [{ role: "assistant", stopReason, content: [] }]);
    appendFileSync(child("Worker"), JSON.stringify({ type: "custom", id: "exit", parentId: "entry-0", customType: "session_exit", data: { kind: "normal", pendingToolCalls: [] } }) + "\n");
    expect(children(await recover({ sessionFile: parent, provider: "omp" })).at(-1)).toMatchObject({ id: "Worker", status });
  });

  test("a persisted active leaf excludes off-branch child output and malformed trailing records", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [], progress: [{ id: "Worker", status: "running" }] }));
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Active answer" }] }]);
    appendFileSync(child("Worker"), [
      JSON.stringify({ type: "message", id: "off-branch", parentId: "root", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "Excluded" }] } }),
      JSON.stringify({ type: "model_usage", id: "usage", parentId: "off-branch", activeLeafId: "entry-0" }),
      "{malformed record}",
      '{"type":"message","id":"partial',
    ].join("\n"));
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered.filter((event) => event.type === "timeline" && event.item.type === "assistant_message")).toEqual([expect.objectContaining({ item: expect.objectContaining({ text: "Active answer" }) })]);
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "completed" });
  });

  test("a child transcript read failure surfaces instead of silently losing its timeline", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [], progress: [{ id: "Unreadable", status: "running" }] }));
    mkdirSync(child("Unreadable"), { recursive: true });
    await expect(recover({ sessionFile: parent, provider: "omp" })).rejects.toThrow();
  });
});
