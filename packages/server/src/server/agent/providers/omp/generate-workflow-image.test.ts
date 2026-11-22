import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ImageGenerationRuntimeConfig } from "../../../daemon-config-store.js";
import { generateWorkflowImage } from "./generate-workflow-image.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const image = {
  mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j63sAAAAASUVORK5CYII=",
};
const prompt = "Set the background to amber!\nKeep the silhouette unchanged.";
const apiKey = "loopback-fixture-key";
const config: ImageGenerationRuntimeConfig = {
  enabled: true,
  provider: "openai",
  backend: "openai-api",
  model: "gpt-image-1",
  apiKey,
  apiKeyConfigured: true,
  apiKeySource: "config",
};

async function loopback(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Image fixture did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/fixtures/v1`,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it("sends an unchanged prompt and uses the scoped OpenAI JSON generation and multipart edit endpoints", async () => {
  const requests: Array<{ path?: string; auth?: string; contentType?: string; body: Buffer }> = [];
  const endpoint = await loopback(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url,
      auth: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks),
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ b64_json: image.data, media_type: image.mimeType }] }));
  });
  try {
    for (const images of [[], [image]]) {
      await expect(generateWorkflowImage(
        { prompt, images }, { ...config, baseUrl: endpoint.baseUrl }, AbortSignal.timeout(10_000),
        { runtimeSettings: ompHistoryRuntimeSettings },
      )).resolves.toEqual(image);
    }
    expect(requests.map(({ path, auth }) => [path, auth])).toEqual([
      ["/fixtures/v1/images/generations", `Bearer ${apiKey}`],
      ["/fixtures/v1/images/edits", `Bearer ${apiKey}`],
    ]);
    expect(JSON.parse(requests[0]!.body.toString())).toEqual({ model: "gpt-image-1", prompt, n: 1 });
    const edit = await new Response(new Uint8Array(requests[1]!.body), {
      headers: { "Content-Type": requests[1]!.contentType! },
    }).formData();
    expect(String(edit.get("prompt")).replaceAll("\r\n", "\n")).toBe(prompt);
    const file = edit.get("image");
    if (!(file instanceof File)) throw new Error("Expected a multipart reference image");
    expect(file.type).toBe(image.mimeType);
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(image.data);
  } finally {
    await endpoint.close();
  }
});

it("redacts provider failures and refuses invalid image output", async () => {
  let status = 422;
  let body = { error: { message: `The key is ${apiKey}` } } as unknown;
  const endpoint = await loopback((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const generate = () => generateWorkflowImage(
    { prompt, images: [] }, { ...config, baseUrl: endpoint.baseUrl }, AbortSignal.timeout(10_000),
    { runtimeSettings: ompHistoryRuntimeSettings },
  );
  try {
    await expect(generate()).rejects.toMatchObject({
      code: "failed",
      message: "The image provider request failed. Check the host’s image generation settings and credentials.",
    });
    status = 200;
    body = { data: [{ b64_json: image.data, media_type: "image/svg+xml" }] };
    await expect(generate()).rejects.toMatchObject({ code: "invalidImage" });
  } finally {
    await endpoint.close();
  }
});

it("aborts the in-flight loopback provider fetch when the caller cancels", async () => {
  const arrived = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const endpoint = await loopback((request, response) => {
    request.resume();
    response.once("close", disconnected.resolve);
    arrived.resolve();
  });
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]);
  const generation = generateWorkflowImage(
    { prompt, images: [] }, { ...config, baseUrl: endpoint.baseUrl }, signal,
    { runtimeSettings: ompHistoryRuntimeSettings },
  );
  try {
    await Promise.race([arrived.promise, generation]);
    const cancelled = expect(generation).rejects.toMatchObject({ name: "AbortError" });
    cancel.abort();
    await cancelled;
    await disconnected.promise;
  } finally {
    cancel.abort();
    await endpoint.close();
  }
});

it("does not fall back to an OpenAI API key when the selected ChatGPT subscription is unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "omp-image-without-credentials-"));
  let calls = 0;
  const endpoint = await loopback((_request, response) => {
    calls++;
    response.writeHead(500).end();
  });
  try {
    await expect(generateWorkflowImage(
      { prompt, images: [] },
      { ...config, baseUrl: endpoint.baseUrl, backend: "chatgpt-subscription", subscriptionCredentialId: 7 },
      AbortSignal.timeout(10_000),
      { runtimeSettings: {
        ...ompHistoryRuntimeSettings,
        env: {
          HOME: home,
          USERPROFILE: home,
          PI_CONFIG_DIR: join(home, ".omp"),
          PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CACHE_HOME: join(home, "cache"),
          OMP_PROFILE: "",
          PI_PROFILE: "",
          OMP_AUTH_BROKER_URL: "",
          OMP_AUTH_BROKER_TOKEN: "",
          OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: "",
        },
      } },
    )).rejects.toMatchObject({ code: "account" });
    expect(calls).toBe(0);
  } finally {
    await endpoint.close();
    await rm(home, { recursive: true, force: true });
  }
});
