import { once } from "node:events";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOmpProviderModels } from "./omp-model-discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverOmpProviderModels", () => {
  it("loads an OpenAI-compatible model list from the versioned endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-5.6-sol",
              display_name: "GPT 5.6 Sol",
              supported_apis: ["openai-responses", "anthropic-messages", "unsupported"],
              input_modalities: ["text", "image"],
              context_window: 200_000,
              max_output_tokens: 32_000,
              reasoning: true,
              default_reasoning_level: "medium",
              supported_reasoning_levels: ["low", "medium", "high"],
            },
            { id: "gpt-5.6-luna" },
            { id: "gpt-5.6-sol", display_name: "Duplicate" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverOmpProviderModels({ baseUrl: "https://api.example.test", apiKey: "secret" }),
    ).resolves.toEqual([
      {
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        supportedApis: ["openai-responses", "anthropic-messages"],
        inputModalities: ["text", "image"],
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        reasoning: true,
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
      { id: "gpt-5.6-luna", name: "gpt-5.6-luna" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.example.test/v2/models"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("normalizes advertised tier IDs without inferring support from model names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "advertised",
                service_tiers: [
                  " ultrafast ",
                  { id: "priority" },
                  { id: "ultrafast" },
                  "",
                  " ",
                  null,
                  42,
                  {},
                  { id: "" },
                  { id: false },
                ],
              },
              { id: "explicit-negative", service_tiers: [] },
              { id: "priority-only", service_tiers: [{ id: "priority" }] },
              { id: "gpt-ultrafast" },
              { id: "invalid-metadata", service_tiers: "ultrafast" },
              { id: "invalid-ids", service_tiers: [null, {}, { id: " " }] },
            ],
          }),
        ),
      ),
    );

    await expect(
      discoverOmpProviderModels({ baseUrl: "https://api.example.test", apiKey: "secret" }),
    ).resolves.toEqual([
      { id: "advertised", name: "advertised", serviceTiers: ["ultrafast", "priority"] },
      { id: "explicit-negative", name: "explicit-negative", serviceTiers: [] },
      { id: "priority-only", name: "priority-only", serviceTiers: ["priority"] },
      { id: "gpt-ultrafast", name: "gpt-ultrafast" },
      { id: "invalid-metadata", name: "invalid-metadata" },
      { id: "invalid-ids", name: "invalid-ids", serviceTiers: [] },
    ]);
  });

  it("does not append a second version segment", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await discoverOmpProviderModels({
      baseUrl: "https://api.example.test/v1/",
      apiKey: "secret",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(new URL("https://api.example.test/v2/models"));
  });

  it("normalizes a v2 base URL and falls back after a 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "model-1" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await discoverOmpProviderModels({
      baseUrl: "https://api.example.test/v2/",
      apiKey: "secret",
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v2/models",
      "https://api.example.test/v1/models",
    ]);
  });

  it.each([
    ["invalid JSON", () => new Response("not JSON")],
    ["an empty model list", () => new Response(JSON.stringify({ data: [] }))],
    ["an error payload", () => new Response(JSON.stringify({ error: "unsupported" }))],
    ["HTTP 401", () => new Response("unauthorized", { status: 401 })],
    ["HTTP 500", () => new Response("unavailable", { status: 500 })],
    ["an oversized body", () => new Response("x".repeat(1_000_001))],
    [
      "an oversized content length",
      () =>
        new Response("", {
          headers: { "content-length": "1000001" },
        }),
    ],
    ["a fetch failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ])("falls back to v1 after %s", async (_reason, response) => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "model-1" }] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverOmpProviderModels({ baseUrl: "https://api.example.test/v1", apiKey: "secret" }),
    ).resolves.toEqual([{ id: "model-1", name: "model-1" }]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v2/models",
      "https://api.example.test/v1/models",
    ]);
  });

  it.each(["misdeclared", "truncated", "valid"])(
    "handles %s gzip over HTTP without losing endpoint precedence",
    async (encoding) => {
      const paths: string[] = [];
      const server = createServer((request, response) => {
        const path = request.url ?? "";
        paths.push(path);
        const compressed = gzipSync(
          JSON.stringify({
            data: [{ id: path === "/v2/models" ? "enhanced-model" : "fallback-model" }],
          }),
        );
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(
          path === "/v2/models" && encoding !== "valid"
            ? encoding === "misdeclared"
              ? "not gzip"
              : compressed.subarray(0, Math.floor(compressed.length / 2))
            : compressed,
        );
      });
      await once(server.listen(0, "127.0.0.1"), "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing HTTP server port");
        await expect(
          discoverOmpProviderModels({
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "secret",
          }),
        ).resolves.toEqual(
          encoding === "valid"
            ? [{ id: "enhanced-model", name: "enhanced-model" }]
            : [{ id: "fallback-model", name: "fallback-model" }],
        );
        expect(paths).toEqual(encoding === "valid" ? ["/v2/models"] : ["/v2/models", "/v1/models"]);
      } finally {
        server.closeAllConnections();
        const closed = Promise.withResolvers<void>();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        await closed.promise;
      }
    },
  );

  it("returns an empty list when every endpoint fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("not JSON"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverOmpProviderModels({
        baseUrl: "https://api.example.test/custom",
        apiKey: "secret",
      }),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/custom/v2/models",
      "https://api.example.test/custom/v1/models",
      "https://api.example.test/custom/models",
    ]);
  });

  it("treats an HTML v2 response as an unsupported endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>Sub2API</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "model-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverOmpProviderModels({
        baseUrl: "https://api.example.test",
        apiKey: "secret",
      }),
    ).resolves.toEqual([{ id: "model-1", name: "model-1" }]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/v2/models",
      "https://api.example.test/v1/models",
    ]);
  });

  it("falls back to a direct models endpoint after a versioned 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ id: "model-1", name: "Model One" }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverOmpProviderModels({
        baseUrl: "https://api.example.test/custom",
        apiKey: "secret",
      }),
    ).resolves.toEqual([{ id: "model-1", name: "Model One" }]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/custom/v2/models",
      "https://api.example.test/custom/v1/models",
      "https://api.example.test/custom/models",
    ]);
  });
});
