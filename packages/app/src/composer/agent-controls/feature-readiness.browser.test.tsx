import React, { act, createElement } from "react";
import { View as NativeView } from "react-native";
import type * as Reanimated from "react-native-reanimated";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFeature } from "@omp-desktop/protocol/agent-types";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { mergeProviderPreferences } from "@/create-agent-preferences/preferences";
import {
  useDraftAgentFeatures,
  type DraftAgentFeaturesResult,
} from "@/hooks/use-draft-agent-features";
import { en } from "@/i18n/resources/en";
import { ModelSettingsPanel } from "./model-settings-panel";
import { partitionModelFeatures } from "./utils";

vi.mock("expo-clipboard", () => ({}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [] }),
}));
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof Reanimated>();
  return {
    ...actual,
    default: {
      ...actual.default,
      View: (props: React.ComponentProps<typeof NativeView>) => createElement(NativeView, props),
    },
    Easing: { ease: "ease", inOut: (value: unknown) => value },
    interpolateColor: (value: number, _input: number[], output: string[]) =>
      value >= 1 ? output[1] : output[0],
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
    withTiming: (value: unknown) => value,
  };
});
interface FeaturePayload {
  features: AgentFeature[];
  error?: string;
}
interface PendingRequest {
  model: string | undefined;
  account: unknown;
  resolve: (payload: FeaturePayload) => void;
}
const runtime = vi.hoisted(() => ({
  connected: true,
  requests: [] as PendingRequest[],
  preferences: {} as FormPreferences,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => runtime.connected,
  useHostRuntimeClient: () => ({
    listProviderFeatures: (config: { model?: string; featureValues?: Record<string, unknown> }) => {
      const pending = Promise.withResolvers<FeaturePayload>();
      runtime.requests.push({
        model: config.model,
        account: config.featureValues?.oauth_account_credential,
        resolve: pending.resolve,
      });
      return pending.promise;
    },
  }),
}));
vi.mock("@/hooks/use-form-preferences", () => ({
  mergeProviderPreferences: (input: Parameters<typeof mergeProviderPreferences>[0]) =>
    mergeProviderPreferences(input),
  useFormPreferences: () => ({
    preferences: runtime.preferences,
    updatePreferences: async (update: (current: FormPreferences) => FormPreferences) => {
      runtime.preferences = update(runtime.preferences);
      return runtime.preferences;
    },
  }),
}));
const tierFeature: Extract<AgentFeature, { type: "select" }> = {
  id: "fast_mode",
  label: "Speed",
  type: "select",
  value: "off",
  options: [
    { id: "off", label: "Standard" },
    { id: "on", label: "Fast" },
    { id: "ultrafast", label: "Ultrafast" },
  ],
};
const liveTierFeature: Extract<AgentFeature, { type: "select" }> = { ...tierFeature, value: "on" };
const accountFeature: AgentFeature = {
  id: "oauth_account_credential",
  label: "Account",
  type: "select",
  value: "automatic",
  options: [
    { id: "automatic", label: "Automatic" },
    { id: "41", label: "One" },
    { id: "42", label: "Two" },
  ],
};
let query: QueryClient;
let i18n: I18n;
let draft: DraftAgentFeaturesResult;

function DraftConsumer({ model }: { model: string }) {
  draft = useDraftAgentFeatures({
    serverId: "isolated-host",
    provider: "omp",
    cwd: "/isolated",
    modeId: "ask",
    modelId: model,
    thinkingOptionId: "high",
    persistPreferences: false,
  });
  return (
    <>
      <output data-testid="saved-speed">{String(draft.featureValues?.fast_mode)}</output>
      <ModelSettingsPanel
        thinkingOptions={[]}
        fastMode={partitionModelFeatures(draft.features).fastMode}
        featureMetadataStatus={draft.metadataStatus}
        onSetFeature={draft.setFeatureValue}
      />
    </>
  );
}
function Page({ model, live }: { model: string; live?: boolean }) {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={query}>
        {live ? (
          <ModelSettingsPanel
            thinkingOptions={[]}
            fastMode={liveTierFeature}
            featureMetadataStatus="ready"
          />
        ) : (
          <DraftConsumer model={model} />
        )}
      </QueryClientProvider>
    </I18nextProvider>
  );
}
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runtime.connected = true;
  runtime.requests = [];
  runtime.preferences = {
    providerPreferences: { omp: { featureValues: { fast_mode: "ultrafast" } } },
  };
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  query.clear();
  vi.unstubAllGlobals();
});

