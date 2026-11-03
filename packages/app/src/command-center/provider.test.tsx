/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentControlCommandCenterSource } from "./agent-control-registration";
import {
  CommandCenterProvider,
  useActiveAgentControlRegistration,
  useActiveAgentControls,
} from "./provider";
import { groupOmpModelsByProviderNamespace } from "@/composer/agent-controls/model-sheet-flow";

function controls(name: string): AgentControlCommandCenterSource {
  return {
    serverId: "host",
    ownerKey: "workspace",
    provider: "omp",
    providerDefinitions: [],
    models: {
      providers: [
        {
          id: "omp",
          label: "OMP",
          modelSelection: {
            kind: "models",
            rows: [
              {
                favoriteKey: "omp:custom/chat",
                provider: "omp",
                providerLabel: name,
                providerName: name,
                modelId: "custom/chat",
                modelLabel: "Chat",
              },
            ],
          },
        },
      ],
      selectedProvider: "omp",
      selectedModelId: "custom/chat",
      select: () => {},
    },
    thinking: { options: [], selectedId: null, select: () => {} },
    features: { list: [] },
  };
}

function Registration(props: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  useActiveAgentControlRegistration(props);
  return null;
}

function ProviderNames() {
  const snapshot = useActiveAgentControls();
  const providers = groupOmpModelsByProviderNamespace([
    ...(snapshot?.controls.models.providers ?? []),
  ]);
  return (
    <output data-testid="providers">
      {providers.map((provider) => provider.label).join(", ")}
    </output>
  );
}

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the last focused workspace's provider catalog live while settings has focus", () => {
  const initial = controls("Before edit");
  const updated = controls("After edit");
  const view = render(
    <CommandCenterProvider>
      <Registration sourceId="workspace" enabled controls={initial} />
      <ProviderNames />
    </CommandCenterProvider>,
  );
  expect(screen.getByTestId("providers").textContent).toBe("Before edit");

  view.rerender(
    <CommandCenterProvider>
      <Registration sourceId="workspace" enabled={false} controls={updated} />
      <Registration sourceId="background" enabled={false} controls={controls("Other workspace")} />
      <ProviderNames />
    </CommandCenterProvider>,
  );
  expect(screen.getByTestId("providers").textContent).toBe("After edit");

  view.rerender(
    <CommandCenterProvider>
      <Registration sourceId="background" enabled={false} controls={controls("Other workspace")} />
      <ProviderNames />
    </CommandCenterProvider>,
  );
  expect(screen.getByTestId("providers").textContent).toBe("");
});
