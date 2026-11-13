import { parse, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import {
  OmpCustomProviderInputSchema,
  OmpProviderModelDiscoveryResponseMessageSchema,
} from "@omp-desktop/protocol/messages";
import {
  configureDiscoveredProviderModels,
  customProviderDraftToInput,
  parseCustomProviderDraft,
  updateCustomProviderConfigYaml,
  resolveDiscoveredModelApi,
} from "./omp-custom-provider-config";

const configYaml = `# Keep this comment
providers:
  mintcat:
    baseUrl: https://old.example.com/v1
    apiKey: old-key
    api: openai-responses
    auth: apiKey
    models:
      - id: gpt-old
        name: GPT Old
        api: openai-responses
        input: [text, image]
        contextWindow: 128000
        maxTokens: 8192
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]
          defaultLevel: medium
  untouched:
    baseUrl: https://untouched.example.com/v1
    apiKey: untouched-key
    api: openai-responses
    models: []
`;

describe("OMP custom provider editing", () => {
  it("prefills provider and model fields from models.yml", () => {
    expect(parseCustomProviderDraft(configYaml, "mintcat")).toEqual({
      providerId: "mintcat",
      name: "mintcat",
      baseUrl: "https://old.example.com/v1",
      apiKey: "old-key",
      models: [
        {
          key: "model-0",
          id: "gpt-old",
          name: "GPT Old",
          api: "openai-responses",
          contextWindow: "128000",
          maxTokens: "8192",
          supportsImages: true,
          reasoning: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium", "high"],
        },
      ],
    });
  });

  it("renames a provider without changing its ID, connection, or model configuration", () => {
    const document = parseDocument(configYaml);
    document.setIn(["providers", "mintcat", "name"], "薄荷猫");
    document.setIn(["providers", "mintcat", "headers"], { "X-Team": "engineering" });
    document.setIn(["providers", "mintcat", "models", 0, "cost"], { input: 1, output: 2 });
    const original = document.toJS();
    const renamed = updateCustomProviderConfigYaml(document.toString(), "mintcat", {
      providerId: "mintcat",
      name: "  薄荷猫 · 工作  ",
      baseUrl: "https://old.example.com/v1",
      apiKey: "old-key",
      api: "openai-responses",
      models: [
        {
          id: "gpt-old",
          name: "GPT Old",
          api: "openai-responses",
          supportsImages: true,
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium", "high"],
        },
      ],
    });

    expect(parse(renamed)).toEqual({
      ...original,
      providers: {
        ...original.providers,
        mintcat: { ...original.providers.mintcat, name: "薄荷猫 · 工作" },
      },
    });
    expect(parseCustomProviderDraft(renamed, "mintcat")?.name).toBe("薄荷猫 · 工作");
  });

  it("updates only the selected provider and preserves comments and siblings", () => {
    const updated = updateCustomProviderConfigYaml(configYaml, "mintcat", {
      providerId: "mintcat",
      baseUrl: "https://new.example.com/v1",
      apiKey: "new-key",
      api: "anthropic-messages",
      models: [
        {
          id: "claude-new",
          name: "Claude New",
          api: "anthropic-messages",
          contextWindow: 200000,
        },
      ],
    });
    const parsed = parse(updated) as {
      providers: Record<string, { baseUrl: string; apiKey: string; models: Array<{ id: string }> }>;
    };

    expect(updated).toContain("# Keep this comment");
    expect(parsed.providers.mintcat).toMatchObject({
      baseUrl: "https://new.example.com/v1",
      apiKey: "new-key",
      models: [{ id: "claude-new" }],
    });
    expect(parsed.providers.untouched).toMatchObject({
      baseUrl: "https://untouched.example.com/v1",
      apiKey: "untouched-key",
    });
  });

  it("serializes text and image input capabilities", () => {
    const updated = updateCustomProviderConfigYaml(configYaml, "mintcat", {
      providerId: "mintcat",
      baseUrl: "https://new.example.com/v1",
      apiKey: "new-key",
      api: "openai-responses",
      models: [
        {
          id: "gpt-multimodal",
          api: "openai-responses",
          supportsImages: true,
          reasoning: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium", "high"],
        },
        { id: "gpt-text-only", api: "anthropic-messages" },
      ],
    });
    const parsed = parse(updated) as {
      providers: Record<string, { models: Array<{ id: string; input: string[] }> }>;
    };

    expect(parsed.providers.mintcat?.models).toEqual([
      {
        id: "gpt-multimodal",
        name: "gpt-multimodal",
        api: "openai-responses",
        input: ["text", "image"],
        reasoning: true,
        thinking: {
          mode: "effort",
          efforts: ["low", "medium", "high"],
          defaultLevel: "medium",
        },
      },
      {
        id: "gpt-text-only",
        name: "gpt-text-only",
        api: "anthropic-messages",
        input: ["text"],
      },
    ]);
  });

  it("replaces the draft list with discovered models while preserving matching metadata", () => {
    let nextKey = 2;
    const configured = configureDiscoveredProviderModels(
      [
        {
          key: "model-0",
          id: "gpt-existing",
          name: "",
          api: "openai-responses",
          contextWindow: "128000",
          maxTokens: "8192",
          supportsImages: true,
        },
        {
          key: "model-1",
          id: "gpt-text-only",
          name: "Text Only",
          api: "anthropic-messages",
          contextWindow: "",
          maxTokens: "",
          supportsImages: false,
        },
      ],
      [
        { id: "gpt-existing", name: "GPT Existing" },
        { id: "gpt-text-only", name: "GPT Text Only" },
        { id: "gpt-new", name: "GPT New" },
      ],
      () => `model-${nextKey++}`,
    );

    expect(configured).toEqual([
      {
        key: "model-0",
        id: "gpt-existing",
        name: "GPT Existing",
        api: "openai-responses",
        contextWindow: "128000",
        maxTokens: "8192",
        supportsImages: true,
      },
      {
        key: "model-1",
        id: "gpt-text-only",
        name: "Text Only",
        api: "anthropic-messages",
        contextWindow: "",
        maxTokens: "",
        supportsImages: false,
      },
      {
        key: "model-2",
        id: "gpt-new",
        name: "GPT New",
        api: "openai-responses",
        contextWindow: "",
        maxTokens: "",
        supportsImages: true,
      },
    ]);
  });

  it("applies discovered capabilities and resolves an API per model", () => {
    const configured = configureDiscoveredProviderModels(
      [],
      [
        {
          id: "vision-model",
          name: "Vision Model",
          supportedApis: ["anthropic-messages", "openai-responses"],
          inputModalities: ["text", "image"],
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          reasoning: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium", "high"],
        },
        {
          id: "text-model",
          name: "Text Model",
          supportedApis: ["anthropic-messages"],
          inputModalities: ["text"],
          contextWindow: 64_000,
          maxOutputTokens: 8_192,
        },
      ],
      () => "model-new",
    );

    expect(configured).toEqual([
      {
        key: "model-new",
        id: "vision-model",
        name: "Vision Model",
        api: "openai-responses",
        contextWindow: "200000",
        maxTokens: "32000",
        supportsImages: true,
        reasoning: true,
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
      {
        key: "model-new",
        id: "text-model",
        name: "Text Model",
        api: "anthropic-messages",
        contextWindow: "64000",
        maxTokens: "8192",
        supportsImages: false,
      },
    ]);
    expect(
      resolveDiscoveredModelApi("generic-model", "openai-completions", [
        "anthropic-messages",
        "openai-responses",
      ]),
    ).toBe("openai-responses");
  });

  it.each([
    { tiers: undefined, expected: ["ultrafast"] },
    { tiers: [], expected: [] },
    { tiers: ["priority"], expected: ["priority"] },
    { tiers: ["priority", "ultrafast"], expected: ["priority", "ultrafast"] },
  ])("saves and reloads refreshed tier declarations: $tiers", ({ tiers, expected }) => {
    const document = parseDocument(configYaml);
    document.setIn(["providers", "mintcat", "models", 0, "serviceTiers"], ["ultrafast"]);
    const originalYaml = document.toString();
    const draft = parseCustomProviderDraft(originalYaml, "mintcat")!;
    const discovery = OmpProviderModelDiscoveryResponseMessageSchema.parse({
      type: "omp.provider.models.discover.response",
      payload: {
        requestId: "discover-tiers",
        models: [
          {
            id: "gpt-old",
            name: "GPT Old",
            ...(tiers !== undefined ? { serviceTiers: tiers } : {}),
          },
          { id: "gpt-new", name: "GPT New" },
          { id: "new-advertised", name: "New Advertised", serviceTiers: ["ultrafast"] },
        ],
      },
    });
    const models = configureDiscoveredProviderModels(
      draft.models,
      discovery.payload.models,
      () => "model-new",
    );
    const input = OmpCustomProviderInputSchema.parse(
      customProviderDraftToInput({ ...draft, models }, (value) => Number(value)),
    );
    const saved = updateCustomProviderConfigYaml(originalYaml, "mintcat", input);
    const reloaded = parseCustomProviderDraft(saved, "mintcat")!;

    expect(reloaded.models[0]?.serviceTiers).toEqual(expected);
    expect(reloaded.models[1]).not.toHaveProperty("serviceTiers");
    expect(reloaded.models[2]?.serviceTiers).toEqual(["ultrafast"]);
    expect(parse(saved).providers.mintcat.models[0].serviceTiers).toEqual(expected);
    expect(reloaded.models[0]?.supportedReasoningLevels).toEqual(["low", "medium", "high"]);
    expect(reloaded.models[0]?.contextWindow).toBe("128000");
  });

  it("retains tier declarations while editing without discovery", () => {
    const document = parseDocument(configYaml);
    document.setIn(["providers", "mintcat", "models", 0, "serviceTiers"], []);
    const draft = parseCustomProviderDraft(document.toString(), "mintcat")!;
    draft.models[0]!.name = "Renamed";
    const input = customProviderDraftToInput(draft, (value) => Number(value));
    const saved = updateCustomProviderConfigYaml(document.toString(), "mintcat", input);

    expect(parseCustomProviderDraft(saved, "mintcat")?.models[0]).toMatchObject({
      name: "Renamed",
      serviceTiers: [],
    });
  });

  it("prefers native API formats for recognized model families", () => {
    const configured = configureDiscoveredProviderModels(
      [],
      [
        { id: "claude-fable-5", name: "Claude Fable 5" },
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
          supportedApis: ["openai-responses", "openai-completions", "anthropic-messages"],
        },
        {
          id: "gemini-3-pro",
          name: "Gemini 3 Pro",
          supportedApis: ["openai-responses", "google-generative-ai"],
        },
      ],
      (() => {
        let key = 0;
        return () => `model-${key++}`;
      })(),
    );

    expect(configured.map((model) => model.api)).toEqual([
      "anthropic-messages",
      "anthropic-messages",
      "google-generative-ai",
    ]);
  });
});
