import { describe, expect, it } from "vitest";
import { LocalModelCatalogSchema } from "./local-models.js";

describe("local model catalog credential boundary", () => {
  it("removes credential-bearing native registry fields before a catalog crosses to another host", () => {
    const models = LocalModelCatalogSchema.parse([
      {
        provider: "custom-provider",
        id: "reasoning-model",
        name: "Reasoning model",
        api: "openai-responses",
        reasoning: true,
        contextWindow: 128_000,
        input: ["text", "image"],
        thinking: {
          efforts: ["low", "high"],
          defaultLevel: "high",
          privateToken: "private-thinking-value",
        },
        apiKey: "private-api-key",
        headers: { Authorization: "Bearer private-header" },
        baseUrl: "https://private-user:private-password@provider.example/v1",
        accountAccess: { "private-account-id": {} },
        credentials: { refreshToken: "private-refresh-token" },
      },
    ]);
    expect(JSON.stringify(models)).not.toContain("private-");
    expect(models[0]).toMatchObject({
      provider: "custom-provider",
      id: "reasoning-model",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 128_000,
      input: ["text", "image"],
      thinking: { efforts: ["low", "high"], defaultLevel: "high" },
    });
  });
});
