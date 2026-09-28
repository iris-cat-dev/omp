import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageGenerationRuntimeConfig } from "../daemon-config-store.js";
import { OpenAIImageGenerationService } from "./openai-image-generator.js";

const roots: string[] = [];
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function runtimeConfig(
  overrides: Partial<ImageGenerationRuntimeConfig> = {},
): ImageGenerationRuntimeConfig {
  return {
    enabled: true,
    provider: "openai",
    backend: "openai-api",
    model: "gpt-image-2",
    apiKey: "test-key",
    apiKeyConfigured: true,
    apiKeySource: "config",
    ...overrides,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-image-generation-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenAIImageGenerationService", () => {
  it("writes one validated image and forwards generation controls", async () => {
    const paseoHome = await createRoot();
    const generate = vi.fn(async () => ({
      created: 1,
      data: [{ b64_json: PNG_BYTES.toString("base64"), revised_prompt: "revised" }],
    }));
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig(),
      logger: pino({ level: "silent" }),
      createClient: () => ({ generate, edit: vi.fn() }),
    });

    const result = await service.generate(
      {
        prompt: "  a red fox  ",
        size: "1536x1024",
        quality: "high",
        background: "opaque",
        outputFormat: "png",
      },
      { agentId: "agent/../../unsafe" },
    );

    expect(generate).toHaveBeenCalledWith(
      {
        prompt: "a red fox",
        model: "gpt-image-2",
        n: 1,
        size: "1536x1024",
        quality: "high",
        background: "opaque",
        output_format: "png",
        stream: false,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toMatchObject({
      prompt: "a red fox",
      model: "gpt-image-2",
      mimeType: "image/png",
      revisedPrompt: "revised",
    });
    expect(await readFile(result.filePath)).toEqual(PNG_BYTES);
    expect(result.filePath.startsWith(path.join(paseoHome, "generated-images"))).toBe(true);
    expect(result.filePath).not.toContain("unsafe");
  });

  it.each([1, 3])("edits with %i OpenAI API reference image(s)", async (referenceCount) => {
    const paseoHome = await createRoot();
    const referenceImagePaths = await Promise.all(
      Array.from({ length: referenceCount }, async (_, index) => {
        const filePath = path.join(paseoHome, `reference-${index}.png`);
        await writeFile(filePath, PNG_BYTES);
        return filePath;
      }),
    );
    const generate = vi.fn();
    const edit = vi.fn(async () => ({
      created: 1,
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    }));
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig(),
      logger: pino({ level: "silent" }),
      createClient: () => ({ generate, edit }),
    });

    await service.generate(
      {
        prompt: "preserve the subject and change the lighting",
        referenceImagePaths,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        outputFormat: "png",
      },
      { agentId: "agent" },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(
      {
        image: referenceImagePaths.map((filePath) => expect.objectContaining({ path: filePath })),
        prompt: "preserve the subject and change the lighting",
        model: "gpt-image-2",
        n: 1,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        output_format: "png",
        stream: false,
      },
      { signal: expect.any(AbortSignal) },
    );
  });
  it("uses the selected ChatGPT subscription without an API key", async () => {
    const paseoHome = await createRoot();
    const resolve = vi.fn(async () => ({
      accessToken: "oauth-token",
      accountId: "account-123",
      planType: "plus",
    }));
    const fetchApi = vi.fn(async () =>
      Response.json({
        created: 1,
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
      }),
    );
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () =>
        runtimeConfig({
          backend: "chatgpt-subscription",
          apiKey: undefined,
          apiKeyConfigured: false,
          apiKeySource: null,
          subscriptionCredentialId: 7,
        }),
      logger: pino({ level: "silent" }),
      subscriptionCredentialResolver: { resolve },
      fetch: fetchApi,
    });

    const result = await service.generate(
      {
        prompt: "  a lighthouse  ",
        size: "1024x1536",
        quality: "medium",
        background: "opaque",
        outputFormat: "png",
      },
      { agentId: "agent" },
    );

    expect(resolve).toHaveBeenCalledWith(7, {
      forceRefresh: false,
      signal: expect.any(AbortSignal),
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
    const [url, init] = fetchApi.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer oauth-token",
        "ChatGPT-Account-ID": "account-123",
        "Content-Type": "application/json",
        "x-codex-image-turn-id": expect.any(String),
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: "a lighthouse",
      background: "opaque",
      model: "gpt-image-2",
      quality: "medium",
      size: "1024x1536",
    });
    expect(result).toMatchObject({
      model: "gpt-image-2",
      mimeType: "image/png",
      outputFormat: "png",
    });
    expect(await readFile(result.filePath)).toEqual(PNG_BYTES);
  });

  it("sends multiple reference images to the ChatGPT subscription edit endpoint", async () => {
    const paseoHome = await createRoot();
    const firstPath = path.join(paseoHome, "subject.png");
    const secondPath = path.join(paseoHome, "style.png");
    await Promise.all([writeFile(firstPath, PNG_BYTES), writeFile(secondPath, PNG_BYTES)]);
    const resolve = vi.fn(async () => ({
      accessToken: "oauth-token",
      accountId: "account-123",
      planType: "plus",
    }));
    const fetchApi = vi.fn(async () =>
      Response.json({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
    );
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () =>
        runtimeConfig({
          backend: "chatgpt-subscription",
          apiKey: undefined,
          apiKeyConfigured: false,
          apiKeySource: null,
          subscriptionCredentialId: 7,
        }),
      logger: pino({ level: "silent" }),
      subscriptionCredentialResolver: { resolve },
      fetch: fetchApi,
    });

    await service.generate(
      {
        prompt: "use image 1 as the subject and image 2 as the style",
        referenceImagePaths: [firstPath, secondPath],
      },
      { agentId: "agent" },
    );

    const [url, init] = fetchApi.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: "use image 1 as the subject and image 2 as the style",
      background: "auto",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
      images: [
        { image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
        { image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
      ],
    });
  });

  it("refreshes a ChatGPT subscription token once after an unauthorized response", async () => {
    const paseoHome = await createRoot();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        accessToken: "stale-token",
        accountId: "account-123",
        planType: "plus",
      })
      .mockResolvedValueOnce({
        accessToken: "fresh-token",
        accountId: "account-123",
        planType: "plus",
      });
    const fetchApi = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }));
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () =>
        runtimeConfig({
          backend: "chatgpt-subscription",
          apiKey: undefined,
          subscriptionCredentialId: 7,
        }),
      logger: pino({ level: "silent" }),
      subscriptionCredentialResolver: { resolve },
      fetch: fetchApi,
    });

    await service.generate({ prompt: "fox" }, { agentId: "agent" });

    expect(resolve).toHaveBeenNthCalledWith(2, 7, {
      forceRefresh: true,
      signal: expect.any(AbortSignal),
    });
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(fetchApi.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh-token",
    });
  });

  it("rejects unsupported subscription output before resolving credentials", async () => {
    const paseoHome = await createRoot();
    const resolve = vi.fn();
    const fetchApi = vi.fn();
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () =>
        runtimeConfig({
          backend: "chatgpt-subscription",
          apiKey: undefined,
          subscriptionCredentialId: 7,
        }),
      logger: pino({ level: "silent" }),
      subscriptionCredentialResolver: { resolve },
      fetch: fetchApi,
    });

    await expect(
      service.generate({ prompt: "fox", outputFormat: "jpeg" }, { agentId: "agent" }),
    ).rejects.toThrow("PNG output only");
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("fails before networking when disabled or missing credentials", async () => {
    const paseoHome = await createRoot();
    const generate = vi.fn();
    const disabled = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig({ enabled: false }),
      logger: pino({ level: "silent" }),
      createClient: () => ({ generate, edit: vi.fn() }),
    });
    await expect(disabled.generate({ prompt: "fox" }, { agentId: "agent" })).rejects.toThrow(
      "disabled",
    );

    const missingKey = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig({ apiKey: undefined, apiKeyConfigured: false }),
      logger: pino({ level: "silent" }),
      createClient: () => ({ generate, edit: vi.fn() }),
    });
    await expect(missingKey.generate({ prompt: "fox" }, { agentId: "agent" })).rejects.toThrow(
      "API key",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects invalid image bytes without leaving an output file", async () => {
    const paseoHome = await createRoot();
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig(),
      logger: pino({ level: "silent" }),
      createClient: () => ({
        generate: async () => ({
          created: 1,
          data: [{ b64_json: Buffer.from("not png").toString("base64") }],
        }),
        edit: vi.fn(),
      }),
    });

    await expect(service.generate({ prompt: "fox" }, { agentId: "agent" })).rejects.toThrow(
      "not valid png",
    );
    const generatedRoot = path.join(paseoHome, "generated-images");
    await expect(readdir(generatedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported transparent output before networking", async () => {
    const paseoHome = await createRoot();
    const generate = vi.fn();
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig(),
      logger: pino({ level: "silent" }),
      createClient: () => ({ generate, edit: vi.fn() }),
    });

    await expect(
      service.generate(
        { prompt: "fox", background: "transparent", outputFormat: "png" },
        { agentId: "agent" },
      ),
    ).rejects.toThrow("does not support transparent backgrounds");
    expect(generate).not.toHaveBeenCalled();
  });

  it("aborts a stalled provider request at the configured deadline", async () => {
    const paseoHome = await createRoot();
    const service = new OpenAIImageGenerationService({
      paseoHome,
      getConfig: () => runtimeConfig({ baseUrl: "https://images.example/v1" }),
      logger: pino({ level: "silent" }),
      requestTimeoutMs: 10,
      createClient: () => ({
        generate: (_input, options) => {
          const { promise, reject } = Promise.withResolvers<never>();
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
          return promise;
        },
        edit: vi.fn(),
      }),
    });

    await expect(service.generate({ prompt: "fox" }, { agentId: "agent" })).rejects.toThrow(
      "timed out",
    );
  });
});
