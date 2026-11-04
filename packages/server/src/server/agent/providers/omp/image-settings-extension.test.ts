import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationRuntimeConfig } from "../../../daemon-config-store.js";
import {
  NativeImagePreferences,
  type NativeImageExtensionApi,
  type NativeImageModel,
  type NativeImageRegistry,
} from "./image-settings-extension.js";
import { supportsOmpNativeImageSettings } from "./image-settings.js";

const apiConfig: ImageGenerationRuntimeConfig = {
  enabled: true,
  provider: "openai",
  backend: "openai-api",
  model: "custom-image",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiKey: "!not-a-command-secret",
  apiKeyConfigured: true,
  apiKeySource: "config",
};
const preferences: NativeImagePreferences[] = [];
afterEach(() => {
  for (const preference of preferences.splice(0)) preference.dispose();
});

function createHarness() {
  const models = new Map<string, NativeImageModel>();
  const carrier: NativeImageModel = {
    id: "native-carrier",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    hostedImage: true,
    kind: "chat",
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  models.set("openai-codex/native-carrier", carrier);
  const active = new Set(["read", "bash", "generate_image"]);
  let accounts = [
    {
      id: 7,
      provider: "openai-codex",
      identityKey: "account:seven",
      credential: { type: "oauth", access: "oauth-seven" },
    },
    {
      id: 8,
      provider: "openai-codex",
      identityKey: "account:eight",
      credential: { type: "oauth", access: "oauth-eight" },
    },
  ];
  const definitions = new Map<string, Record<string, unknown>>();
  const restrictions = new Map<string, readonly string[]>();
  const pins = new Map<string, number>([["chat-session", 8]]);
  const getApiKey = async (
    model: NativeImageModel,
    sessionId?: string,
    _options?: { signal?: AbortSignal },
  ) => {
    if (model.provider === "openai-codex") {
      const identities = restrictions.get(sessionId!);
      const candidate = accounts.find(
        (account) =>
          (!identities || identities.includes(account.identityKey)) &&
          (!pins.has(sessionId!) || account.id === pins.get(sessionId!)),
      );
      return candidate?.credential.access;
    }
    const definition = definitions.get(model.provider);
    return definition ? process.env[String(definition.apiKey)] : "chat-key";
  };
  const resolver = (
    model: NativeImageModel | string,
    sessionId?: string | Record<string, unknown>,
  ) =>
    typeof model === "string"
      ? undefined
      : getApiKey(model, typeof sessionId === "string" ? sessionId : undefined);
  const sessions: NativeImageRegistry["authStorage"]["sessions"] = {
    restrict: (_provider, sessionId, identities) => {
      restrictions.set(sessionId, [...identities]);
      return Symbol("restriction");
    },
    unrestrict: (_provider, sessionId) => {
      restrictions.delete(sessionId);
    },
    pin: (_provider, sessionId, id) => {
      if (
        !accounts.some(
          (account) =>
            account.id === id && restrictions.get(sessionId)?.includes(account.identityKey),
        )
      )
        return false;
      pins.set(sessionId, id);
      return true;
    },
    release: (_provider, sessionId) => pins.delete(sessionId),
  };
  const registry: NativeImageRegistry = {
    getAvailable: () => Array.from(models.values()),
    find: (provider, id) => models.get(`${provider}/${id}`),
    getApiKey,
    resolver,
    authStorage: {
      credentials: {
        revalidate: vi.fn(async () => undefined),
        snapshot: () => ({ credentials: accounts }),
      },
      sessions,
    },
  };
  const pi: NativeImageExtensionApi = {
    on: vi.fn(),
    getAllTools: () => ["read", "bash", "generate_image"].map((name) => ({ name })),
    setToolEnabled: async (name, enabled) => {
      if (enabled) active.add(name);
      else active.delete(name);
    },
    registerProvider: vi.fn((provider: string, definition: Record<string, unknown>) => {
      definitions.set(provider, definition);
      const model = (definition.models as NativeImageModel[])[0]!;
      models.set(`${provider}/${model.id}`, {
        ...model,
        provider,
        baseUrl: String(definition.baseUrl),
      });
    }),
    unregisterProvider: vi.fn((provider: string) => {
      definitions.delete(provider);
      for (const key of models.keys()) if (key.startsWith(`${provider}/`)) models.delete(key);
    }),
  };
  const preference = new NativeImagePreferences(pi, { modelRegistry: registry, model: carrier });
  preferences.push(preference);
  const call = (id = "image-call", model = "openai/escape-model") => {
    const result = preference.beforeToolCall({
      toolName: "generate_image",
      toolCallId: id,
      input: { subject: "a cat", model },
    }) as { input: { model: string; subject: string } };
    const selected = models.get(result.input.model)!;
    return { result, selected };
  };
  return {
    preference,
    registry,
    pi,
    models,
    definitions,
    getApiKey,
    resolver,
    sessions,
    carrier,
    call,
    activeTools: () => [...active],
    registerDynamicTool: (name: string) => active.add(name),
    removeAccounts: () => {
      accounts = [];
    },
  };
}

describe("Desktop preferences for native generate_image", () => {
  it("requires the native settings/auth APIs rather than pretending older versions support images", () => {
    expect(supportsOmpNativeImageSettings("omp 18.8.6")).toBe(false);
    expect(supportsOmpNativeImageSettings("omp 18.8.7")).toBe(true);
    expect(supportsOmpNativeImageSettings("omp 19.0.0")).toBe(true);
    expect(supportsOmpNativeImageSettings("unversioned")).toBe(false);
  });

  it("removes only image access when disabled or prohibited by the native tool policy", async () => {
    const h = createHarness();
    await h.preference.apply(null, true);
    expect(h.activeTools()).toEqual(["read", "bash"]);
    expect(
      h.preference.beforeToolCall({
        toolName: "generate_image",
        toolCallId: "disabled",
        input: {},
      }),
    ).toMatchObject({ block: true });
    await h.preference.apply(apiConfig, false);
    expect(h.activeTools()).toEqual(["read", "bash"]);
    expect(
      h.preference.beforeToolCall({ toolName: "read", toolCallId: "read", input: {} }),
    ).toBeUndefined();
  });

  it("retains independently registered dynamic tools through disabled and enabled image settings", async () => {
    const h = createHarness();
    h.registerDynamicTool("figma_get_metadata");
    await h.preference.apply(null, false);
    h.registerDynamicTool("figma_create_session");
    await h.preference.apply(apiConfig, true);
    expect(h.activeTools()).toEqual([
      "read",
      "bash",
      "figma_get_metadata",
      "figma_create_session",
      "generate_image",
    ]);
    await h.preference.apply(null, false);
    expect(h.activeTools()).toEqual(["read", "bash", "figma_get_metadata", "figma_create_session"]);
  });

  it("keeps concurrent calls and changed settings on their original private provider/key", async () => {
    const h = createHarness();
    await h.preference.apply(apiConfig, true);
    const first = h.call("first");
    const concurrent = h.call("concurrent");
    expect(first.selected).not.toBe(concurrent.selected);
    await h.registry.getApiKey(first.selected);
    expect(first.selected.provider).toBe("openai");
    expect(concurrent.selected.provider).not.toBe("openai");
    await h.preference.apply({ ...apiConfig, apiKey: "new-key", model: "new-image" }, true);
    const next = h.call("next");
    expect(await h.registry.getApiKey(next.selected)).toBe("new-key");
    expect(await h.registry.getApiKey(first.selected)).toBe(apiConfig.apiKey);
    expect(next.selected.id).toBe("new-image");
    const keyEnv = String(h.definitions.get(first.result.input.model.split("/")[0]!)!.apiKey);
    h.preference.dispose();
    expect(process.env[keyEnv]).toBeUndefined();
  });

  it("keeps selected image account credentials separate from the chat account", async () => {
    const h = createHarness();
    await h.preference.apply(
      { ...apiConfig, backend: "chatgpt-subscription", subscriptionCredentialId: 7 },
      true,
    );
    const { selected } = h.call();
    expect(await h.registry.getApiKey(selected, "chat-session")).toBe("oauth-seven");
    expect(await h.registry.resolver(selected, "chat-session")).toBe("oauth-seven");
    expect(await h.registry.getApiKey(h.carrier, "chat-session")).toBe("oauth-eight");
    await h.preference.apply(
      { ...apiConfig, backend: "chatgpt-subscription", subscriptionCredentialId: 8 },
      true,
    );
    expect(await h.registry.getApiKey(h.call("next").selected, "chat-session")).toBe("oauth-eight");
    expect(await h.registry.getApiKey(selected, "chat-session")).toBe("oauth-seven");
  });

  it("fails closed on selected subscription removal instead of using another account or API key", async () => {
    const h = createHarness();
    const config = {
      ...apiConfig,
      backend: "chatgpt-subscription" as const,
      subscriptionCredentialId: 7,
    };
    await h.preference.apply(config, true);
    h.removeAccounts();
    await h.preference.apply(config, true);
    expect(h.activeTools()).not.toContain("generate_image");
    expect(
      h.preference.beforeToolCall({ toolName: "generate_image", toolCallId: "removed", input: {} }),
    ).toMatchObject({ block: true });
  });

  it("blocks image requests without API credentials while leaving ordinary tools usable", async () => {
    const h = createHarness();
    await h.preference.apply({ ...apiConfig, apiKey: undefined }, true);
    expect(h.activeTools()).toEqual(["read", "bash"]);
    expect(
      h.preference.beforeToolCall({ toolName: "generate_image", toolCallId: "no-key", input: {} }),
    ).toMatchObject({ block: true });
    expect(
      h.preference.beforeToolCall({ toolName: "read", toolCallId: "ordinary", input: {} }),
    ).toBeUndefined();
  });
  it("does not replace chat credentials when a user provider resembles an internal image name", async () => {
    const h = createHarness();
    const chatModel = {
      ...h.carrier,
      provider: "desktop-native-image-1",
      api: "openai-completions",
    };
    h.models.set(`${chatModel.provider}/${chatModel.id}`, chatModel);
    await h.preference.apply(apiConfig, true);
    expect(await h.registry.getApiKey(chatModel, "chat-session")).toBe("chat-key");
    expect(chatModel.provider).toBe("desktop-native-image-1");
  });
});
