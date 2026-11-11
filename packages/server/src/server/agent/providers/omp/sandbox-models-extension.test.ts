import { afterEach, expect, test, vi } from "vitest";
import sandboxModels from "./sandbox-models-extension.js";

const model = { provider: "fixture-provider", id: "custom/model@cn", api: "fixture-api" };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("registers exact provider identities with inference-only registry access", async () => {
  vi.stubEnv("OMP_DESKTOP_SANDBOX_MODEL_BRIDGE", JSON.stringify({ baseUrl: "http://127.0.0.1:12345", token: "private-hop" }));
  const fetchCatalog = vi.fn(async () => Response.json([model]));
  vi.stubGlobal("fetch", fetchCatalog);
  const registerProvider = vi.fn();
  const rows = [{ ...model, baseUrl: "https://private-provider.invalid", headers: { secret: "must-not-cross" }, resolveHeaders: vi.fn(), transport: undefined }, { provider: "ambient", id: "not-granted" }];
  const credential = vi.fn(async (_provider: string) => ({ apiKey: "host-credential" }));
  const registry = {
    getAvailable: vi.fn(() => rows), getAll: vi.fn(() => rows),
    getAvailableForProviders: vi.fn(() => rows), getProviderModels: vi.fn(() => rows),
    find: vi.fn((provider: string, id: string) => rows.find(row => row.provider === provider && row.id === id)),
    getApiKey: vi.fn(async (_model: { provider: string; id: string }) => "host-credential"),
    getApiKeyWithCredentialForProvider: credential,
    resolver: vi.fn((_target: string | typeof model) => ({ resolve: async () => "original resolver" })),
  };
  await sandboxModels({ registerProvider, on: (event, handler) => { expect(event).toBe("session_start"); handler(undefined, { modelRegistry: registry }); } });
  expect(fetchCatalog).toHaveBeenCalledWith("http://127.0.0.1:12345/models", expect.objectContaining({ headers: { authorization: "Bearer private-hop" } }));
  expect(process.env.OMP_DESKTOP_SANDBOX_MODEL_BRIDGE).toBeUndefined();
  expect(registerProvider).toHaveBeenCalledExactlyOnceWith(model.provider, expect.objectContaining({ transport: "pi-native", apiKey: "private-hop", models: [expect.objectContaining({ ...model, name: model.id })] }));
  for (const method of [registry.getAvailable, registry.getAll, registry.getAvailableForProviders, registry.getProviderModels]) {
    expect(method()).toEqual([expect.objectContaining({ ...model, baseUrl: "http://127.0.0.1:12345", transport: "pi-native" })]);
  }
  expect(registry.find("ambient", "not-granted")).toBeUndefined();
  expect(rows[0]).not.toHaveProperty("headers");
  expect(rows[0]).not.toHaveProperty("resolveHeaders");
  expect(await registry.getApiKey(model)).toBe("private-hop");
  expect(await registry.resolver(model).resolve()).toBe("original resolver");
  expect(credential).not.toHaveBeenCalled();
  expect(await registry.getApiKeyWithCredentialForProvider(model.provider)).toEqual({ apiKey: "private-hop" });
  expect(() => registry.resolver("ambient")).toThrow("Sandbox provider is unavailable");
  await expect(registry.getApiKey({ provider: "fixture-provider", id: "missing" })).rejects.toThrow("Sandbox model is unavailable");
});

test.each(["https://provider.invalid", "http://localhost:12345", "http://127.0.0.1:12345/private"])("rejects non-private source %s before registering providers", async baseUrl => {
  vi.stubEnv("OMP_DESKTOP_SANDBOX_MODEL_BRIDGE", JSON.stringify({ baseUrl, token: "private-hop" }));
  const registerProvider = vi.fn();
  await expect(sandboxModels({ registerProvider, on: vi.fn() })).rejects.toThrow("private loopback");
  expect(registerProvider).not.toHaveBeenCalled();
});

test("refuses recursive model sources", async () => {
  vi.stubEnv("OMP_DESKTOP_SANDBOX_MODEL_BRIDGE", JSON.stringify({ baseUrl: "http://127.0.0.1:12345", token: "private-hop" }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ ...model, provider: "desktop-local" }])));
  await expect(sandboxModels({ registerProvider: vi.fn(), on: vi.fn() })).rejects.toThrow("another model bridge");
});
