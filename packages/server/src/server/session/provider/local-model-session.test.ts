import { expect, test, vi } from "vitest";
import {
  LOCAL_MODEL_MAX_REQUEST_BYTES,
  type LocalModelInferenceRequest,
  type LocalModelStreamFrame,
} from "@omp-desktop/protocol/local-models";
import type { SessionOutboundMessage } from "../../messages.js";
import type { OmpLocalModelGateway } from "../../agent/providers/omp/local-model-gateway.js";
import { LocalModelBridge } from "../../local-model-bridge.js";
import { LocalModelSession } from "./local-model-session.js";

const body: LocalModelInferenceRequest = {
  modelId: "openai/model",
  context: { messages: [] },
  stream: true,
};

function createGateway() {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | undefined;
  const cancelled = vi.fn();
  const request = vi.fn(async (_body: LocalModelInferenceRequest, requestSignal?: AbortSignal) => {
    signal = requestSignal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel: cancelled,
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });
  const gateway: OmpLocalModelGateway = {
    models: [{ provider: "openai", id: "model", api: "openai-responses" }],
    request,
    close: vi.fn(async () => {}),
  };
  return {
    gateway,
    request,
    cancelled,
    get signal() {
      return signal;
    },
    get controller() {
      return streamController;
    },
  };
}

function createHarness(
  openGateway: () => Promise<OmpLocalModelGateway>,
  bridge?: LocalModelBridge,
) {
  const messages: Array<{ message: SessionOutboundMessage; source: object }> = [];
  const observers = new Set<(message: SessionOutboundMessage, source: object) => void>();
  const refresh = vi.fn(async () => {});
  const retireRuntimes = vi.fn(async () => {});
  const session = new LocalModelSession({
    bridge,
    openGateway,
    refresh,
    retireRuntimes,
    emit(message, source) {
      messages.push({ message, source });
      for (const observer of observers) observer(message, source);
    },
  });
  const waitForFrame = (requestId: string, source: object, type: LocalModelStreamFrame["type"]) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const observer = (message: SessionOutboundMessage, owner: object) => {
      if (
        owner === source &&
        message.type === "local_model.source.frame" &&
        message.payload.requestId === requestId &&
        message.payload.frame.type === type
      ) {
        observers.delete(observer);
        resolve();
      }
    };
    observers.add(observer);
    return promise;
  };
  return { session, messages, refresh, retireRuntimes, waitForFrame };
}

test("source open shares its worker and another physical source cannot cancel or close its requests", async () => {
  const g = createGateway();
  const open = vi.fn(async () => g.gateway);
  const h = createHarness(open);
  const owner = {};
  const other = {};
  try {
    await h.session.handle({ type: "local_model.source.open", requestId: "open" }, owner);
    await h.session.handle({ type: "local_model.source.open", requestId: "open-again" }, owner);
    expect(open).toHaveBeenCalledTimes(1);
    const headers = h.waitForFrame("shared-id", owner, "headers");
    const running = h.session.handle(
      { type: "local_model.source.request", requestId: "shared-id", body },
      owner,
    );
    await headers;
    await h.session.handle({ type: "local_model.source.cancel", requestId: "shared-id" }, other);
    await h.session.handle({ type: "local_model.source.close", requestId: "close-other" }, other);
    expect(g.signal?.aborted).toBe(false);
    expect(g.gateway.close).not.toHaveBeenCalled();
    await h.session.handle({ type: "local_model.source.cancel", requestId: "shared-id" }, owner);
    await running;
    expect(g.signal?.aborted).toBe(true);
    expect(g.cancelled).toHaveBeenCalledTimes(1);
    const frames = h.messages.filter((entry) => entry.message.type === "local_model.source.frame");
    expect(frames).toHaveLength(1);
    expect(frames.every((entry) => entry.source === owner)).toBe(true);
  } finally {
    await h.session.dispose();
  }
});

test("source disconnect aborts inference and releases only its worker", async () => {
  const first = createGateway();
  const second = createGateway();
  const open = vi.fn().mockResolvedValueOnce(first.gateway).mockResolvedValueOnce(second.gateway);
  const h = createHarness(open);
  const owner = {};
  const other = {};
  await h.session.handle({ type: "local_model.source.open", requestId: "first" }, owner);
  await h.session.handle({ type: "local_model.source.open", requestId: "second" }, other);
  const headers = h.waitForFrame("stream", owner, "headers");
  const running = h.session.handle(
    { type: "local_model.source.request", requestId: "stream", body },
    owner,
  );
  await headers;
  h.session.disconnect(owner);
  await running;
  await Promise.resolve();
  expect(first.signal?.aborted).toBe(true);
  expect(first.gateway.close).toHaveBeenCalledTimes(1);
  expect(second.gateway.close).not.toHaveBeenCalled();
  expect(
    h.messages.filter((entry) => entry.message.type === "local_model.source.frame"),
  ).toHaveLength(1);
  await h.session.dispose();
  expect(second.gateway.close).toHaveBeenCalledTimes(1);
});

