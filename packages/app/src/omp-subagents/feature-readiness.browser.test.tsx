import React, { act, createElement } from "react";
import { View as NativeView } from "react-native";
import type * as Reanimated from "react-native-reanimated";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentFeature } from "@omp-desktop/protocol/agent-types";
import type { OmpSubagentSettings } from "@omp-desktop/protocol/messages";
import { en } from "@/i18n/resources/en";
import { OmpSubagentsSection } from "./omp-subagents-section";

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
const runtime = vi.hoisted(() => ({
  pending: [] as Array<(payload: FeaturePayload) => void>,
  writes: 0,
  settings: {
    configPath: "/isolated/config.yml",
    enabled: true,
    agents: [],
  } as OmpSubagentSettings,
}));
const client = {
  getOmpSubagentSettings: async () => runtime.settings,
  updateOmpSubagentSettings: async () => {
    runtime.writes += 1;
    return runtime.settings;
  },
  updateOmpSubagentSettingsEnabled: async () => {
    runtime.writes += 1;
    return runtime.settings;
  },
  listProviderFeatures: () => {
    const pending = Promise.withResolvers<FeaturePayload>();
    runtime.pending.push(pending.resolve);
    return pending.promise;
  },
};
const entries = [
  {
    provider: "omp",
    fetchedAt: "2026-11-04T00:00:00Z",
    enabled: true,
    status: "ready",
    models: [{ id: "openai-codex/sol", provider: "omp", label: "Sol" }],
  },
];
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => client,
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries, isLoading: false }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<string, { serverInfo: { features: { ompSubagentSettings: boolean } } }>;
    }) => unknown,
  ) =>
    selector({ sessions: { host: { serverInfo: { features: { ompSubagentSettings: true } } } } }),
}));
let query: QueryClient;
let i18n: I18n;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runtime.pending = [];
  runtime.writes = 0;
  runtime.settings = {
    configPath: "/isolated/config.yml",
    enabled: true,
    agents: [
      {
        name: "worker",
        description: "Worker",
        model: "openai-codex/sol",
        fastMode: "ultrafast",
        serviceTier: "ultrafast",
      },
    ],
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
function Page() {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={query}>
        <OmpSubagentsSection serverId="host" />
      </QueryClientProvider>
    </I18nextProvider>
  );
}
it("keeps the production subagent speed read-only through detection, error and retry, preserving saved Ultrafast", async () => {
  render(<Page />);
  const status = await screen.findByTestId("omp-subagent-speed-status-worker");
  expect(status.textContent).toContain("Detecting supported speeds");
  expect(screen.queryByTestId("omp-subagent-fast-worker")).toBeNull();
  await waitFor(() => expect(runtime.pending).toHaveLength(1));
  act(() => runtime.pending[0]!({ features: [], error: "Native startup failed" }));
  expect((await screen.findByTestId("omp-subagent-speed-retry-worker")).textContent).toContain(
    "Retry speed detection",
  );
  expect(screen.getByTestId("omp-subagent-speed-status-worker").textContent).toContain(
    "Native startup failed",
  );
  fireEvent.click(screen.getByTestId("omp-subagent-speed-retry-worker"));
  await waitFor(() => expect(runtime.pending).toHaveLength(2));
  act(() => runtime.pending[1]!({ features: [] }));
  await waitFor(() =>
    expect(screen.getByTestId("omp-subagent-speed-status-worker").textContent).toContain(
      "not supported",
    ),
  );
  expect(runtime.settings.agents[0]!.fastMode).toBe("ultrafast");
  expect(runtime.writes).toBe(0);
});
it("blocks stale confirmed Ultrafast when the host capability context is being rechecked", async () => {
  render(<Page />);
  await waitFor(() => expect(runtime.pending).toHaveLength(1));
  act(() =>
    runtime.pending[0]!({
      features: [
        {
          id: "fast_mode",
          label: "Speed",
          type: "select",
          value: "off",
          options: [
            { id: "off", label: "Standard" },
            { id: "on", label: "Fast" },
            { id: "ultrafast", label: "Ultrafast" },
          ],
        },
      ],
    }),
  );
  expect((await screen.findByTestId("omp-subagent-fast-worker")).textContent).toContain(
    "Ultrafast",
  );
  act(() => {
    void query.invalidateQueries({ queryKey: ["ompSubagentFeatures"] });
  });
  await waitFor(() => expect(runtime.pending).toHaveLength(2));
  expect(screen.queryByTestId("omp-subagent-fast-worker")).toBeNull();
  expect(screen.getByTestId("omp-subagent-speed-status-worker").textContent).toContain("Detecting");
  act(() =>
    runtime.pending[1]!({
      features: [{ id: "fast_mode", label: "Fast", type: "toggle", value: false }],
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("omp-subagent-speed-status-worker").textContent).toContain(
      "not supported",
    ),
  );
  expect(runtime.settings.agents[0]!.fastMode).toBe("ultrafast");
  expect(runtime.writes).toBe(0);
});
