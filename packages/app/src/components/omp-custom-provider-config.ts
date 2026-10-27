import type { OmpCustomProviderInput, OmpProviderApi } from "@omp-desktop/protocol/messages";
import { isMap, isSeq, parse, parseDocument } from "yaml";

export const OMP_PROVIDER_APIS = [
  "openai-responses",
  "openai-completions",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
] as const satisfies readonly OmpProviderApi[];

export interface OmpProviderModelDraft {
  key: string;
  id: string;
  name: string;
  api: OmpProviderApi;
  contextWindow: string;
  maxTokens: string;
  supportsImages: boolean;
  reasoning?: boolean;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: string[];
}

export interface OmpProviderDraft {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: OmpProviderModelDraft[];
}

export function createEmptyProviderDraft(
  modelKey: string,
  providerId = `custom-${crypto.randomUUID()}`,
): OmpProviderDraft {
  return {
    providerId,
    name: "",
    baseUrl: "",
    apiKey: "",
    models: [
      {
        key: modelKey,
        id: "",
        name: "",
        api: "openai-responses",
        contextWindow: "",
        maxTokens: "",
        supportsImages: false,
      },
    ],
  };
}
export function configureDiscoveredProviderModels(
  current: OmpProviderModelDraft[],
  discovered: ReadonlyArray<{
    id: string;
    name: string;
    supportedApis?: readonly OmpProviderApi[];
    inputModalities?: readonly string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    defaultReasoningLevel?: string;
    supportedReasoningLevels?: readonly string[];
  }>,
  createKey: () => string,
): OmpProviderModelDraft[] {
  const currentById = new Map(
    current.filter((model) => model.id.trim()).map((model) => [model.id.trim(), model]),
  );
  return discovered.map((model) => {
    const existing = currentById.get(model.id);
    if (existing) {
      return {
        ...existing,
        name: existing.name.trim() || model.name,
        api:
          !model.supportedApis?.length || model.supportedApis.includes(existing.api)
            ? existing.api
            : resolveDiscoveredModelApi(model.id, existing.api, model.supportedApis),
        contextWindow:
          existing.contextWindow.trim() ||
          (model.contextWindow !== undefined ? String(model.contextWindow) : ""),
        maxTokens:
          existing.maxTokens.trim() ||
          (model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : ""),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.defaultReasoningLevel
          ? { defaultReasoningLevel: model.defaultReasoningLevel }
          : {}),
        ...(model.supportedReasoningLevels
          ? { supportedReasoningLevels: [...model.supportedReasoningLevels] }
          : {}),
      };
    }
    return {
      key: createKey(),
      id: model.id,
      name: model.name,
      api: resolveDiscoveredModelApi(model.id, "openai-responses", model.supportedApis),
      contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : "",
      maxTokens: model.maxOutputTokens !== undefined ? String(model.maxOutputTokens) : "",
      supportsImages: model.inputModalities ? model.inputModalities.includes("image") : true,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.defaultReasoningLevel
        ? { defaultReasoningLevel: model.defaultReasoningLevel }
        : {}),
      ...(model.supportedReasoningLevels
        ? { supportedReasoningLevels: [...model.supportedReasoningLevels] }
        : {}),
    };
  });
}

function preferredApiForModel(modelId: string): OmpProviderApi | null {
  if (/\bclaude\b/i.test(modelId)) return "anthropic-messages";
  if (/\bgemini\b/i.test(modelId)) return "google-generative-ai";
  return null;
}

export function resolveDiscoveredModelApi(
  modelId: string,
  current: OmpProviderApi,
  supportedApis?: readonly OmpProviderApi[],
): OmpProviderApi {
  const preferred = preferredApiForModel(modelId);
  if (preferred && (!supportedApis?.length || supportedApis.includes(preferred))) {
    return preferred;
  }
  if (!supportedApis?.length || supportedApis.includes(current)) {
    return current;
  }
  return OMP_PROVIDER_APIS.find((api) => supportedApis.includes(api)) ?? current;
}

