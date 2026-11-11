import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureLocalSubmission, LOCAL_SUBMISSION_ANNOTATION, readLocalSubmission } from "./local-submission.js";
import { readOmpHistoryPage, streamOmpHistory } from "./history.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const attachment = { type: "text" as const, mimeType: "text/plain", title: "External snapshot", text: "Complete external snapshot\nSecond line survives source removal.", externalResource: { provider: "fixture/source", providerLabel: "External source", resourceType: "document", id: "42", identifier: "DOC-42", title: "External snapshot", url: "https://example.com/42" } };

describe("local submission display annotations", () => {
  it("preserves original input and attachment metadata without treating an annotation as a native user turn", () => {
    const item = captureLocalSubmission([{ type: "text", text: "/local save" }, attachment], "client-42");
    expect(item).toEqual({ type: "user_message", text: "/local save", clientMessageId: "client-42", rewindStatus: "unavailable", attachments: [attachment] });
    expect(readLocalSubmission({ type: "custom", customType: LOCAL_SUBMISSION_ANNOTATION, data: item })).toEqual(item);
    expect(readLocalSubmission({ type: "custom", customType: "another-extension", data: item })).toBeNull();
    expect(() => readLocalSubmission({ type: "custom", customType: LOCAL_SUBMISSION_ANNOTATION, data: { type: "assistant_message", text: "not a submission" } })).toThrow("must contain a user message");
  });

  it("recovers the complete same record through cold pages and warm history without a source plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-local-submission-"));
    const sessionFile = join(root, "session.jsonl");
    const timestamp = "2026-11-10T10:00:00.000Z";
    const item = captureLocalSubmission([{ type: "text", text: "/local save" }, attachment], "client-42");
    try {
      await writeFile(sessionFile, [
        { type: "session", version: 3, id: "local-session", timestamp, cwd: root },
        { type: "custom", id: "annotation-42", parentId: null, timestamp, customType: LOCAL_SUBMISSION_ANNOTATION, data: item },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const runtimeSettings = ompHistoryRuntimeSettings;
      const page = await readOmpHistoryPage({ sessionFile, provider: "omp", runtimeSettings, epoch: "local", timestamp, options: { direction: "tail" } });
      expect(page.rows.map((row) => row.item)).toEqual([item]);
      const warm = [];
      for await (const event of streamOmpHistory({ sessionFile, provider: "omp", runtimeSettings })) if (event.type === "timeline") warm.push(event.item);
      expect(warm).toEqual([item]);
      const prompts = await readOmpHistoryPage({ sessionFile, provider: "omp", runtimeSettings, epoch: "local", timestamp, onlyUserMessages: true, options: { direction: "tail" } });
      expect(prompts.rows.map((row) => row.item)).toEqual([item]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
