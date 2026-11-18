/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmpBuiltinApiKeyForm } from "./omp-builtin-api-key-form";
import { OmpProviderConfigurationPanel } from "./provider-diagnostic-sheet";

type GatewayClient = Pick<
  DaemonClient,
  "getOmpProviderManagement" | "discoverOmpProviderModels" | "addOmpProvider"
>;

const runtime = vi.hoisted(() => ({
  client: null as GatewayClient | null,
  refresh: vi.fn(async () => undefined),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client && Object.assign(runtime.client, { on: () => () => {} }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "forms-host": {
          client: runtime.client,
          serverInfo: { features: { ompProviderManagement: true } },
        },
      },
    }),
}));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ refresh: runtime.refresh }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/screens/settings/model-connection-chat", () => ({ ModelConnectionChat: () => null }));
vi.mock("@/components/settings-textarea", () => ({ SettingsTextArea: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: () => null,
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
// Only replace the platform overlay; both forms exercise the actual editable input.
vi.mock("@/components/adaptive-modal-sheet", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@/components/adaptive-text-input")),
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <section>{children}</section> : null,
}));

let queryClient: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  runtime.client = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fill(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

function getInput(testId: string): HTMLInputElement {
  const input = screen.getByTestId(testId);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Expected an input for ${testId}`);
  return input;
}

describe("OMP provider forms", () => {
  it("clears a rejected built-in API key without echoing it and accepts a replacement", async () => {
    const rejected = "fake-key-that-must-stay-private";
    const replacement = "fake-replacement-key";
    const save = vi
      .fn<(providerId: string, apiKey: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error(`Invalid credential: ${rejected}`))
      .mockResolvedValueOnce(undefined);
    const cancel = vi.fn();
    render(
      <OmpBuiltinApiKeyForm
        providerId="openai"
        providerName="OpenAI"
        onSave={save}
        onCancel={cancel}
      />,
    );

    const input = getInput("omp-builtin-api-key-input");
    const saveButton = () =>
      screen.getByRole("button", { name: "settings.providers.omp.apiKeyForm.save" });
    expect(input.type).toBe("password");
    fill(input, `  ${rejected}  `);
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "settings.providers.omp.apiKeyForm.saveFailed",
    );
    expect(document.body.textContent).not.toContain(rejected);
    expect(input.value).toBe("");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");

    fill(input, replacement);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(save.mock.calls).toEqual([
        ["openai", rejected],
        ["openai", replacement],
      ]),
    );
  });

  it.each(["empty model list", "RPC rejection"])(
    "preserves a manually entered model after %s and saves it",
    async (failure) => {
      const initial = {
        requestId: "forms-management",
        configPath: "/tmp/models.yml",
        configYaml: "providers: {}\n",
        loginProviders: [],
        providerModels: [],
      };
      const addProvider = vi.fn<GatewayClient["addOmpProvider"]>().mockResolvedValue(initial);
      const discover = vi.fn<GatewayClient["discoverOmpProviderModels"]>();
      if (failure === "empty model list") {
        discover.mockResolvedValue({ requestId: "forms-discovery", models: [] });
      } else {
        discover.mockRejectedValue(new Error("Discovery unavailable"));
      }
      runtime.client = {
        getOmpProviderManagement: vi.fn().mockResolvedValue(initial),
        discoverOmpProviderModels: discover,
        addOmpProvider: addProvider,
      };
      render(
        <QueryClientProvider client={queryClient}>
          <OmpProviderConfigurationPanel serverId="forms-host" />
        </QueryClientProvider>,
      );

      fireEvent.click(await screen.findByTestId("omp-add-custom-provider"));
      fill(screen.getByTestId("omp-gateway-endpoint"), "https://gateway.example.test/v1");
      fill(screen.getByTestId("omp-gateway-api-key"), "fake-gateway-key");
      fireEvent.click(screen.getByTestId("omp-gateway-manual"));
      const modelId = "omp-gateway-model-id-model-0";
      fill(screen.getByTestId(modelId), "team/model-v2");
      fireEvent.click(screen.getByTestId("omp-gateway-manual"));
      expect(screen.queryByTestId(modelId)).toBeNull();

      fireEvent.click(screen.getByTestId("omp-gateway-fetch-models"));
      await screen.findByText("settings.providers.omp.gatewayForm.discoveryFailed");
      expect(getInput(modelId).value).toBe("team/model-v2");
      fireEvent.click(
        screen.getByRole("button", { name: "settings.providers.omp.custom.addWithCount" }),
      );

      await waitFor(() => expect(screen.queryByTestId("omp-gateway-endpoint")).toBeNull());
      expect(addProvider).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          models: [expect.objectContaining({ id: "team/model-v2" })],
        }),
      );
    },
  );
});
