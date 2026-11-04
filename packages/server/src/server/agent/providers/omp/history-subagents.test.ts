import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../provider-subagents/store.js";
import { getOmpColdHistoryStats, openOmpIndexedJournal, readActiveOmpSubagentMessages, readOmpHistoryPage, streamOmpHistory, streamOmpSubagentHistory, type OmpHistoryInput } from "./history.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

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
  for await (const event of streamOmpSubagentHistory({ ...input, runtimeSettings: ompHistoryRuntimeSettings })) events.push(event);
  return events;
}

function children(events: AgentStreamEvent[]) {
  return events.flatMap((event) => event.type === "provider_subagent" ? [event.event] : []);
}

describe("native persisted subagent recovery", () => {
  test.each(["page-first", "discovery-first", "legacy-catalog"])("%s recovery never rereads huge unrelated parent results", async (order) => {
    const { parent, child } = fixture();
    const irrelevant = "NO_DISCOVERY_PARENT_PAYLOAD" + "x".repeat(512 * 1024);
    writeMessages(parent, [
      { role: "user", content: "Parent prompt" },
      {
        role: "assistant", content: [
          { type: "text", text: irrelevant },
          { type: "toolCall", id: "read", name: "read", arguments: { unrelated: irrelevant } },
          { type: "toolCall", id: "spawn", name: "task", arguments: { agent: "scout", tasks: [{ task: irrelevant }] } },
        ],
      },
      ...Array.from({ length: 16 }, (_, index): OmpAgentMessage => ({
        role: "toolResult", toolName: "read", toolCallId: `read-${index}`, content: [{ type: "text", text: irrelevant }],
      })),
      { role: "toolResult", toolName: "task", toolCallId: "spawn", content: [{ type: "text", text: "Dispatched" }], details: { results: [], progress: [{ id: "Worker", status: "running" }], async: { type: "task", state: "running", jobId: "Worker" } } },
      { role: "custom", customType: "async-result", content: irrelevant, details: { jobs: [{ type: "task", jobId: "delivery", agentId: "Worker", status: "completed", output: irrelevant }] } },
      { role: "user", content: "Tail prompt" },
    ]);
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Recovered answer" }] }]);
    const pageInput = {
      sessionFile: parent, provider: "omp" as const, runtimeSettings: ompHistoryRuntimeSettings,
      epoch: "io-budget", timestamp: "2026-10-01T00:00:00Z", options: { direction: "tail" as const, limit: 1 },
    };
    if (order === "discovery-first") {
      expect(children(await recover({ sessionFile: parent, provider: "omp" })).at(-1)).toMatchObject({ id: "Worker", title: "scout", status: "completed" });
      const sparse = getOmpColdHistoryStats(parent)!;
      expect(sparse.discoveryEntriesParsed).toBe(3);
      expect(sparse.discoveryBytesRead).toBeLessThan(4 * 1024 * 1024);
      expect(sparse.entryBytesRead).toBe(sparse.discoveryBytesRead);
    }
    await readOmpHistoryPage(pageInput);
    if (order === "legacy-catalog") {
      const journal = await openOmpIndexedJournal(parent, ompHistoryRuntimeSettings);
      const oldCatalog = journal.getProjection<Record<string, unknown>>("desktop-timeline-v3:omp")!;
      delete oldCatalog.subagentMessages;
      journal.setProjection("desktop-timeline-v3:omp", oldCatalog);
      await journal.save();
      const beforeUpgrade = getOmpColdHistoryStats(parent)!;
      await readOmpHistoryPage(pageInput);
      const afterUpgrade = getOmpColdHistoryStats(parent)!;
      expect(afterUpgrade.catalogBytesRead).toBe(beforeUpgrade.catalogBytesRead);
      expect(afterUpgrade.discoveryEntriesParsed - beforeUpgrade.discoveryEntriesParsed).toBe(3);
      expect(afterUpgrade.discoveryBytesRead - beforeUpgrade.discoveryBytesRead).toBeLessThan(4 * 1024 * 1024);
    }
    const beforeWarm = getOmpColdHistoryStats(parent)!;
    const page = await readOmpHistoryPage(pageInput);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.item).toMatchObject({ type: "user_message", text: "Tail prompt" });
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered).toContainEqual(expect.objectContaining({ type: "timeline", id: "Worker", item: expect.objectContaining({ text: "Recovered answer" }) }));
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "completed", toolCallId: "spawn" });
    const compact = await readActiveOmpSubagentMessages(parent, "omp", undefined, ompHistoryRuntimeSettings);
    expect(JSON.stringify(compact)).not.toContain("NO_DISCOVERY_PARENT_PAYLOAD");
    const afterWarm = getOmpColdHistoryStats(parent)!;
    expect(afterWarm.catalogBytesRead).toBe(beforeWarm.catalogBytesRead);
    expect(afterWarm.discoveryBytesRead).toBe(beforeWarm.discoveryBytesRead);
    expect(afterWarm.entryBytesRead - beforeWarm.entryBytesRead).toBe(afterWarm.pageBytesRead - beforeWarm.pageBytesRead);
    expect(afterWarm.entryBytesRead - beforeWarm.entryBytesRead).toBeLessThan(1024);
    expect(afterWarm.entryBytesRead).toBe(afterWarm.catalogBytesRead + afterWarm.pageBytesRead + afterWarm.discoveryBytesRead);
    expect(afterWarm.residentBodyBytes).toBe(0);
  });

  test.each([streamOmpHistory, streamOmpSubagentHistory])("child descriptor creation time comes from its session header, not its first model control", async (stream) => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [{ id: "Worker", exitCode: 0 }] }));
    mkdirSync(dirname(child("Worker")), { recursive: true });
    writeFileSync(child("Worker"), [
      { type: "session", id: "child-root", timestamp: "2026-07-07T02:00:00Z" },
      { type: "model_change", id: "child-model", parentId: "child-root", timestamp: "2026-07-07T02:00:00.500Z", model: "openai-codex/gpt-5.5" },
      { type: "message", id: "child-answer", parentId: "child-model", timestamp: "2026-07-07T02:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Child answer" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const store = new ProviderSubagentStore();
    for await (const event of stream({ sessionFile: parent, provider: "omp", runtimeSettings: ompHistoryRuntimeSettings })) {
      if (event.type === "provider_subagent") store.apply("parent", event.provider, event.event);
    }
    expect(store.list("parent")).toEqual([expect.objectContaining({
      id: "Worker", model: "openai-codex/gpt-5.5", status: "completed",
      createdAt: "2026-07-07T02:00:00Z", updatedAt: "2026-07-07T02:00:01Z",
    })]);
  });

  test.each(["legacy-path", "content-details"])("compact discovery preserves %s task records", async (format) => {
    const { parent, child } = fixture();
    const message = format === "legacy-path"
      ? { role: "toolResult", toolName: "task", toolCallId: "spawn", content: [{ type: "text", text: `Old output\ntranscript file: ${child("Worker")}\nRest of output` }] }
      : { role: "toolResult", toolName: "task", toolCallId: "spawn", content: { details: { results: [{ id: "Worker", agent: "scout", exitCode: 0, sessionFile: child("Worker") }] } } };
    writeMessages(parent, [message as OmpAgentMessage]);
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Saved answer" }] }]);
    const recovered = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(recovered).toContainEqual(expect.objectContaining({ type: "timeline", id: "Worker", item: expect.objectContaining({ text: "Saved answer" }) }));
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "completed", toolCallId: "spawn" });
  });

  test("discovery projections follow append, active-branch switches, off-branch metadata, and rewrites", async () => {
    const { parent, child } = fixture();
    writeMessages(parent, taskDispatch("spawn", { results: [{ id: "Worker", exitCode: 0 }] }));
    writeMessages(child("Worker"), [{ role: "assistant", content: [{ type: "text", text: "Worker answer" }] }]);
    writeMessages(child("Other"), [{ role: "assistant", content: [{ type: "text", text: "Other answer" }] }]);
    await recover({ sessionFile: parent, provider: "omp" });
    const beforeAppend = getOmpColdHistoryStats(parent)!;
    appendFileSync(parent, JSON.stringify({ type: "message", id: "resume", parentId: "entry-1", message: { role: "toolResult", toolName: "task", toolCallId: "resume-call", content: [], details: { results: [{ id: "Worker", aborted: true }] } } }) + "\n");
    expect(children(await recover({ sessionFile: parent, provider: "omp" })).at(-1)).toMatchObject({ id: "Worker", status: "canceled", toolCallId: "resume-call" });
    expect(getOmpColdHistoryStats(parent)!.discoveryEntriesParsed - beforeAppend.discoveryEntriesParsed).toBe(1);
    expect(children(await recover({ sessionFile: parent, provider: "omp", runtimeSession: { activeBranchEntryId: "entry-1" } as NonNullable<OmpHistoryInput["runtimeSession"]> })).at(-1)).toMatchObject({ id: "Worker", status: "completed", toolCallId: "spawn" });
    await recover({ sessionFile: parent, provider: "omp" });
    const beforeOffBranch = getOmpColdHistoryStats(parent)!;
    appendFileSync(parent, [
      JSON.stringify({ type: "message", id: "off-branch", parentId: "root", message: { role: "toolResult", toolName: "task", toolCallId: "other", content: [], details: { results: [{ id: "Other", exitCode: 0 }] } } }),
      JSON.stringify({ type: "model_usage", id: "usage", parentId: "off-branch", activeLeafId: "resume" }),
    ].join("\n") + "\n");
    const active = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(active.at(-1)).toMatchObject({ id: "Worker", status: "canceled" });
    expect(active.some((event) => event.id === "Other")).toBe(false);
    expect(getOmpColdHistoryStats(parent)!.discoveryBytesRead).toBe(beforeOffBranch.discoveryBytesRead);
    writeMessages(parent, taskDispatch("replacement", { results: [{ id: "Other", exitCode: 0 }] }));
    const rewritten = children(await recover({ sessionFile: parent, provider: "omp" }));
    expect(rewritten.at(-1)).toMatchObject({ id: "Other", status: "completed", toolCallId: "replacement" });
    expect(rewritten.some((event) => event.id === "Worker")).toBe(false);
  });


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
    const events = await recover({ sessionFile: parent, provider: "omp" });
    expect(events.every((event) => event.type === "provider_subagent")).toBe(true);
    const recovered = children(events);
    expect(recovered[0]).toMatchObject({ type: "upsert", id: "Worker", title: "scout", toolCallId: "spawn" });
    expect(recovered[0]).not.toHaveProperty("status");
    expect(recovered).toContainEqual(expect.objectContaining({ type: "timeline", id: "Worker", item: expect.objectContaining({ type: "assistant_message", text: "Recovered answer" }) }));
    expect(recovered.at(-1)).toMatchObject({ id: "Worker", status: "completed" });
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
      runtimeSettings: ompHistoryRuntimeSettings,
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
