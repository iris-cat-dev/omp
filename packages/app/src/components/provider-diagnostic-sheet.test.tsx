/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { OmpProviderLoginCompletedMessage } from "@omp-desktop/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmpProviderConfigurationPanel } from "@/components/provider-diagnostic-sheet";
import {
  ompProviderManagementQueryKey,
  useOmpProviderAccountQuota,
} from "@/hooks/use-omp-account-quota";

type ManagementClient = Pick<
  DaemonClient,
  "getOmpProviderManagement" | "reorderOmpProviderAccounts"
> &
  Partial<
    Pick<
      DaemonClient,
      | "listProviderUsage"
      | "startOmpProviderLogin"
      | "finishOmpProviderLogin"
      | "cancelOmpProviderLogin"
    >
  >;
type ManagementResponse = Awaited<ReturnType<ManagementClient["getOmpProviderManagement"]>>;

const runtime = vi.hoisted(() => ({
  client: null as ManagementClient | null,
  refresh: vi.fn(async () => undefined),
  translate: (key: string) => key,
  isConnected: false,
  providerUsageList: false,
  loginListeners: new Set<(message: OmpProviderLoginCompletedMessage) => void>(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () =>
    runtime.client &&
    Object.assign(runtime.client, {
      on: (type: string, handler: (message: OmpProviderLoginCompletedMessage) => void) => {
        if (type === "omp.provider.login.completed") runtime.loginListeners.add(handler);
        return () => runtime.loginListeners.delete(handler);
      },
    }),
  useHostRuntimeIsConnected: () => runtime.isConnected,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          client: runtime.client,
          serverInfo: {
            features: {
              ompProviderManagement: true,
              providerUsageList: runtime.providerUsageList,
            },
          },
        },
      },
    }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ refresh: runtime.refresh }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: runtime.translate, i18n: { language: "en" } }),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));

// These editors and platform overlays are not part of account reordering.
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <section>{children}</section> : null,
  AdaptiveTextInput: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: () => null,
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/settings-textarea", () => ({ SettingsTextArea: () => null }));

const queryClients: QueryClient[] = [];
const settlePendingRequests: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("open", vi.fn());
});

