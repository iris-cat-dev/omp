import { describe, expect, it } from "vitest";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  groupOmpModelsByProviderNamespace,
  isModelBrowserRowSelected,
  resolveModelBrowserProviderId,
  resolveProviderSwitchModel,
  resolveModelBrowserProviderNamespaceId,
  resolveModelBrowserScrolling,
  resolveModelSheetOpening,
} from "./model-sheet-flow";

function providerFixture(id: string, label: string): ProviderSelectorProvider {
  return { id, label, modelSelection: { kind: "models", rows: [] } };
}

function runtimeProviderIds(providers: ProviderSelectorProvider[]): string[] {
  const ids: string[] = [];
  for (const entry of providers) {
    if (entry.modelSelection.kind !== "models") continue;
    for (const row of entry.modelSelection.rows) ids.push(row.provider);
  }
  return ids;
}

const omp = providerFixture("omp", "Oh My Pi");

describe("model sheet opening", () => {
  it("opens the sole OMP provider directly", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: true,
        providers: [omp],
        selectedProvider: "omp",
      }),
    ).toEqual({
      kind: "provider",
      providerId: "omp",
      providerLabel: "Oh My Pi",
    });
  });

  it("opens a running OMP agent directly at its fixed provider", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [omp],
        selectedProvider: "omp",
      }),
    ).toEqual({
      kind: "provider",
      providerId: "omp",
      providerLabel: "Oh My Pi",
    });
  });

  it("falls back to OMP while live state catches up", () => {
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: false,
        providers: [omp],
        selectedProvider: "",
      }),
    ).toEqual({
      kind: "provider",
      providerId: "omp",
      providerLabel: "Oh My Pi",
    });
  });
});

