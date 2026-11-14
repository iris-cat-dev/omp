import { describe, expect, test } from "vitest";
import {
  GetProvidersSnapshotResponseMessageSchema,
  OmpCustomProviderInputSchema,
  OmpProviderModelDiscoveryResponseMessageSchema,
  ProviderSnapshotEntrySchema,
  ProvidersSnapshotUpdateMessageSchema,
} from "./messages.js";

describe("provider snapshot message schemas", () => {
  test("defaults missing provider snapshot entry enabled state to true", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "codex",
      status: "ready",
      label: "Codex",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves disabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "claude",
      status: "unavailable",
      enabled: false,
      label: "Claude",
    });

    expect(parsed.enabled).toBe(false);
  });

  test("preserves enabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "opencode",
      status: "loading",
      enabled: true,
      label: "OpenCode",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves provider snapshot entry source", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "gemini",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Gemini",
    });

    expect(parsed.source).toBe("custom");
  });

  test("defaults missing enabled state in providers snapshot response entries", () => {
    const parsed = GetProvidersSnapshotResponseMessageSchema.parse({
      type: "get_providers_snapshot_response",
      payload: {
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
          {
            provider: "claude",
            status: "unavailable",
            enabled: false,
            label: "Claude",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
        requestId: "req-providers",
      },
    });

    expect(parsed.payload.entries.map((entry) => entry.enabled)).toEqual([true, false]);
  });

  test("defaults missing enabled state in providers snapshot update entries", () => {
    const parsed = ProvidersSnapshotUpdateMessageSchema.parse({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/tmp/repo",
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
      },
    });

    expect(parsed.payload.entries[0]?.enabled).toBe(true);
  });
});

describe("custom provider tier metadata schemas", () => {
  test.each([
    { serviceTiers: undefined },
    { serviceTiers: [] },
    { serviceTiers: ["priority"] },
    { serviceTiers: ["ultrafast", "priority"] },
  ])(
    "preserves advertised tiers through discovery and provider input: $serviceTiers",
    ({ serviceTiers }) => {
      const model = {
        id: "gpt-test",
        name: "GPT Test",
        ...(serviceTiers !== undefined ? { serviceTiers } : {}),
      };
      const discovery = OmpProviderModelDiscoveryResponseMessageSchema.parse({
        type: "omp.provider.models.discover.response",
        payload: { requestId: "discover", models: [model] },
      });
      const provider = OmpCustomProviderInputSchema.parse({
        providerId: "custom",
        baseUrl: "https://api.example.test/v1",
        apiKey: "secret",
        api: "openai-responses",
        models: discovery.payload.models,
      });

      expect(provider.models[0]).toEqual(model);
    },
  );

  test.each([
    { serviceTiers: [""] },
    { serviceTiers: [" "] },
    { serviceTiers: [42] },
    { serviceTiers: [{ id: "ultrafast" }] },
    { serviceTiers: "ultrafast" },
    { serviceTiers: null },
  ])("rejects invalid internal tier declarations: $serviceTiers", ({ serviceTiers }) => {
    const model = { id: "gpt-test", name: "GPT Test", serviceTiers };
    expect(
      OmpProviderModelDiscoveryResponseMessageSchema.safeParse({
        type: "omp.provider.models.discover.response",
        payload: { requestId: "discover", models: [model] },
      }).success,
    ).toBe(false);
    expect(
      OmpCustomProviderInputSchema.safeParse({
        providerId: "custom",
        baseUrl: "https://api.example.test/v1",
        apiKey: "secret",
        api: "openai-responses",
        models: [model],
      }).success,
    ).toBe(false);
  });
});
