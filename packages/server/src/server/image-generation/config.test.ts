import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MutableDaemonConfig } from "@omp-desktop/protocol/messages";
import { resolveConfigFromPersisted } from "../config.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import {
  loadPersistedConfig,
  PersistedConfigSchema,
  savePersistedConfig,
} from "../persisted-config.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-image-config-"));
  roots.push(root);
  return root;
}

function mutableConfig(
  imageGeneration: MutableDaemonConfig["imageGeneration"],
): MutableDaemonConfig {
  return {
    mcp: { injectIntoAgents: true },
    providers: {},
    metadataGeneration: { providers: [] },
    imageGeneration,
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("image generation configuration", () => {
  it("resolves configured credentials without exposing ambiguity about their source", async () => {
    const paseoHome = await createRoot();
    const persisted = PersistedConfigSchema.parse({
      version: 1,
      providers: {
        openai: {
          image: {
            enabled: true,
            apiKey: "config-key",
            baseUrl: "https://images.example/v1/",
            model: "gpt-image-custom",
          },
        },
      },
    });

    const resolved = resolveConfigFromPersisted(paseoHome, persisted, { env: {} });
    expect(resolved.imageGeneration).toEqual({
      enabled: true,
      provider: "openai",
      backend: "openai-api",
      model: "gpt-image-custom",
      baseUrl: "https://images.example/v1",
      apiKey: "config-key",
      apiKeyConfigured: true,
      apiKeySource: "config",
    });
  });

  it("gives environment credentials and endpoint precedence", async () => {
    const paseoHome = await createRoot();
    const persisted = PersistedConfigSchema.parse({
      version: 1,
      providers: { openai: { image: { apiKey: "config-key", model: "configured" } } },
    });

    const resolved = resolveConfigFromPersisted(paseoHome, persisted, {
      env: {
        OPENAI_API_KEY: "environment-key",
        OPENAI_BASE_URL: "https://environment.example/v1",
        PASEO_IMAGE_GENERATION_MODEL: "environment-model",
        PASEO_IMAGE_GENERATION_ENABLED: "false",
      },
    });
    expect(resolved.imageGeneration).toMatchObject({
      enabled: false,
      model: "environment-model",
      baseUrl: "https://environment.example/v1",
      apiKey: "environment-key",
      apiKeyConfigured: true,
      apiKeySource: "environment",
    });
  });

  it("persists API keys write-only and resolves them only for the runtime", async () => {
    const paseoHome = await createRoot();
    const persisted = PersistedConfigSchema.parse({ version: 1 });
    savePersistedConfig(paseoHome, persisted);
    const store = new DaemonConfigStore(
      paseoHome,
      mutableConfig({
        enabled: false,
        provider: "openai",
        backend: "openai-api",
        model: "gpt-image-2",
        apiKeyConfigured: false,
        apiKeySource: null,
      }),
      undefined,
      { env: {} },
    );

    const publicConfig = store.patch({
      imageGeneration: {
        enabled: true,
        apiKey: "write-only-key",
        baseUrl: "https://images.example/v1",
      },
    });
    expect(publicConfig.imageGeneration).toEqual({
      enabled: true,
      provider: "openai",
      backend: "openai-api",
      model: "gpt-image-2",
      baseUrl: "https://images.example/v1",
      apiKeyConfigured: true,
      apiKeySource: "config",
    });
    expect(JSON.stringify(publicConfig)).not.toContain("write-only-key");
    expect(store.getImageGenerationRuntimeConfig()).toMatchObject({ apiKey: "write-only-key" });
    expect(loadPersistedConfig(paseoHome).providers?.openai?.image?.apiKey).toBe("write-only-key");

    store.patch({ imageGeneration: { apiKey: null, enabled: false } });
    expect(store.getImageGenerationRuntimeConfig()).not.toHaveProperty("apiKey");
    expect(loadPersistedConfig(paseoHome).providers?.openai?.image?.apiKey).toBeUndefined();
  });
  it("persists the selected ChatGPT subscription account", async () => {
    const paseoHome = await createRoot();
    savePersistedConfig(paseoHome, PersistedConfigSchema.parse({ version: 1 }));
    const store = new DaemonConfigStore(
      paseoHome,
      mutableConfig({
        enabled: false,
        provider: "openai",
        backend: "openai-api",
        model: "gpt-image-2",
        apiKeyConfigured: false,
        apiKeySource: null,
      }),
      undefined,
      { env: {} },
    );

    const publicConfig = store.patch({
      imageGeneration: {
        enabled: true,
        backend: "chatgpt-subscription",
        subscriptionCredentialId: 9,
      },
    });

    expect(publicConfig.imageGeneration).toMatchObject({
      enabled: true,
      backend: "chatgpt-subscription",
      subscriptionCredentialId: 9,
    });
    expect(loadPersistedConfig(paseoHome).providers?.openai?.image).toMatchObject({
      enabled: true,
      backend: "chatgpt-subscription",
      subscriptionCredentialId: 9,
    });
  });

  it("rejects writes to environment-controlled fields", async () => {
    const paseoHome = await createRoot();
    savePersistedConfig(paseoHome, PersistedConfigSchema.parse({ version: 1 }));
    const store = new DaemonConfigStore(
      paseoHome,
      mutableConfig({
        enabled: true,
        provider: "openai",
        backend: "openai-api",
        model: "gpt-image-2",
        apiKeyConfigured: true,
        apiKeySource: "environment",
      }),
      undefined,
      { env: { OPENAI_API_KEY: "environment-key" } },
    );

    expect(() => store.patch({ imageGeneration: { apiKey: "replacement" } })).toThrow(
      "controlled by OPENAI_API_KEY",
    );
  });
});