describe("OMP model provider grouping", () => {
  it("shows model namespaces as first-level providers while keeping OMP as the runtime", () => {
    const providers = groupOmpModelsByProviderNamespace([
      {
        id: "omp",
        label: "Oh My Pi",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "omp:cursor/gpt-5",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "cursor/gpt-5",
              modelLabel: "GPT-5",
            },
            {
              favoriteKey: "omp:openai/gpt-5.4",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "openai/gpt-5.4",
              modelLabel: "GPT-5.4",
            },
          ],
        },
      },
    ]);

    expect(providers.map((entry) => [entry.id, entry.label])).toEqual([
      ["omp:cursor", "Cursor"],
      ["omp:openai", "OpenAI"],
    ]);
    expect(runtimeProviderIds(providers)).toEqual(["omp", "omp"]);
  });

  it("shows a sole custom provider's explicit name without changing its runtime identity", () => {
    const providers = groupOmpModelsByProviderNamespace([
      {
        id: "omp",
        label: "OMP",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "omp:custom-123/gpt-5",
              provider: "omp",
              providerLabel: "OMP",
              providerName: "  中文-服务_API  ",
              modelId: "custom-123/gpt-5",
              modelLabel: "中文-服务_API/GPT-5",
            },
          ],
        },
      },
    ]);

    expect(providers[0]).toMatchObject({
      id: "omp",
      label: "中文-服务_API",
      modelSelection: {
        rows: [
          {
            favoriteKey: "omp:custom-123/gpt-5",
            provider: "omp",
            providerLabel: "中文-服务_API",
            modelId: "custom-123/gpt-5",
          },
        ],
      },
    });
    expect(
      resolveModelSheetOpening({
        canSwitchProvider: true,
        providers,
        selectedProvider: "omp",
      }),
    ).toEqual({
      kind: "provider",
      providerId: "omp",
      providerLabel: "中文-服务_API",
    });
    expect(resolveModelBrowserProviderId("omp", "custom-123/gpt-5", providers)).toBe("omp");
  });

  it("keeps distinct provider groups and selected references stable across a rename", () => {
    const catalogs = [];
    for (const providerName of ["同名服务商", "重命名服务商"]) {
      catalogs.push(
        groupOmpModelsByProviderNamespace([
          {
            id: "omp",
            label: "OMP",
            modelSelection: {
              kind: "models",
              rows: ["custom-a", "custom-b"].map((namespace) => ({
                favoriteKey: `omp:${namespace}/gpt-5`,
                provider: "omp",
                providerLabel: "OMP",
                providerName,
                modelId: `${namespace}/gpt-5`,
                modelLabel: `${providerName}/GPT-5`,
              })),
            },
          },
        ]),
      );
    }
    const before = catalogs[0]!;
    const after = catalogs[1]!;

    expect(before.map((provider) => provider.id)).toEqual(["omp:custom-a", "omp:custom-b"]);
    expect(after.map((provider) => provider.id)).toEqual(before.map((provider) => provider.id));
    expect(after.map((provider) => provider.label)).toEqual(["重命名服务商", "重命名服务商"]);
    expect(resolveModelBrowserProviderId("omp", "custom-a/gpt-5", after)).toBe("omp:custom-a");
    expect(resolveProviderSwitchModel(after[0]!, "custom-a/gpt-5")).toMatchObject({
      favoriteKey: "omp:custom-a/gpt-5",
      provider: "omp",
      providerLabel: "重命名服务商",
      modelId: "custom-a/gpt-5",
    });
    expect(
      isModelBrowserRowSelected("omp", "custom-a/gpt-5", "omp:custom-a", "custom-a/gpt-5"),
    ).toBe(true);
  });

  it("resolves the selected live OMP model to its grouped provider", () => {
    const providers = groupOmpModelsByProviderNamespace([
      {
        id: "omp",
        label: "Oh My Pi",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "omp:cursor/gpt-5",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "cursor/gpt-5",
              modelLabel: "GPT-5",
            },
            {
              favoriteKey: "omp:openai-codex/gpt-5.6-sol",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "openai-codex/gpt-5.6-sol",
              modelLabel: "GPT-5.6-Sol",
            },
          ],
        },
      },
    ]);

    expect(resolveModelBrowserProviderId("omp", "openai-codex/gpt-5.6-sol", providers)).toBe(
      "omp:openai-codex",
    );
  });
  it("resolves grouped OMP provider ids to their underlying namespace", () => {
    expect(resolveModelBrowserProviderNamespaceId("omp:cursor")).toBe("cursor");
    expect(resolveModelBrowserProviderNamespaceId("omp:openai-codex")).toBe("openai-codex");
    expect(resolveModelBrowserProviderNamespaceId("cursor")).toBe("cursor");
    expect(resolveModelBrowserProviderNamespaceId("omp", "mintcat/gpt-5")).toBe("mintcat");
  });

  it("marks a selected model inside its grouped virtual provider", () => {
    expect(
      isModelBrowserRowSelected(
        "omp",
        "openai-codex/gpt-5.6-sol",
        "omp:openai-codex",
        "openai-codex/gpt-5.6-sol",
      ),
    ).toBe(true);
    expect(
      isModelBrowserRowSelected(
        "omp",
        "openai-codex/gpt-5.4",
        "omp:openai-codex",
        "openai-codex/gpt-5.6-sol",
      ),
    ).toBe(false);
  });

  it("restores the last selected model when returning to a provider", () => {
    const [provider] = groupOmpModelsByProviderNamespace([
      {
        id: "omp",
        label: "Oh My Pi",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "omp:cursor/gpt-5",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "cursor/gpt-5",
              modelLabel: "GPT-5",
              isDefault: true,
            },
            {
              favoriteKey: "omp:cursor/claude-sonnet",
              provider: "omp",
              providerLabel: "Oh My Pi",
              modelId: "cursor/claude-sonnet",
              modelLabel: "Claude Sonnet",
            },
          ],
        },
      },
    ]);

    expect(resolveProviderSwitchModel(provider!, "cursor/claude-sonnet")?.modelId).toBe(
      "cursor/claude-sonnet",
    );
  });

  it("falls back to the provider default when the remembered model is unavailable", () => {
    const provider: ProviderSelectorProvider = {
      id: "codex",
      label: "Codex",
      modelSelection: {
        kind: "models",
        rows: [
          {
            favoriteKey: "codex:gpt-5.6",
            provider: "codex",
            providerLabel: "Codex",
            modelId: "gpt-5.6",
            modelLabel: "GPT-5.6",
            isDefault: true,
          },
        ],
      },
    };

    expect(resolveProviderSwitchModel(provider, "retired-model")?.modelId).toBe("gpt-5.6");
  });
});

describe("model sheet gesture ownership", () => {
  it("uses the sheet-aware model browser inside compact bottom sheets", () => {
    expect(resolveModelBrowserScrolling(true)).toBe("sheet");
  });

  it("keeps independent scrolling in the desktop split viewport", () => {
    expect(resolveModelBrowserScrolling(false)).toBe("independent");
  });
});
