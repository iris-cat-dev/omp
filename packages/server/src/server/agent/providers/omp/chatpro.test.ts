import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { buildAgentPrompt } from "../../prompt-attachments.js";
import { CHATPRO_CUSTOM_TYPE, ChatProDeliveries, prepareChatProCommand } from "./chatpro.js";
import type { ChatProDetails } from "./chatpro.js";
import { streamOmpHistory } from "./history.js";
import { OmpHarness } from "./test-utils/omp-harness.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const harnesses: OmpHarness[] = [];
afterEach(async () => {
  for (const omp of harnesses.splice(0)) await omp.close();
});

function createHarness() {
  const omp = new OmpHarness();
  harnesses.push(omp);
  return omp;
}

function details(overrides: Partial<ChatProDetails> = {}): ChatProDetails {
  return {
    schemaVersion: 1,
    event: "result",
    deliveryId: "request:result",
    requestId: "request",
    nativeJobId: "native-job",
    sessionId: "omp-session-1",
    runtimeId: "runtime-one",
    agentId: "main",
    ...overrides,
  };
}

function deliver(omp: OmpHarness, metadata: unknown, content: string, entryId?: string) {
  omp.runtime().emit({
    type: "message_end",
    message: {
      role: "custom",
      customType: CHATPRO_CUSTOM_TYPE,
      content,
      display: true,
      details: metadata,
      entryId,
    },
  });
}

