import React, { act } from "react";
import { createInstance } from "i18next";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { OmpPluginInfo } from "@omp-desktop/protocol/messages";
import type { Switch } from "@/components/ui/switch";
import { ompPluginSettings } from "@/i18n/resources/plugin-settings";
import { OmpPluginsPage } from "./omp-plugins-page";

type PluginsClient = Pick<
  DaemonClient,
  "listOmpPlugins" | "listOmpPluginMarketplaces" | "runOmpPluginDoctor"
>;

const runtime = vi.hoisted(() => ({
  client: null as PluginsClient | null,
  t: (key: string, _options?: Record<string, unknown>): string => key,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: runtime.t, i18n: { language: "en" } }),
}));
// Retry/list recovery does not depend on the animated switch's theme mapping.
vi.mock("@/components/ui/switch", () => ({
  Switch: function FixtureSwitch({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
    testID,
  }: React.ComponentProps<typeof Switch>) {
    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(event.currentTarget.checked),
      [onValueChange],
    );
    return (
      <input
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled}
        aria-label={accessibilityLabel}
        data-testid={testID}
        onChange={handleChange}
      />
    );
  },
}));

const recoveredPlugin: OmpPluginInfo = {
  name: "Recovered plugin",
  id: "recovered-plugin@test-marketplace",
  version: "1.0.0",
  scope: "user",
  enabled: true,
  description: "A plugin recovered from the host list",
};

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: {
      en: { translation: { settings: { host: { ompPlugins: ompPluginSettings } } } },
    },
    interpolation: { escapeValue: false },
  });
  runtime.t = (key, options) => i18n.t(key, options);
});

afterEach(() => {
  cleanup();
  runtime.client = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  {
    state: "installed",
    plugins: [recoveredPlugin],
    expectedSwitchCount: 1,
  },
  {
    state: "empty",
    plugins: [],
    expectedSwitchCount: 0,
  },
])(
  "clears a failed load after Retry recovers the $state list",
  async ({ plugins, expectedSwitchCount }) => {
    runtime.client = {
      listOmpPlugins: vi
        .fn<PluginsClient["listOmpPlugins"]>()
        .mockRejectedValueOnce(new Error("Host plugin list unavailable"))
        .mockResolvedValue({
          requestId: "retry-list",
          plugins,
          marketplace: [],
          rawOutput: "Host list recovered",
        }),
      listOmpPluginMarketplaces: async () => ({ requestId: "marketplaces", marketplaces: [] }),
      runOmpPluginDoctor: vi.fn(),
    };
    render(<OmpPluginsPage serverId="server-1" />);

    const error = await screen.findByTestId("omp-plugins-error");
    expect(within(error).getByText("Host plugin list unavailable")).toBeTruthy();
    await act(async () => {
      await userEvent.click(within(error).getByRole("button", { name: "Retry" }));
    });

    const list = await screen.findByTestId("omp-plugins-list-card");
    if (plugins.length) expect(within(list).getByText(recoveredPlugin.description!)).toBeTruthy();
    expect(within(list).queryAllByRole("switch")).toHaveLength(expectedSwitchCount);
    expect(screen.queryByTestId("omp-plugins-error")).toBeNull();
    expect(screen.queryByTestId("omp-plugins-action-error")).toBeNull();
    expect(screen.queryByText("Host plugin list unavailable")).toBeNull();
  },
);

it("keeps operation failures visible and preserves doctor feedback through its list refresh", async () => {
  runtime.client = {
    listOmpPlugins: vi
      .fn<PluginsClient["listOmpPlugins"]>()
      .mockResolvedValueOnce({ requestId: "initial-list", plugins: [], marketplace: [] })
      .mockResolvedValue({
        requestId: "refreshed-list",
        plugins: [recoveredPlugin],
        marketplace: [],
      }),
    listOmpPluginMarketplaces: async () => ({ requestId: "marketplaces", marketplaces: [] }),
    runOmpPluginDoctor: vi
      .fn<PluginsClient["runOmpPluginDoctor"]>()
      .mockRejectedValueOnce(new Error("Doctor could not access the plugin directory"))
      .mockResolvedValue({
        requestId: "doctor-fix",
        checks: [
          { name: "Permissions", status: "warning", message: "Manual approval is still required" },
        ],
        rawOutput: "Repaired the plugin index",
      }),
  };
  render(<OmpPluginsPage serverId="server-1" />);
  await screen.findByTestId("omp-plugins-list-card");

  await act(async () => {
    await userEvent.click(screen.getByTestId("omp-plugins-doctor-run"));
  });
  const error = await screen.findByTestId("omp-plugins-action-error");
  expect(within(error).getByText("Doctor could not access the plugin directory")).toBeTruthy();

  await act(async () => {
    await userEvent.click(screen.getByTestId("omp-plugins-doctor-fix"));
  });
  await screen.findByText("A plugin recovered from the host list");
  expect(
    within(screen.getByTestId("omp-plugins-doctor-card")).getByText(
      "Manual approval is still required",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(screen.queryByTestId("omp-plugins-action-error")).toBeNull());
});
