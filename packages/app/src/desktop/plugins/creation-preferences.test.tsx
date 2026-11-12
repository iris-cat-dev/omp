// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { mergeProviderPreferences } from "@/create-agent-preferences/preferences";
import type { ProviderSnapshotEntry } from "@omp-desktop/protocol/agent-types";
import { useAgentFormState } from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";

const state = vi.hoisted(() => ({ preferences: {} as FormPreferences }));
vi.mock("@/hooks/use-form-preferences", () => {
  return {
    mergeProviderPreferences: (input: Parameters<typeof mergeProviderPreferences>[0]) =>
      mergeProviderPreferences(input),
    useFormPreferences: () => ({
      preferences: state.preferences,
      isLoading: false,
      updatePreferences: async (
        update: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
      ) => {
        state.preferences =
          typeof update === "function"
            ? update(state.preferences)
            : { ...state.preferences, ...update };
        return state.preferences;
      },
    }),
  };
});
const hosts = [{ serverId: "pet-host" }];
const client = {
  listProviderFeatures: async () => ({
    features: [{ type: "toggle", id: "fast", label: "Fast", value: false }],
  }),
};
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => hosts,
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));
const entries: ProviderSnapshotEntry[] = [
  {
    provider: "omp",
    status: "ready",
    enabled: true,
    modes: [
      { id: "auto", label: "Auto" },
      { id: "full", label: "Full" },
    ],
    defaultModeId: "auto",
    models: ["normal", "author"].map((id) => ({
      provider: "omp",
      id,
      label: id,
      isDefault: id === "normal",
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "low",
    })),
  },
];
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries,
    isLoading: false,
    isRefreshing: false,
    error: null,
    refresh: () => undefined,
    refetchIfStale: () => undefined,
  }),
}));
let root: Root;
let query: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.preferences = {
    provider: "omp",
    providerPreferences: {
      omp: {
        model: "normal",
        mode: "auto",
        thinkingByModel: { normal: "low" },
        featureValues: { fast: false },
      },
    },
  };
  root = createRoot(document.createElement("div"));
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  query.clear();
  vi.unstubAllGlobals();
});

describe("pet authoring preference isolation", () => {
  it("keeps author model, mode, and thinking selections local while preserving normal chat defaults", async () => {
    let form: ReturnType<typeof useAgentFormState> | undefined;
    function Probe() {
      form = useAgentFormState({
        initialServerId: "pet-host",
        initialValues: { provider: "omp" },
        persistPreferences: false,
      });
      return null;
    }
    const before = structuredClone(state.preferences);
    await act(async () => root.render(<Probe />));
    expect(form?.selectedModel).toBe("normal");
    await act(async () => {
      form!.setProviderAndModelFromUser("omp", "author");
    });
    await act(async () => {
      form!.setModeFromUser("full");
      form!.setThinkingOptionFromUser("high");
    });
    expect([form?.selectedModel, form?.selectedMode, form?.selectedThinkingOptionId]).toEqual([
      "author",
      "full",
      "high",
    ]);
    await act(async () => form!.persistFormPreferences());
    expect(state.preferences).toEqual(before);
  });

  it.each([false, true])(
    "applies feature selection locally with persistence=%s",
    async (persistPreferences) => {
      let features: ReturnType<typeof useDraftAgentFeatures> | undefined;
      function Probe() {
        features = useDraftAgentFeatures({
          serverId: "pet-host",
          provider: "omp",
          cwd: "/pet-author",
          modeId: "auto",
          modelId: "normal",
          thinkingOptionId: "low",
          persistPreferences,
        });
        return null;
      }
      await act(async () =>
        root.render(
          <QueryClientProvider client={query}>
            <Probe />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() => expect(features?.features[0]?.id).toBe("fast"));
      await act(async () => features!.setFeatureValue("fast", true));
      expect(features?.featureValues?.fast).toBe(true);
      expect(state.preferences.providerPreferences?.omp.featureValues?.fast).toBe(
        persistPreferences,
      );
    },
  );
});