describe("ChatPro native command admission", () => {
  test.each([undefined, "prompt", "skill"])(
    "refuses an unavailable extension command (%s) without dispatching any prompt",
    async (source) => {
      const omp = createHarness();
      if (source) omp.queueCommands([{ name: "chatpro", source }]);
      await omp.start();
      await expect(omp.requireStartTurn("/chatpro ask review this")).rejects.toThrow(
        "/chatpro is unavailable",
      );
      expect(omp.recordedPrompts()).toEqual([]);
      expect(omp.eventTypes()).not.toContain("turn_started");
    },
  );

  test.each(["standard", "enhanced", "plan", "goal"])(
    "bypasses %s workflow and submits only a structured native command",
    async (workflow) => {
      const omp = createHarness();
      omp.queueCommands([{ name: "chatpro", source: "extension" }]);
      await omp.start({ featureValues: { workflow_mode: workflow } });
      await omp.runPromptWithoutTurn('/chatpro ask literal {"cmd":"echo never-execute"}');
      const prompts = omp.recordedPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.message).toMatch(/^\/chatpro ask --json /);
      const ask = JSON.parse(prompts[0]!.message.slice("/chatpro ask --json ".length));
      expect(ask.text).toBe('literal {"cmd":"echo never-execute"}');
      const submitted = omp
        .streamEvents()
        .find((event) => event.type === "timeline" && event.item.type === "user_message");
      expect(ask.origin.turnId).toBe(
        submitted && "turnId" in submitted ? submitted.turnId : undefined,
      );
      expect(ask.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(omp.eventTypes()).not.toContain("turn_started");
      expect(omp.completedTurnCount()).toBe(1);
    },
  );

  test("preserves explicit file data and overrides a caller-supplied turn with the true origin", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    const input = {
      text: "review",
      files: [{ path: "C:/host/spec.txt", mimeType: "text/plain" }],
      origin: { turnId: "forged" },
    };
    const turnId = await omp.requireStartTurn(`/chatpro ask --json ${JSON.stringify(input)}`, {
      clientMessageId: "composer-one",
    });
    const ask = JSON.parse(omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length));
    expect(ask).toMatchObject({
      text: input.text,
      files: input.files,
      origin: { turnId, clientMessageId: "composer-one" },
    });
    await omp.interrupt();
  });
  test("canonicalizes an explicit uppercase request before registration and trusts its native lowercase receipt", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    const requestId = "E15AB05A-B98C-4BCA-9B05-09FED58F4E8C";
    const text = `{"cmd":"/chatpro cancel ${requestId}"}\n  original  \n`;
    await omp.runPromptWithoutTurn(
      `/chatpro ask --json ${JSON.stringify({ requestId, text, bindingRef: "Binding-REF" })}`,
    );
    const ask = JSON.parse(omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length));
    expect(ask.requestId).toBe(requestId.toLowerCase());
    expect(ask.text).toBe(text);
    expect(ask.bindingRef).toBe("Binding-REF");
    const metadata = details({ requestId: requestId.toLowerCase(), origin: ask.origin });
    deliver(
      omp,
      { ...metadata, event: "receipt", deliveryId: `${ask.requestId}:receipt` },
      "canonical receipt",
    );
    deliver(omp, metadata, "canonical result");
    const received = omp
      .streamEvents()
      .filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          ["canonical receipt", "canonical result"].includes(event.item.text),
      );
    expect(received).toHaveLength(2);
    expect(received.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      ask.origin.turnId,
      ask.origin.turnId,
    ]);
    await expect(
      omp.requireStartTurn(
        `/chatpro ask --json ${JSON.stringify({ requestId: requestId.toLowerCase(), text })}`,
      ),
    ).rejects.toThrow("already belongs to another turn");
    expect(omp.recordedPrompts()).toHaveLength(1);
  });

  test("preserves opaque origin and file-only text while preparing canonical request identity", () => {
    const requestId = "E15AB05A-B98C-4BCA-9B05-09FED58F4E8C";
    for (const text of ["", " \r\n\t "]) {
      const origin = { turnId: "Opaque-TURN/Not-A-UUID", clientMessageId: requestId };
      const input = {
        requestId,
        text,
        files: [{ path: "C:/host/OnlyFile.TXT" }],
        bindingRef: requestId,
        conversationRef: requestId,
      };
      const prepared = prepareChatProCommand(
        `/chatpro ask --json ${JSON.stringify(input)}`,
        origin,
      );
      const ask = JSON.parse(prepared.text.slice("/chatpro ask --json ".length));
      expect(prepared.requestId).toBe(requestId.toLowerCase());
      expect(ask).toEqual({ ...input, requestId: requestId.toLowerCase(), origin });
      const deliveries = new ChatProDeliveries();
      deliveries.register(prepared.requestId!, origin);
      expect(
        deliveries.accept(
          details({ event: "receipt", requestId: prepared.requestId, origin }),
          "omp-session-1",
          "accepted",
        ),
      ).toEqual({ turnId: origin.turnId });
    }
    const uuidOrigin = { turnId: requestId };
    const prepared = prepareChatProCommand('/chatpro ask {"cmd":"literal"}', uuidOrigin);
    const ask = JSON.parse(prepared.text.slice("/chatpro ask --json ".length));
    expect(ask.origin).toEqual(uuidOrigin);
    expect(ask.text).toBe('{"cmd":"literal"}');
  });

  test("rejects composer media and context instead of rendering paths or discarding blocks", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    await expect(
      omp.requireStartTurn(
        buildAgentPrompt("/chatpro ask review", [{ data: "aW1hZ2U=", mimeType: "image/png" }]),
      ),
    ).rejects.toThrow("composer media");
    await expect(
      omp.requireStartTurn(
        buildAgentPrompt("/chatpro ask review", undefined, [
          {
            type: "uploaded_file",
            id: "selected-file",
            path: "C:/host/spec.txt",
            fileName: "spec.txt",
            mimeType: "text/plain",
            size: 10,
          },
        ]),
      ),
    ).rejects.toThrow("explicit host files");
    await expect(
      omp.requireStartTurn('/chatpro ask --json {"text":"x","unexpected":true}'),
    ).rejects.toThrow("Invalid /chatpro");
    expect(omp.recordedPrompts()).toEqual([]);
  });

  test.each(["status", "result request", "cancel request"])(
    "passes native %s without workflow envelopes",
    async (args) => {
      const omp = createHarness();
      omp.queueCommands([{ name: "chatpro", source: "extension" }]);
      await omp.start({ featureValues: { workflow_mode: "plan" } });
      await omp.runPromptWithoutTurn(`/chatpro ${args}`);
      expect(omp.recordedPrompts()).toEqual([{ message: `/chatpro ${args}`, imageCount: 0 }]);
    },
  );
});

