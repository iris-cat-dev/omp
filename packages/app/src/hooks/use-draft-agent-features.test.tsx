// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentFeature,
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@omp-desktop/protocol/agent-types";
import {
  useDraftAgentFeatures,
  type UseDraftAgentFeaturesResult,
} from "./use-draft-agent-features";

const state = vi.hoisted(() => ({
  entries: [] as ProviderSnapshotEntry[],
  saved: {} as Record<string, unknown>,
  listProviderFeatures: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listProviderFeatures: state.listProviderFeatures }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("./use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: state.entries }),
}));
vi.mock("./use-form-preferences", () => ({
  useFormPreferences: () => ({
    preferences: { providerPreferences: { omp: { featureValues: state.saved } } },
    updatePreferences: vi.fn(),
  }),
  mergeProviderPreferences: vi.fn(),
}));

const legacy: AgentFeature = { id: "fast_mode", label: "Fast", type: "toggle", value: false };
const speed: AgentFeature = {
  id: "fast_mode",
  label: "Speed",
  type: "select",
  value: "off",
  options: ["off", "on", "ultrafast"].map((id) => ({ id, label: id })),
};
function catalogModel(id: string, features?: AgentFeature[]): AgentModelDefinition {
  return {
    provider: "omp",
    id,
    label: id,
    ...(features ? { metadata: { draftFeatures: features } } : {}),
  };
}
function setModels(models: AgentModelDefinition[]) {
  state.entries = [{ provider: "omp", status: "ready", enabled: true, models }];
}
let root: Root;
let queryClient: QueryClient;
let result: UseDraftAgentFeaturesResult;
function Probe(props: { modelId: string; initialFeatureValues?: Record<string, unknown> }) {
  result = useDraftAgentFeatures({
    serverId: "draft-host",
    provider: "omp",
    cwd: "/workspace",
    modeId: "full",
    modelId: props.modelId,
    thinkingOptionId: null,
    persistPreferences: false,
    initialFeatureValues: props.initialFeatureValues,
  });
  return null;
}
async function render(modelId: string, initialFeatureValues?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe modelId={modelId} initialFeatureValues={initialFeatureValues} />
      </QueryClientProvider>,
    );
  });
}
function selectedSpeed() {
  return result.features.find((feature) => feature.id === "fast_mode");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.saved = {};
  state.listProviderFeatures.mockReset();
  state.listProviderFeatures.mockResolvedValue({ features: [legacy] });
  state.entries = [];
  root = createRoot(document.createElement("div"));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("draft catalog speed controls", () => {
  it.each([
    [true, "on"],
    [false, "off"],
  ] as const)("normalizes saved legacy %s for the supported selector", async (saved, value) => {
    state.saved = { fast_mode: saved };
    setModels([catalogModel("supported", [speed])]);
    await render("supported");
    expect(selectedSpeed()).toMatchObject({ type: "select", value });
    expect(result.featureValues?.fast_mode).toBe(value);
    expect(state.listProviderFeatures).toHaveBeenCalledTimes(1);
  });

  it("keeps saved boolean Fast on a legacy two-state model", async () => {
    state.saved = { fast_mode: true };
    setModels([catalogModel("legacy", [legacy])]);
    await render("legacy");
    expect(selectedSpeed()).toMatchObject({ type: "toggle", value: true });
    expect(result.featureValues?.fast_mode).toBe(true);
    expect(state.listProviderFeatures).toHaveBeenCalledTimes(1);
  });

  it("offers and preserves Ultrafast when switching through unsupported and legacy models", async () => {
    setModels([
      catalogModel("supported", [speed]),
      catalogModel("unsupported", []),
      catalogModel("legacy", [legacy]),
    ]);
    await render("supported", { fast_mode: "ultrafast" });
    expect(selectedSpeed()).toMatchObject({ type: "select", value: "ultrafast" });
    await render("unsupported");
    expect(selectedSpeed()).toBeUndefined();
    expect(result.featureValues?.fast_mode).toBeUndefined();
    await render("legacy");
    expect(selectedSpeed()).toMatchObject({ type: "toggle", value: false });
    expect(result.featureValues?.fast_mode).toBeUndefined();
    await render("supported");
    expect(selectedSpeed()).toMatchObject({ type: "select", value: "ultrafast" });
    expect(result.featureValues?.fast_mode).toBe("ultrafast");
    expect(state.listProviderFeatures).toHaveBeenCalledTimes(3);
  });

  it("keeps other dynamic controls while catalog speed overrides stored metadata", async () => {
    const account: AgentFeature = {
      id: "oauth_account_credential",
      label: "Account",
      type: "select",
      value: "automatic",
      options: [
        { id: "automatic", label: "Automatic" },
        { id: "41", label: "Account 41" },
      ],
    };
    queryClient.setQueryData(
      ["providerFeatures", "draft-host", "omp", "/workspace", "full", "supported", null],
      [legacy, account],
    );
    setModels([catalogModel("supported", [speed])]);
    await render("supported");
    expect(selectedSpeed()).toMatchObject({ type: "select", value: "off" });
    expect(result.features.find((feature) => feature.id === account.id)).toEqual(account);
  });

  it("replaces an old cached toggle on catalog refresh and removes it for unsupported models", async () => {
    const queryKey = ["providerFeatures", "draft-host", "omp", "/workspace", "full", "same", null];
    queryClient.setQueryData(queryKey, [legacy]);
    setModels([catalogModel("same")]);
    await render("same");
    expect(selectedSpeed()).toMatchObject({ type: "toggle", value: false });
    setModels([catalogModel("same", [speed])]);
    await render("same");
    expect(selectedSpeed()).toMatchObject({ type: "select", value: "off" });
    setModels([catalogModel("same", [])]);
    await render("same");
    expect(selectedSpeed()).toBeUndefined();
    expect(result.metadataError).toBeUndefined();
  });
});