export function parseCustomProviderDraft(
  configYaml: string,
  providerId: string,
): OmpProviderDraft | null {
  try {
    const root = parse(configYaml) as {
      providers?: Record<
        string,
        {
          name?: unknown;
          baseUrl?: unknown;
          apiKey?: unknown;
          api?: unknown;
          models?: Array<{
            id?: unknown;
            name?: unknown;
            api?: unknown;
            contextWindow?: unknown;
            maxTokens?: unknown;
            input?: unknown;
            reasoning?: unknown;
            thinking?: {
              efforts?: unknown;
              defaultLevel?: unknown;
            };
          }>;
        }
      >;
    };
    const provider = root.providers?.[providerId];
    if (!provider) return null;
    const api = OMP_PROVIDER_APIS.includes(provider.api as OmpProviderApi)
      ? (provider.api as OmpProviderApi)
      : "openai-responses";
    const models = (provider.models ?? []).flatMap((model, index) =>
      typeof model.id === "string"
        ? [
            {
              key: `model-${index}`,
              id: model.id,
              name: typeof model.name === "string" ? model.name : "",
              api: OMP_PROVIDER_APIS.includes(model.api as OmpProviderApi)
                ? (model.api as OmpProviderApi)
                : api,
              contextWindow:
                typeof model.contextWindow === "number" ? String(model.contextWindow) : "",
              maxTokens: typeof model.maxTokens === "number" ? String(model.maxTokens) : "",
              supportsImages: Array.isArray(model.input) && model.input.includes("image"),
              reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
              defaultReasoningLevel:
                typeof model.thinking?.defaultLevel === "string"
                  ? model.thinking.defaultLevel
                  : undefined,
              supportedReasoningLevels: Array.isArray(model.thinking?.efforts)
                ? model.thinking.efforts.filter(
                    (level): level is string => typeof level === "string" && level.length > 0,
                  )
                : undefined,
            },
          ]
        : [],
    );
    return {
      providerId,
      name:
        typeof provider.name === "string" && provider.name.trim()
          ? provider.name.trim()
          : providerId,
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
      models: models.length > 0 ? models : createEmptyProviderDraft("model-0", providerId).models,
    };
  } catch {
    return null;
  }
}

function providerInputToYamlValue(provider: OmpCustomProviderInput) {
  return {
    ...(provider.name?.trim() ? { name: provider.name.trim() } : {}),
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    api: provider.models[0]?.api ?? "openai-responses",
    auth: "apiKey",
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      api: model.api ?? provider.api,
      input: model.supportsImages ? ["text", "image"] : ["text"],
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.reasoning && (model.supportedReasoningLevels?.length || model.defaultReasoningLevel)
        ? {
            thinking: {
              mode: "effort",
              ...(model.supportedReasoningLevels?.length
                ? { efforts: model.supportedReasoningLevels }
                : {}),
              ...(model.defaultReasoningLevel ? { defaultLevel: model.defaultReasoningLevel } : {}),
            },
          }
        : {}),
    })),
  };
}

export function updateCustomProviderConfigYaml(
  configYaml: string,
  providerId: string,
  provider: OmpCustomProviderInput,
): string {
  const document = parseDocument(configYaml);
  const value = providerInputToYamlValue(provider);
  const providerPath = ["providers", providerId];
  for (const [key, field] of Object.entries(value)) {
    if (key !== "models") document.setIn([...providerPath, key], field);
  }
  const currentModels = document.getIn([...providerPath, "models"], true);
  const modelsById = new Map(
    isSeq(currentModels)
      ? currentModels.items.filter(isMap).map((model) => [model.get("id"), model])
      : [],
  );
  const models = document.createNode<unknown[]>([]);
  for (const model of value.models) {
    const node = modelsById.get(model.id);
    if (!node) {
      models.items.push(document.createNode(model));
      continue;
    }
    for (const key of ["contextWindow", "maxTokens", "reasoning", "thinking"]) {
      if (!Object.hasOwn(model, key)) node.delete(key);
    }
    for (const [key, field] of Object.entries(model)) node.set(key, field);
    models.items.push(node);
  }
  document.setIn([...providerPath, "models"], models);
  return document.toString();
}