test("native UTF-8 chunks preserve partial codepoints and bounded wire frames through end", async () => {
  const g = createGateway();
  const h = createHarness(async () => g.gateway);
  const owner = {};
  try {
    await h.session.handle({ type: "local_model.source.open", requestId: "open" }, owner);
    const headers = h.waitForFrame("stream", owner, "headers");
    const running = h.session.handle(
      { type: "local_model.source.request", requestId: "stream", body },
      owner,
    );
    await headers;
    const text = `${"x".repeat(128 * 1024 - 1)}\u{1F419}tail`;
    const bytes = new TextEncoder().encode(text);
    g.controller!.enqueue(bytes.subarray(0, 128 * 1024));
    g.controller!.enqueue(bytes.subarray(128 * 1024));
    g.controller!.close();
    await running;
    const frames = h.messages.flatMap((entry) =>
      entry.message.type === "local_model.source.frame" ? [entry.message.payload.frame] : [],
    );
    expect(frames[0]?.type).toBe("headers");
    expect(frames.at(-1)?.type).toBe("end");
    const chunks = frames.filter((frame) => frame.type === "chunk");
    expect(chunks.map((frame) => frame.data).join("")).toBe(text);
    expect(chunks.every((frame) => frame.data.length <= 128 * 1024)).toBe(true);
  } finally {
    await h.session.dispose();
  }
});

test("unadvertised and oversized requests never reach native inference and errors expose no secrets", async () => {
  const g = createGateway();
  const h = createHarness(async () => g.gateway);
  const owner = {};
  try {
    await h.session.handle({ type: "local_model.source.open", requestId: "open" }, owner);
    await h.session.handle(
      {
        type: "local_model.source.request",
        requestId: "unknown",
        body: { ...body, modelId: "other/model" },
      },
      owner,
    );
    await h.session.handle(
      {
        type: "local_model.source.request",
        requestId: "large",
        body: {
          ...body,
          context: { messages: ["x".repeat(LOCAL_MODEL_MAX_REQUEST_BYTES)] },
        },
      },
      owner,
    );
    expect(g.request).not.toHaveBeenCalled();
    g.request.mockRejectedValueOnce(new Error("secret-token private-provider-url"));
    await h.session.handle(
      { type: "local_model.source.request", requestId: "failed", body },
      owner,
    );
    const errors = h.messages.flatMap((entry) =>
      entry.message.type === "local_model.source.frame" &&
      entry.message.payload.frame.type === "error"
        ? [entry.message.payload.frame.message]
        : [],
    );
    expect(errors).toEqual([
      "Local model inference failed",
      "Local model inference failed",
      "Local model inference failed",
    ]);
    expect(JSON.stringify(h.messages)).not.toContain("secret-token");
  } finally {
    await h.session.dispose();
  }
});

test("source close invalidates and closes a gateway that finishes opening late", async () => {
  const g = createGateway();
  const opening = Promise.withResolvers<OmpLocalModelGateway>();
  const h = createHarness(() => opening.promise);
  const owner = {};
  const open = h.session.handle({ type: "local_model.source.open", requestId: "open" }, owner);
  const close = h.session.handle({ type: "local_model.source.close", requestId: "close" }, owner);
  opening.resolve(g.gateway);
  await Promise.all([open, close]);
  expect(g.gateway.close).toHaveBeenCalledTimes(1);
  expect(
    h.messages.some((entry) => entry.message.type === "local_model.source.open.response"),
  ).toBe(false);
  expect(
    h.messages.some((entry) => entry.message.type === "local_model.source.close.response"),
  ).toBe(true);
  await h.session.dispose();
});

test("only its physical owner can detach a bridge and runtime retirement precedes snapshot publication", async () => {
  const bridge = new LocalModelBridge();
  const g = createGateway();
  const h = createHarness(async () => g.gateway, bridge);
  const owner = {};
  const other = {};
  const order: string[] = [];
  h.retireRuntimes.mockImplementation(async () => {
    order.push("retire");
  });
  h.refresh.mockImplementation(async () => {
    order.push("refresh");
  });
  try {
    await h.session.handle(
      { type: "local_model.attach", requestId: "attach", models: g.gateway.models },
      owner,
    );
    expect(order).toEqual(["retire", "refresh"]);
    order.length = 0;
    await h.session.handle(
      { type: "local_model.attach", requestId: "compete", models: g.gateway.models },
      other,
    );
    await h.session.handle({ type: "local_model.detach", requestId: "wrong-detach" }, other);
    expect(await bridge.getLaunchConfig()).not.toBeNull();
    expect(bridge.isEnabled()).toBe(true);
    expect(order).toEqual([]);
    h.session.disconnect(owner);
    await h.session.dispose();
    expect(await bridge.getLaunchConfig()).toBeNull();
    expect(bridge.isEnabled()).toBe(true);
    expect(order).toEqual(["retire", "refresh"]);
  } finally {
    await h.session.dispose();
    await bridge.close();
  }
});
