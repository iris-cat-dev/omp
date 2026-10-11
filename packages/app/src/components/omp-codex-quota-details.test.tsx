/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  OmpCodexResetCreditConsumeResult,
  OmpProviderManagement,
  OmpProviderManagementGetResponseMessage,
} from "@omp-desktop/protocol/messages";
import { OmpCodexQuotaDetails, OmpQuotaServerContext } from "./omp-codex-quota-details";
import { ompProviderManagementQueryKey } from "@/hooks/use-omp-account-quota";
import { codexQuotaStrings } from "@/i18n/resources/codex-quota";

type Account = NonNullable<OmpProviderManagement["loginProviders"][number]["accounts"]>[number];
type Client = Pick<DaemonClient, "getOmpProviderManagement" | "consumeOmpCodexResetCredit">;
const runtime = vi.hoisted(() => ({
  client: null as Client | null,
  confirm: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => runtime.client }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        test: { client: runtime.client, serverInfo: { features: { ompCodexResetCredits: true } } },
      },
    }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: runtime.confirm }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, args?: Record<string, unknown>) => {
      const value =
        codexQuotaStrings.en[key.split(".").at(-1) as keyof typeof codexQuotaStrings.en] ?? key;
      return value.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) =>
        String(args?.[name] ?? ""),
      );
    },
  }),
}));
let nextId = 1;
let queryClient: QueryClient;
function account(): Account {
  return {
    credentialId: nextId++,
    quota: {
      status: "available",
      weeklyUsedPct: 99,
      resetCredits: {
        status: "available",
        availableCount: 1,
        credits: [
          {
            id: "card",
            status: "available",
            resetType: "codex_rate_limits",
            grantedAt: "2026-01-01T00:00:00Z",
            expiresAt: null,
            title: "Full reset",
            description: null,
          },
        ],
      },
    },
  };
}
function management(value: Account): OmpProviderManagementGetResponseMessage["payload"] {
  return {
    requestId: "test-management",
    configPath: "/tmp/models.yml",
    configYaml: "",
    providerModels: [],
    loginProviders: [
      {
        id: "openai-codex",
        name: "Codex",
        available: true,
        authenticated: true,
        accounts: [value],
      },
    ],
  };
}
function mount(value: Account, client: Client) {
  runtime.client = client;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OmpQuotaServerContext.Provider value="test">
        <OmpCodexQuotaDetails account={value} accountLabel="Selected account" />
      </OmpQuotaServerContext.Provider>
    </QueryClientProvider>,
  );
}
function button(value: Account) {
  return screen.getByTestId(`omp-reset-credit-consume-${value.credentialId}-card`);
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  runtime.confirm.mockResolvedValue(true);
});
afterEach(async () => {
  cleanup();
  if (queryClient) {
    await queryClient.cancelQueries();
    queryClient.clear();
  }
  runtime.client = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Codex reset-card interaction", () => {
  it("cancel does not spend a card or refresh management", async () => {
    const value = account();
    const consume = vi.fn<Client["consumeOmpCodexResetCredit"]>();
    const get = vi.fn(async () => management(value));
    runtime.confirm.mockResolvedValue(false);
    mount(value, { consumeOmpCodexResetCredit: consume, getOmpProviderManagement: get });
    fireEvent.click(button(value));
    await waitFor(() => expect(button(value).getAttribute("aria-disabled")).not.toBe("true"));
    expect(consume).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("blocks duplicate submissions throughout confirmation and consumption", async () => {
    const value = account();
    const confirmation = Promise.withResolvers<boolean>();
    const consumption = Promise.withResolvers<OmpCodexResetCreditConsumeResult>();
    runtime.confirm.mockImplementation(() => confirmation.promise);
    const consume = vi.fn<Client["consumeOmpCodexResetCredit"]>(() => consumption.promise);
    mount(value, {
      consumeOmpCodexResetCredit: consume,
      getOmpProviderManagement: async () => management(value),
    });
    fireEvent.click(button(value));
    fireEvent.click(button(value));
    expect(runtime.confirm).toHaveBeenCalledTimes(1);
    await act(async () => confirmation.resolve(true));
    fireEvent.click(button(value));
    expect(consume).toHaveBeenCalledTimes(1);
    await act(async () => consumption.resolve({ code: "reset", windowsReset: 2 }));
    await screen.findByText("Server applied a reset to 2 window(s).");
    expect(button(value).getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    ["reset", "Server applied a reset to 2 window(s)."],
    ["nothing_to_reset", "Nothing to reset. The server did not apply a reset."],
    ["no_credit", "This card is no longer available; no reset was applied."],
    [
      "already_redeemed",
      "This request was already redeemed. No new reset was applied; refreshing server state.",
    ],
  ] as const)(
    "reports %s truthfully and refreshes quota and cards together",
    async (code, message) => {
      const value = account();
      const refreshed = management({
        ...value,
        quota: {
          status: "available",
          weeklyUsedPct: 0,
          resetCredits: { status: "available", availableCount: 0, credits: [] },
        },
      });
      mount(value, {
        consumeOmpCodexResetCredit: async () => ({ code, windowsReset: 2 }),
        getOmpProviderManagement: async () => refreshed,
      });
      fireEvent.click(button(value));
      await screen.findByText(message);
      await waitFor(() =>
        expect(queryClient.getQueryData(ompProviderManagementQueryKey("test"))).toEqual(refreshed),
      );
    },
  );

  it("retains the redemption identity after a lost response, preventing a second spend", async () => {
    const value = account();
    const redeemed = new Set<string>();
    let spends = 0;
    mount(value, {
      consumeOmpCodexResetCredit: async (_credential, _card, requestId) => {
        if (redeemed.has(requestId)) return { code: "already_redeemed", windowsReset: 0 };
        redeemed.add(requestId);
        spends++;
        throw new Error("response lost after commit");
      },
      getOmpProviderManagement: async () => management(value),
    });
    fireEvent.click(button(value));
    await screen.findByText(/Could not confirm consumption: response lost after commit/);
    fireEvent.click(button(value));
    await screen.findByText(
      "This request was already redeemed. No new reset was applied; refreshing server state.",
    );
    expect(spends).toBe(1);
  });

  it.each([
    { status: "used" },
    { status: "unrecognized" },
    { resetType: "unknown_type" },
    { expiresAt: "2000-01-01T00:00:00Z" },
    { expiresAt: "bad-date" },
  ])("prevents consumption of ineligible card %j", async (patch) => {
    const value = account();
    Object.assign(value.quota!.resetCredits!.credits[0]!, patch);
    const consume = vi.fn<Client["consumeOmpCodexResetCredit"]>();
    mount(value, {
      consumeOmpCodexResetCredit: consume,
      getOmpProviderManagement: async () => management(value),
    });
    expect(button(value).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button(value));
    expect(runtime.confirm).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("subscription expiry display", () => {
  it("does not mistake missing subscription metadata for no subscription", () => {
    const value = account();
    mount(value, {
      consumeOmpCodexResetCredit: vi.fn(),
      getOmpProviderManagement: async () => management(value),
    });
    expect(screen.getByText(codexQuotaStrings.en.subscription_unavailable)).toBeTruthy();
    expect(screen.queryByText(codexQuotaStrings.en.subscription_none)).toBeNull();
  });

  it.each([
    [
      {
        status: "unavailable" as const,
        expiresAt: null,
        unavailableReason: "unsupported" as const,
      },
      codexQuotaStrings.en.subscription_unsupported,
      null,
    ],
    [
      { status: "unavailable" as const, expiresAt: null, error: "HTTP 403" },
      codexQuotaStrings.en.subscription_error,
      "HTTP 403",
    ],
  ])("distinguishes unsupported lookup from a failed query: %j", (subscription, label, error) => {
    const value = account();
    value.quota!.subscription = subscription;
    mount(value, {
      consumeOmpCodexResetCredit: vi.fn(),
      getOmpProviderManagement: async () => management(value),
    });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole("alert")?.textContent ?? null).toBe(error);
    expect(screen.queryByText(codexQuotaStrings.en.subscription_none)).toBeNull();
    expect(screen.queryByText(codexQuotaStrings.en.subscription_expired)).toBeNull();
    expect(screen.queryByText(/remaining$/)).toBeNull();
  });

  it("displays account-reported expiry and remaining time without calling it token metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-01T00:00:00Z"));
    const value = account();
    value.quota!.subscription = {
      status: "active",
      expiresAt: "2026-10-02T00:00:00Z",
      source: "account",
    };
    try {
      mount(value, {
        consumeOmpCodexResetCredit: vi.fn(),
        getOmpProviderManagement: async () => management(value),
      });
      expect(screen.getByText(/Expires:.*2026/)).toBeTruthy();
      expect(screen.getByText("1d0h remaining")).toBeTruthy();
      expect(screen.getByText(codexQuotaStrings.en.subscriptionAccountNote)).toBeTruthy();
      expect(screen.queryByText(codexQuotaStrings.en.subscriptionNote)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes an active token-reported expiry to expired live without negative remaining time", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-01T00:00:00Z");
    vi.setSystemTime(now);
    const value = account();
    value.quota!.subscription = { status: "active", expiresAt: new Date(now + 500).toISOString() };
    try {
      mount(value, {
        consumeOmpCodexResetCredit: vi.fn(),
        getOmpProviderManagement: async () => management(value),
      });
      expect(screen.getByText(codexQuotaStrings.en.subscription_active)).toBeTruthy();
      expect(screen.getByText("0h1min remaining")).toBeTruthy();
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(screen.getByText(codexQuotaStrings.en.subscription_expired)).toBeTruthy();
      expect(screen.queryByText(/remaining$/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
