import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import {
  groupOmpDiscoveredModels,
  resolveProviderDiscoveredModels,
  type ProviderDiscoveredModelsCache,
} from "./provider-diagnostic-models";

const piModel: AgentModelDefinition = {
  provider: "pi",
  id: "pi/model",
  label: "Pi Model",
};

const grokModel: AgentModelDefinition = {
  provider: "grok",
  id: "grok-build",
  label: "Grok Build",
};

function resolveModels(input: {
  serverId?: string;
  provider: string;
  currentModels?: AgentModelDefinition[];
  loading?: boolean;
  cache?: ProviderDiscoveredModelsCache | null;
}) {
  return resolveProviderDiscoveredModels({
    serverId: input.serverId ?? "local",
    provider: input.provider,
    currentModels: input.currentModels,
    providerSnapshotRefreshing: input.loading === true,
    previousCache: input.cache ?? null,
  });
}

describe("resolveProviderDiscoveredModels", () => {
  it("keeps a provider's cached discovered models visible while that provider refreshes", () => {
    const ready = resolveModels({ provider: "grok", currentModels: [grokModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([grokModel]);
  });

  it("excludes compatibility-only models from display and cache", () => {
    const compatibilityModel: AgentModelDefinition = {
      ...piModel,
      id: "pi/model-legacy",
      label: "Pi Model legacy",
      isSelectable: false,
    };

    const result = resolveModels({
      provider: "pi",
      currentModels: [piModel, compatibilityModel],
    });

    expect(result.models).toEqual([piModel]);
    expect(result.cache?.models).toEqual([piModel]);
  });

  it("does not show one provider's cached models while another provider loads", () => {
    const ready = resolveModels({ provider: "pi", currentModels: [piModel] });

    const refreshing = resolveModels({ provider: "grok", loading: true, cache: ready.cache });

    expect(refreshing.models).toEqual([]);
  });

  it("does not show another server's cached models while the same provider loads", () => {
    const ready = resolveModels({
      serverId: "server-a",
      provider: "grok",
      currentModels: [grokModel],
    });

    const refreshing = resolveModels({
      serverId: "server-b",
      provider: "grok",
      loading: true,
      cache: ready.cache,
    });

    expect(refreshing.models).toEqual([]);
  });
});

describe("groupOmpDiscoveredModels", () => {
  it("groups OMP models by their native provider and sorts provider groups", () => {
    const cursorModel: AgentModelDefinition = {
      provider: "omp",
      id: "omp-wrapped-id",
      label: "cursor/Claude Sonnet",
      metadata: { provider: "cursor", modelId: "claude-sonnet" },
    };
    const codexModel: AgentModelDefinition = {
      provider: "omp",
      id: "openai-codex/gpt-5.4",
      label: "openai-codex/GPT-5.4",
    };

    expect(groupOmpDiscoveredModels([codexModel, cursorModel])).toEqual([
      { id: "cursor", label: "Cursor", models: [cursorModel] },
      { id: "openai-codex", label: "OpenAI Codex", models: [codexModel] },
    ]);
  });

  it("refreshes exact Unicode names while preserving provider and model identities", () => {
    const model: AgentModelDefinition = {
      provider: "omp",
      id: "custom-123/gpt-5",
      label: "私有-服务_API/GPT-5",
      metadata: { provider: "custom-123", providerName: "  私有-服务_API  " },
    };
    const ready = resolveModels({ provider: "omp", currentModels: [model] });
    const renamedModel: AgentModelDefinition = {
      ...model,
      label: "新的服务商/GPT-5",
      metadata: { ...model.metadata, providerName: "  新的服务商  " },
    };
    const refreshed = resolveModels({
      provider: "omp",
      currentModels: [renamedModel],
      cache: ready.cache,
    });

    expect(groupOmpDiscoveredModels(ready.models)).toEqual([
      { id: "custom-123", label: "私有-服务_API", models: [model] },
    ]);
    expect(groupOmpDiscoveredModels(refreshed.models)).toEqual([
      { id: "custom-123", label: "新的服务商", models: [renamedModel] },
    ]);
    expect(refreshed.models[0]?.id).toBe(model.id);
    expect(refreshed.cache?.models).toEqual([renamedModel]);
  });

  it.each([undefined, "", " \t "])(
    "keeps namespace formatting for a missing or blank provider name (%j)",
    (providerName) => {
      const model: AgentModelDefinition = {
        provider: "omp",
        id: "custom-123/gpt-5",
        label: "不是供应商名称/GPT-5",
        metadata: { provider: "custom-123", providerName },
      };

      expect(groupOmpDiscoveredModels([model])).toEqual([
        { id: "custom-123", label: "Custom 123", models: [model] },
      ]);
    },
  );
});