describe("production draft Speed readiness", () => {
  it("hides failed speed detection and restores the saved tier after a model change", async () => {
    const view = render(<Page model="openai-codex/sol" />);
    act(() => draft.setFeatureValue("fast_mode", "on"));
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    act(() =>
      runtime.requests[0]!.resolve({
        features: [],
        error: "Native capability endpoint unavailable",
      }),
    );
    await waitFor(() => expect(draft.metadataStatus).toBe("error"));
    expect(screen.queryByTestId("model-settings-panel")).toBeNull();
    expect(screen.queryByText("Native capability endpoint unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry speed detection" })).toBeNull();
    act(() => draft.setFeatureValue("fast_mode", "on"));
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
    view.rerender(<Page model="openai-codex/next" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(2));
    act(() => runtime.requests[1]!.resolve({ features: [tierFeature] }));
    const selector = await screen.findByTestId("model-settings-fast-mode");
    expect(selector.textContent).toContain("Ultrafast");
    fireEvent.click(selector);
    fireEvent.click(await screen.findByText("Standard"));
    await waitFor(() => expect(screen.getByTestId("saved-speed").textContent).toBe("off"));
  });

  it("renders confirmed unsupported without discarding a saved Ultrafast preference", async () => {
    render(<Page model="openai-codex/older" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    act(() => runtime.requests[0]!.resolve({ features: [] }));
    await screen.findByTestId("model-settings-fast-mode-unsupported");
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
  });

  it("does not present saved Ultrafast as a legacy Fast toggle after confirmation", async () => {
    render(<Page model="openai-codex/legacy-runtime" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    act(() =>
      runtime.requests[0]!.resolve({
        features: [{ id: "fast_mode", label: "Fast", type: "toggle", value: false }],
      }),
    );
    await screen.findByTestId("model-settings-fast-mode-unsupported");
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
  });

  it("reconfirms after a host catalog/configuration generation changes", async () => {
    render(<Page model="openai-codex/sol" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    act(() => runtime.requests[0]!.resolve({ features: [tierFeature] }));
    await screen.findByTestId("model-settings-fast-mode");
    act(() =>
      query.setQueryData(["providersSnapshot", "isolated-host"], {
        snapshotHash: "changed-host-config",
      }),
    );
    await waitFor(() => expect(runtime.requests).toHaveLength(2));
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
    act(() => runtime.requests[1]!.resolve({ features: [] }));
    await screen.findByTestId("model-settings-fast-mode-unsupported");
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
  });

  it("does not accept late responses from the previous model or overwrite live session features", async () => {
    const view = render(<Page model="openai-codex/old" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    view.rerender(<Page model="openai-codex/new" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(2));
    act(() => runtime.requests[0]!.resolve({ features: [tierFeature] }));
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
    view.rerender(<Page model="openai-codex/new" live />);
    act(() => runtime.requests[1]!.resolve({ features: [] }));
    await waitFor(() =>
      expect(screen.getByTestId("model-settings-fast-mode").textContent).toContain("Fast"),
    );
    expect(screen.queryByTestId("model-settings-fast-mode-unsupported")).toBeNull();
  });

  it("reconfirms account changes and blocks stale cached speed while rechecking or failed", async () => {
    render(<Page model="openai-codex/sol" />);
    await waitFor(() => expect(runtime.requests).toHaveLength(1));
    act(() => runtime.requests[0]!.resolve({ features: [tierFeature, accountFeature] }));
    await screen.findByTestId("model-settings-fast-mode");
    act(() => draft.setFeatureValue("oauth_account_credential", "42"));
    await waitFor(() => expect(runtime.requests).toHaveLength(2));
    expect(runtime.requests[1]!.account).toBe("42");
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
    act(() => runtime.requests[1]!.resolve({ features: [tierFeature, accountFeature] }));
    await screen.findByTestId("model-settings-fast-mode");
    act(() => {
      void query.invalidateQueries({ queryKey: ["providerFeatures"] });
    });
    await waitFor(() => expect(runtime.requests).toHaveLength(3));
    expect(screen.queryByTestId("model-settings-fast-mode")).toBeNull();
    act(() =>
      runtime.requests[2]!.resolve({ features: [], error: "Cannot read installed runtime" }),
    );
    await waitFor(() => expect(draft.metadataStatus).toBe("error"));
    expect(screen.queryByTestId("model-settings-panel")).toBeNull();
    expect(screen.queryByText("Cannot read installed runtime")).toBeNull();
    act(() => draft.setFeatureValue("fast_mode", "on"));
    expect(screen.getByTestId("saved-speed").textContent).toBe("ultrafast");
  });
});