afterEach(async () => {
  cleanup();
  await Promise.all(queryClients.map((client) => client.cancelQueries()));
  await act(async () => {
    for (const settle of settlePendingRequests.splice(0)) settle();
  });
  for (const client of queryClients.splice(0)) client.clear();
  runtime.client = null;
  runtime.isConnected = false;
  runtime.providerUsageList = false;
  runtime.loginListeners.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function management(credentialIds: number[]): ManagementResponse {
  return {
    requestId: "test-management",
    configPath: "/tmp/models.yml",
    configYaml: "providers: {}\n",
    providerModels: [],
    loginProviders: [
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        available: true,
        authenticated: true,
        accounts: credentialIds.map((credentialId) => ({
          credentialId,
          quota: { status: "available", weeklyUsedPct: 20 },
        })),
      },
    ],
  };
}

function deferredManagement(fallback: ManagementResponse) {
  let resolve!: (result: ManagementResponse) => void;
  const promise = new Promise<ManagementResponse>((done) => {
    resolve = done;
  });
  // Also settle the request when an assertion fails before the normal resolution.
  settlePendingRequests.push(() => resolve(fallback));
  return { promise, resolve };
}

function QuotaConsumer({ providerId = "openai-codex" }: { providerId?: string }) {
  const { accounts, loading } = useOmpProviderAccountQuota("server-1", providerId);
  return (
    <aside>
      <output
        data-testid={providerId === "anthropic" ? "claude-account-order" : "quota-account-order"}
      >
        {accounts.map((account) => account.credentialId).join(",")}
      </output>
      <output data-testid="quota-status">{loading ? "refreshing" : "idle"}</output>
    </aside>
  );
}

async function renderPanel(client: ManagementClient) {
  runtime.client = client;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClients.push(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <OmpProviderConfigurationPanel serverId="server-1" />
      <QuotaConsumer />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTestId("omp-signed-in-providers-toggle"));
  await screen.findByTestId("omp-provider-account-move-up-2");
  await waitFor(() => {
    expect(screen.getByTestId("quota-account-order").textContent).toBe("1,2");
    expect(screen.getByTestId("quota-status").textContent).toBe("idle");
  });
  return queryClient;
}

describe("OMP provider management loading", () => {
  it("reuses the cached result when settings is reopened", async () => {
    const getOmpProviderManagement = vi.fn(async () => management([1]));
    runtime.client = {
      getOmpProviderManagement,
      reorderOmpProviderAccounts: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClients.push(queryClient);

    const first = render(
      <QueryClientProvider client={queryClient}>
        <OmpProviderConfigurationPanel serverId="server-1" />
      </QueryClientProvider>,
    );
    await screen.findByTestId("omp-signed-in-providers-toggle");
    first.unmount();

    render(
      <QueryClientProvider client={queryClient}>
        <OmpProviderConfigurationPanel serverId="server-1" />
      </QueryClientProvider>,
    );
    await screen.findByTestId("omp-signed-in-providers-toggle");

    expect(getOmpProviderManagement).toHaveBeenCalledOnce();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("shares one management fetch across mounted Codex and Claude account consumers", async () => {
    const result = management([1]);
    result.loginProviders.push({
      id: "anthropic",
      name: "Claude",
      authenticated: true,
      available: true,
      accounts: [{ credentialId: 7, quota: { status: "available", weeklyUsedPct: 80 } }],
    });
    const getOmpProviderManagement = vi.fn(async () => result);
    runtime.client = { getOmpProviderManagement, reorderOmpProviderAccounts: vi.fn() };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(queryClient);
    const mounted = render(
      <QueryClientProvider client={queryClient}>
        <QuotaConsumer />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("quota-account-order").textContent).toBe("1");
    });
    mounted.rerender(
      <QueryClientProvider client={queryClient}>
        <QuotaConsumer />
        <QuotaConsumer providerId="anthropic" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("quota-account-order").textContent).toBe("1");
      expect(screen.getByTestId("claude-account-order").textContent).toBe("7");
    });
    expect(getOmpProviderManagement).toHaveBeenCalledOnce();
  });

  it("renders Claude model and spending details without mounting Codex expiry or reset controls", async () => {
    const result = management([]);
    result.loginProviders = [
      {
        id: "anthropic",
        name: "Claude",
        authenticated: true,
        available: true,
        accounts: [
          {
            credentialId: 7,
            quota: {
              status: "available",
              planLabel: "max",
              fiveHourUsedPct: 20,
              weeklyUsedPct: 80,
              modelWindows: [{ model: "opus", usedPct: 60, resetsAt: null }],
              extraUsage: { enabled: true, usedUsd: 1.23, monthlyLimitUsd: null, usedPct: null },
            },
          },
        ],
      },
    ];
    const getOmpProviderManagement = vi.fn(async () => result);
    runtime.client = { getOmpProviderManagement, reorderOmpProviderAccounts: vi.fn() };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(queryClient);
    render(
      <QueryClientProvider client={queryClient}>
        <OmpProviderConfigurationPanel serverId="server-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByTestId("omp-signed-in-providers-toggle"));
    await screen.findByTestId("omp-provider-account-quota-7");
    expect(screen.getByText("providerUsage.modelWeekly")).toBeTruthy();
    expect(screen.getByText(/providerUsage.extraUsage.spent/).textContent).toContain("$1.23");
    expect(screen.getByText(/providerUsage.extraUsage.limit/).textContent).toContain(
      "providerUsage.extraUsage.unknown",
    );
    expect(screen.queryByText("settings.providers.omp.codexQuota.subscription")).toBeNull();
    expect(screen.queryByText("settings.providers.omp.codexQuota.cards")).toBeNull();
    expect(getOmpProviderManagement).toHaveBeenCalledOnce();
  });
  it("bypasses the cache when the user refreshes", async () => {
    const getOmpProviderManagement = vi.fn(async () => management([1]));
    runtime.client = {
      getOmpProviderManagement,
      reorderOmpProviderAccounts: vi.fn(),
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClients.push(queryClient);

    render(
      <QueryClientProvider client={queryClient}>
        <OmpProviderConfigurationPanel serverId="server-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText("settings.providers.omp.refresh"));

    await waitFor(() => expect(getOmpProviderManagement).toHaveBeenCalledTimes(2));
  });
});

describe("OMP automatic login completion", () => {
  const flow = {
    requestId: "start",
    flowId: "flow-codex",
    providerId: "openai-codex",
    url: "https://example.test/oauth",
  };

  function completeLogin(flowId = flow.flowId) {
    for (const listener of runtime.loginListeners) {
      listener({
        type: "omp.provider.login.completed",
        payload: { flowId, providerId: flow.providerId },
      });
    }
  }

  it("closes only the completed login without requiring finish or cancelling saved credentials", async () => {
    const finish = vi.fn();
    const cancel = vi.fn(async () => ({
      requestId: "cancel",
      flowId: flow.flowId,
      cancelled: false,
    }));
    await renderPanel({
      getOmpProviderManagement: async () => management([1, 2]),
      reorderOmpProviderAccounts: vi.fn(),
      startOmpProviderLogin: async () => flow,
      finishOmpProviderLogin: finish,
      cancelOmpProviderLogin: cancel,
    });
    fireEvent.click(screen.getByTestId("omp-login-provider-openai-codex"));
    await screen.findByText("settings.providers.omp.login.complete");

    act(() => completeLogin("another-flow"));
    expect(screen.queryByText("settings.providers.omp.login.complete")).not.toBeNull();
    act(() => completeLogin());

    await waitFor(() =>
      expect(screen.queryByText("settings.providers.omp.login.complete")).toBeNull(),
    );
    cleanup();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not reopen a login that completed before its start response arrived", async () => {
    await renderPanel({
      getOmpProviderManagement: async () => management([1, 2]),
      reorderOmpProviderAccounts: vi.fn(),
      startOmpProviderLogin: async () => {
        completeLogin();
        return flow;
      },
    });

    await act(async () => fireEvent.click(screen.getByTestId("omp-login-provider-openai-codex")));

    expect(screen.queryByText("settings.providers.omp.login.complete")).toBeNull();
    expect(
      screen.getByTestId("omp-login-provider-openai-codex").getAttribute("aria-disabled"),
    ).not.toBe("true");
  });
});

describe("OMP provider account reordering quota synchronization", () => {
  it("updates the mounted quota consumer and ignores a late pre-reorder refetch", async () => {
    const initial = management([1, 2]);
    const reordered = management([2, 1]);
    const oldRefetch = deferredManagement(initial);
    const getOmpProviderManagement = vi.fn(async () => initial);
    const queryClient = await renderPanel({
      getOmpProviderManagement,
      reorderOmpProviderAccounts: vi.fn(async () => reordered),
    });
    const quotaKey = ompProviderManagementQueryKey("server-1");
    const otherHostKey = ompProviderManagementQueryKey("server-2");
    const otherHost = management([3, 4]);
    queryClient.setQueryData(otherHostKey, otherHost);

    getOmpProviderManagement.mockImplementation(() => oldRefetch.promise);
    let refetch!: Promise<void>;
    act(() => {
      refetch = queryClient.refetchQueries({ queryKey: quotaKey, exact: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId("quota-status").textContent).toBe("refreshing");
    });

    fireEvent.click(screen.getByTestId("omp-provider-account-move-up-2"));
    await waitFor(() => {
      expect(screen.getByTestId("quota-account-order").textContent).toBe("2,1");
      expect(screen.getByTestId("quota-status").textContent).toBe("idle");
    });
    expect(queryClient.getQueryData(quotaKey)).toEqual(reordered);
    expect(queryClient.getQueryData(otherHostKey)).toEqual(otherHost);

    await act(async () => {
      oldRefetch.resolve(initial);
      await oldRefetch.promise;
      await refetch;
    });
    expect(screen.getByTestId("quota-account-order").textContent).toBe("2,1");
    expect(queryClient.getQueryData(quotaKey)).toEqual(reordered);
    expect(queryClient.getQueryData(otherHostKey)).toEqual(otherHost);
  });

  it("preserves quota order and cache when reordering fails and displays the error", async () => {
    const initial = management([1, 2]);
    const queryClient = await renderPanel({
      getOmpProviderManagement: vi.fn(async () => initial),
      reorderOmpProviderAccounts: vi.fn().mockRejectedValue(new Error("Account reorder failed")),
    });

    fireEvent.click(screen.getByTestId("omp-provider-account-move-up-2"));

    expect(await screen.findByText("Account reorder failed")).toBeTruthy();
    expect(screen.getByTestId("quota-account-order").textContent).toBe("1,2");
    expect(screen.getByTestId("quota-status").textContent).toBe("idle");
    expect(queryClient.getQueryData(ompProviderManagementQueryKey("server-1"))).toEqual(initial);
  });
});