describe("ChatPro background delivery ownership", () => {
  test("keeps a late result on its admitted origin and never completes a new foreground turn", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    await omp.runPromptWithoutTurn("/chatpro ask review");
    const ask = JSON.parse(omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length));
    const metadata = details({ requestId: ask.requestId, origin: ask.origin });
    deliver(
      omp,
      { ...metadata, event: "receipt", deliveryId: `${ask.requestId}:receipt` },
      "Accepted",
    );
    omp.runtime().promptAck = {};
    const foreground = await omp.requireStartTurn("unrelated normal task");
    const completedBefore = omp.completedTurnCount();
    const fullText = `start\n${"原文🙂\n".repeat(40_000)}end\n`;
    deliver(omp, metadata, fullText, "native-result-one");
    deliver(omp, metadata, fullText, "duplicate-native-id");
    deliver(omp, { ...metadata, deliveryId: "explicit-reread" }, fullText, "native-reread");
    const results = omp
      .streamEvents()
      .filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text === fullText,
      );
    expect(results).toHaveLength(2);
    expect(results.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      ask.origin.turnId,
      ask.origin.turnId,
    ]);
    expect(results[0]).toMatchObject({
      item: {
        messageId: "native-result-one",
        customMessage: { customType: CHATPRO_CUSTOM_TYPE, details: metadata },
      },
    });
    expect(omp.completedTurnCount()).toBe(completedBefore);
    expect(foreground).not.toBe(ask.origin.turnId);
    await omp.interrupt();
  });

  test.each(["receipt", "progress", "result", "error", "status"] as const)(
    "does not let an unassociated %s record claim or complete an arbitrary foreground turn",
    async (deliveryEvent) => {
      const omp = createHarness();
      await omp.start();
      const foreground = await omp.requireStartTurn("normal task");
      deliver(
        omp,
        details({ event: deliveryEvent, origin: { turnId: foreground } }),
        "unassociated result",
      );
      const result = omp
        .streamEvents()
        .find(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            event.item.text === "unassociated result",
        );
      expect(result).toBeDefined();
      expect(result && "turnId" in result ? result.turnId : undefined).toBeUndefined();
      expect(omp.completedTurnCount()).toBe(0);
      await omp.interrupt();
    },
  );

  test("rejects runtime/job reassociation even when origin and requestId match", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    await omp.runPromptWithoutTurn("/chatpro ask review");
    const ask = JSON.parse(omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length));
    const metadata = details({ requestId: ask.requestId, origin: ask.origin });
    deliver(omp, { ...metadata, event: "receipt", deliveryId: "receipt" }, "accepted");
    deliver(omp, { ...metadata, runtimeId: "another-runtime" }, "wrong runtime");
    const result = omp
      .streamEvents()
      .find(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text === "wrong runtime",
      );
    expect(result && "turnId" in result ? result.turnId : undefined).toBeUndefined();
  });

  test("deduplicates only an exact public record, retaining changed originals and metadata across reconnect", async () => {
    const omp = createHarness();
    await omp.start();
    const metadata = details();
    const variants: Partial<ChatProDetails>[] = [
      { event: "progress" },
      { requestId: "another-request" },
      { nativeJobId: "another-job" },
      { sessionId: "another-session" },
      { runtimeId: "another-runtime" },
      { agentId: "another-agent" },
      { origin: { turnId: "another-turn" } },
      { resultId: "another-result" },
      { status: "another-status" },
    ];
    deliver(omp, metadata, "original");
    deliver(omp, metadata, "original");
    deliver(omp, metadata, "changed original");
    for (const variant of variants) deliver(omp, { ...metadata, ...variant }, "original");
    expect(omp.timeline()).toHaveLength(variants.length + 2);
    expect(omp.completedTurnCount()).toBe(0);

    const deliveries = new ChatProDeliveries();
    deliveries.remember(metadata, "omp-session-1", "original");
    expect(deliveries.accept(metadata, "omp-session-1", "original")).toBeNull();
    expect(deliveries.accept(metadata, "omp-session-1", "changed original")).toEqual({});
    for (const variant of variants) {
      expect(deliveries.accept({ ...metadata, ...variant }, "omp-session-1", "original")).toEqual(
        {},
      );
    }
  });

  test("keeps malformed public metadata visible but detached and unable to suppress distinct deliveries", async () => {
    const omp = createHarness();
    omp.queueCommands([{ name: "chatpro", source: "extension" }]);
    await omp.start();
    await omp.runPromptWithoutTurn("/chatpro ask review");
    const ask = JSON.parse(omp.recordedPrompts()[0]!.message.slice("/chatpro ask --json ".length));
    const metadata = details({ requestId: ask.requestId, origin: ask.origin });
    deliver(omp, { ...metadata, event: "receipt", deliveryId: "receipt" }, "accepted");
    omp.runtime().promptAck = {};
    await omp.requireStartTurn("unrelated normal task");
    const completedBefore = omp.completedTurnCount();
    const invalid = { ...metadata, inputDigest: "private-field-not-in-public-contract" };
    deliver(omp, invalid, "first invalid-metadata original", "invalid-one");
    deliver(omp, invalid, "second invalid-metadata original", "invalid-two");
    const results = omp
      .streamEvents()
      .filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("invalid-metadata original"),
      );
    expect(results).toHaveLength(2);
    expect(results.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      undefined,
      undefined,
    ]);
    expect(omp.completedTurnCount()).toBe(completedBefore);
    await omp.interrupt();
  });

  test("shows idle resumed-client results without requiring a model agent_start", async () => {
    const omp = createHarness();
    await omp.resume({
      user: { id: "u", text: "previous" },
      assistant: { id: "a", text: "answer" },
    });
    deliver(omp, details(), "completed while idle", "idle-result");
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({ text: "completed while idle", messageId: "idle-result" }),
    );
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.eventTypes()).not.toContain("turn_started");
  });

  test("seeds reconnect dedup from native history without dropping a fresh explicit result read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatpro-reconnect-"));
    try {
      const sessionFile = join(directory, "session.jsonl");
      const metadata = details();
      await writeFile(
        sessionFile,
        [
          { type: "session", id: "root", cwd: directory },
          {
            type: "custom_message",
            id: "native-result",
            parentId: "root",
            customType: CHATPRO_CUSTOM_TYPE,
            content: "saved result",
            display: true,
            details: metadata,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const omp = createHarness();
      await omp.resumeFile(sessionFile);
      expect(await omp.history()).toContainEqual(
        expect.objectContaining({ text: "saved result", messageId: "native-result" }),
      );
      deliver(omp, metadata, "saved result");
      expect(omp.timeline()).toEqual([]);
      deliver(omp, { ...metadata, deliveryId: "explicit-read-after-reconnect" }, "saved result");
      expect(omp.timeline()).toHaveLength(1);
      expect(omp.completedTurnCount()).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("native JSONL restores full top-level and role:custom records, preserves details/IDs, and hides state/hidden/skill records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatpro-history-"));
  try {
    const sessionFile = join(directory, "session.jsonl");
    const body = `\n${"原始🙂\n".repeat(40_000)}\n`;
    const metadata = details();
    const records = [
      { type: "session", id: "root" },
      {
        type: "custom_message",
        id: "native-full",
        customType: CHATPRO_CUSTOM_TYPE,
        display: true,
        content: body,
        details: metadata,
      },
      {
        type: "custom_message",
        id: "duplicate",
        customType: CHATPRO_CUSTOM_TYPE,
        display: true,
        content: body,
        details: metadata,
      },
      {
        type: "custom_message",
        id: "changed-body",
        customType: CHATPRO_CUSTOM_TYPE,
        display: true,
        content: "changed original",
        details: metadata,
      },
      {
        type: "custom_message",
        id: "changed-metadata",
        customType: CHATPRO_CUSTOM_TYPE,
        display: true,
        content: body,
        details: { ...metadata, requestId: "another-request" },
      },
      {
        type: "custom_message",
        id: "reread",
        customType: CHATPRO_CUSTOM_TYPE,
        display: true,
        content: "re-read",
        details: { ...metadata, deliveryId: "reread" },
      },
      {
        type: "custom_message",
        id: "hidden",
        customType: CHATPRO_CUSTOM_TYPE,
        display: false,
        content: "hidden",
      },
      {
        type: "custom_message",
        id: "skill",
        customType: "skill-prompt",
        display: true,
        content: "hidden skill",
      },
      {
        type: "custom",
        id: "state",
        customType: CHATPRO_CUSTOM_TYPE,
        data: { content: "state only" },
      },
      {
        type: "message",
        id: "native-role-custom",
        message: {
          role: "custom",
          customType: "other-plugin",
          display: true,
          content: "role custom",
          details: { useful: true },
        },
      },
    ];
    await writeFile(
      sessionFile,
      records
        .map((record, index) =>
          JSON.stringify({ ...record, parentId: index ? records[index - 1]!.id : null }),
        )
        .join("\n"),
    );
    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({ sessionFile, provider: "omp", runtimeSettings: ompHistoryRuntimeSettings }))
      events.push(event);
    const items = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      type: "assistant_message",
      text: body,
      messageId: "native-full",
      customMessage: { customType: CHATPRO_CUSTOM_TYPE, details: metadata },
    });
    expect(
      createHash("sha256")
        .update(items[0]!.type === "assistant_message" ? items[0]!.text : "")
        .digest("hex"),
    ).toBe(createHash("sha256").update(body).digest("hex"));
    expect(items[1]).toMatchObject({ text: "changed original", messageId: "changed-body" });
    expect(items[2]).toMatchObject({ text: body, messageId: "changed-metadata" });
    expect(items[3]).toMatchObject({ text: "re-read", messageId: "reread" });
    expect(items[4]).toEqual({
      type: "assistant_message",
      text: "role custom",
      messageId: "native-role-custom",
      customMessage: { customType: "other-plugin", details: { useful: true } },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
