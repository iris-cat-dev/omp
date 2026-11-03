import { describe, expect, test } from "vitest";
import {
  OmpSubagentsResultSchema,
  OmpSubagentMessagesSelectorSchema,
  parseOmpSubagentMessagesResult,
} from "./subagent-rpc.js";

const page = {
  sessionFile: "/session/Worker.jsonl",
  fromByte: 10,
  nextByte: 100,
  reset: false,
  entries: [
    { type: "model_change", id: "model", provider: "anthropic", model: "claude-sonnet-5" },
    { type: "message", id: "answer", parentId: "model", message: { role: "assistant", responseId: "reply", content: [{ type: "text", text: "你好" }] } },
  ],
  messages: [{ role: "assistant", responseId: "reply", content: [{ type: "text", text: "你好" }] }],
};

describe("native subagent recovery boundaries", () => {
  test("retains persisted entry metadata and stable message identities in incremental pages", () => {
    const result = parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 10 }, page);
    expect(result.entries[0]).toMatchObject({ type: "model_change", model: "claude-sonnet-5" });
    expect(result.messages[0]).toMatchObject({ responseId: "reply", content: [{ type: "text", text: "你好" }] });
  });

  test.each([-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid byte offset %s", (fromByte) => {
    expect(() => OmpSubagentMessagesSelectorSchema.parse({ subagentId: "Worker", fromByte })).toThrow();
  });

  test("requires a native id or explicit registered session file", () => {
    expect(() => OmpSubagentMessagesSelectorSchema.parse({ fromByte: 10 })).toThrow();
    expect(() => OmpSubagentMessagesSelectorSchema.parse({ subagentId: "" })).toThrow();
  });

  test("rejects pages that move backwards or extend the wrong requested cursor", () => {
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 10 }, { ...page, nextByte: 9 })).toThrow();
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 20 }, page)).toThrow("different cursor");
  });

  test("a reset restarts at byte zero and permits the native id to select the returned file", () => {
    const result = parseOmpSubagentMessagesResult({ subagentId: "Worker", sessionFile: "/ignored.jsonl", fromByte: 1000 }, { ...page, fromByte: 0, reset: true });
    expect(result.fromByte).toBe(0);
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 1000 }, { ...page, reset: true })).toThrow();
    expect(() => parseOmpSubagentMessagesResult({ sessionFile: "/other.jsonl", fromByte: 10 }, page)).toThrow("different subagent transcript");
  });

  test("rejects corrupt persisted child messages and missing transcript entries", () => {
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 10 }, { ...page, messages: [{ role: "assistant", content: [{ type: "text", text: 42 }] }] })).toThrow();
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 10 }, { ...page, entries: undefined })).toThrow();
    expect(() => parseOmpSubagentMessagesResult({ subagentId: "Worker", fromByte: 10 }, { ...page, entries: [{ type: "message", id: "missing-body" }] })).toThrow();
  });

  test("retains live snapshot progress and validates required native status/source/update fields", () => {
    const snapshot = { id: "Parent.Worker", index: 0, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1234, progress: { id: "Parent.Worker", status: "running", currentTool: "read", currentToolArgs: "source.ts" } };
    expect(OmpSubagentsResultSchema.parse({ subagents: [snapshot] }).subagents[0]?.progress).toMatchObject({ currentTool: "read", currentToolArgs: "source.ts" });
    expect(() => OmpSubagentsResultSchema.parse({ subagents: [{ ...snapshot, status: "unknown" }] })).toThrow();
    expect(() => OmpSubagentsResultSchema.parse({ subagents: [{ ...snapshot, agentSource: undefined }] })).toThrow();
    expect(() => OmpSubagentsResultSchema.parse({ subagents: [{ ...snapshot, lastUpdate: undefined }] })).toThrow();
    expect(() => OmpSubagentsResultSchema.parse({ subagents: [{ ...snapshot, progress: { ...snapshot.progress, id: "Other.Worker" } }] })).toThrow();
  });
});
