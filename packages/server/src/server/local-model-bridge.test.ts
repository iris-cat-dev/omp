import { request as httpRequest } from "node:http";
import { afterEach, expect, test } from "vitest";
import { LOCAL_MODEL_MAX_REQUEST_BYTES, type LocalModel } from "@omp-desktop/protocol/local-models";
import { LocalModelBridge } from "./local-model-bridge.js";

type BridgeEvent = Parameters<Parameters<LocalModelBridge["attach"]>[2]>[0];
const models: LocalModel[] = [{ provider: "openai", id: "native/model", api: "openai-responses" }];
const bridges: LocalModelBridge[] = [];
const body = {
  modelId: "desktop-local/openai/native/model",
  context: { messages: [] },
  stream: true,
};

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function setup() {
  const bridge = new LocalModelBridge();
  bridges.push(bridge);
  const events: BridgeEvent[] = [];
  const requested = Promise.withResolvers<Extract<BridgeEvent, { type: "request" }>>();
  const cancelled = Promise.withResolvers<Extract<BridgeEvent, { type: "cancel" }>>();
  await bridge.attach("owner", models, (event) => {
    events.push(event);
    if (event.type === "request") requested.resolve(event);
    else cancelled.resolve(event);
  });
  const config = await bridge.getLaunchConfig();
  if (!config) throw new Error("Expected attached bridge");
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  return {
    bridge,
    events,
    requested: requested.promise,
    cancelled: cancelled.promise,
    config,
    headers,
  };
}

test("only the attached owner can update ownership or complete incremental native streams", async () => {
  const h = await setup();
  await expect(h.bridge.attach("intruder", models, () => {})).rejects.toThrow("another connection");
  h.bridge.detach("intruder", { disable: true });
  expect(h.bridge.isEnabled()).toBe(true);
  const responsePromise = fetch(`${h.config.baseUrl}/v1/pi/stream`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify(body),
  });
  const event = await h.requested;
  expect(event.body.modelId).toBe("openai/native/model");
  h.bridge.receive("intruder", event.requestId, { type: "error", message: "must not win" });
  h.bridge.receive("owner", event.requestId, {
    type: "headers",
    status: 200,
    contentType: "application/x-ndjson",
  });
  const response = await responsePromise;
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  h.bridge.receive("owner", event.requestId, { type: "chunk", data: "first \u{1F419}\n" });
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("first \u{1F419}\n");
  h.bridge.receive("owner", event.requestId, { type: "chunk", data: "last\n" });
  h.bridge.receive("owner", event.requestId, { type: "end" });
  const last = await reader.read();
  expect(new TextDecoder().decode(last.value)).toBe("last\n");
  expect((await reader.read()).done).toBe(true);
  expect(h.events.filter((value) => value.type === "cancel")).toHaveLength(0);
});

test("source detach terminates inference without retry and keeps local mode enabled until its owner disables it", async () => {
  const h = await setup();
  const responsePromise = fetch(`${h.config.baseUrl}/v1/pi/stream`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify(body),
  });
  const event = await h.requested;
  h.bridge.detach("owner");
  expect((await responsePromise).status).toBe(410);
  expect(await h.cancelled).toEqual({ type: "cancel", requestId: event.requestId });
  expect(await h.bridge.getLaunchConfig()).toBeNull();
  expect(h.bridge.isEnabled()).toBe(true);
  expect((await fetch(`${h.config.baseUrl}/models`, { headers: h.headers })).status).toBe(410);
  h.bridge.detach("intruder", { disable: true });
  expect(h.bridge.isEnabled()).toBe(true);
  h.bridge.detach("owner", { disable: true });
  expect(h.bridge.isEnabled()).toBe(false);
});

test("closing the HTTP consumer cancels its source request and ignores late frames", async () => {
  const h = await setup();
  const controller = new AbortController();
  const responsePromise = fetch(`${h.config.baseUrl}/v1/pi/stream`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const event = await h.requested;
  h.bridge.receive("owner", event.requestId, {
    type: "headers",
    status: 200,
    contentType: "application/x-ndjson",
  });
  await responsePromise;
  controller.abort();
  expect(await h.cancelled).toEqual({ type: "cancel", requestId: event.requestId });
  expect(() =>
    h.bridge.receive("owner", event.requestId, { type: "chunk", data: "late" }),
  ).not.toThrow();
});

test("chunks before headers fail the stream and cancel the source", async () => {
  const h = await setup();
  const responsePromise = fetch(`${h.config.baseUrl}/v1/pi/stream`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify(body),
  });
  const event = await h.requested;
  h.bridge.receive("owner", event.requestId, { type: "chunk", data: "not a valid transition" });
  expect((await responsePromise).status).toBe(502);
  expect((await h.cancelled).requestId).toBe(event.requestId);
});

test("only authenticated no-Origin catalog and exact native model requests are accepted", async () => {
  const h = await setup();
  expect((await fetch(`${h.config.baseUrl}/models`)).status).toBe(403);
  expect(
    (
      await fetch(`${h.config.baseUrl}/models`, {
        headers: { ...h.headers, origin: "http://localhost" },
      })
    ).status,
  ).toBe(403);
  const catalog = await fetch(`${h.config.baseUrl}/models`, { headers: h.headers });
  expect(await catalog.json()).toEqual(models);
  for (const modelId of [
    "openai/native/model",
    "desktop-local/openai/other",
    "https://upstream.invalid/model",
  ]) {
    const response = await fetch(`${h.config.baseUrl}/v1/pi/stream`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...body, modelId }),
    });
    expect(response.status).toBe(400);
  }
  expect(
    (await fetch(`${h.config.baseUrl}/v1/chat/completions`, { method: "POST", headers: h.headers }))
      .status,
  ).toBe(404);
  await expect(
    h.bridge.attach("owner", [{ ...models[0]!, provider: "desktop-local" }], () => {}),
  ).rejects.toThrow("another local model bridge");
  expect(h.events).toEqual([]);
});

test.each(["declared", "chunked"])(
  "rejects oversized %s bodies without emitting inference",
  async (kind) => {
    const h = await setup();
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const request = httpRequest(
      `${h.config.baseUrl}/v1/pi/stream`,
      {
        method: "POST",
        headers: {
          ...h.headers,
          ...(kind === "declared"
            ? { "content-length": String(LOCAL_MODEL_MAX_REQUEST_BYTES + 1) }
            : { "transfer-encoding": "chunked" }),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    if (kind === "chunked") {
      const chunk = Buffer.alloc(1024 * 1024, "x");
      for (let size = 0; size <= LOCAL_MODEL_MAX_REQUEST_BYTES; size += chunk.length)
        request.write(chunk);
    }
    request.end();
    expect(await promise).toBe(413);
    expect(h.events).toEqual([]);
  },
);

test("closing while the ephemeral listener starts leaves no launch config or source", async () => {
  const bridge = new LocalModelBridge();
  const opening = bridge.attach("owner", models, () => {});
  const assertion = expect(opening).rejects.toThrow("closed");
  await bridge.close();
  await assertion;
  expect(await bridge.getLaunchConfig()).toBeNull();
});
