/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  OmpCodexResetCreditConsumeResult,
  OmpCodexResetSettings,
  OmpProviderManagement,
  OmpProviderManagementGetResponseMessage,
} from "@omp-desktop/protocol/messages";
import { OmpCodexQuotaDetails, OmpQuotaServerContext } from "./omp-codex-quota-details";
import { ompProviderManagementQueryKey } from "@/hooks/use-omp-account-quota";
import { codexQuotaStrings } from "@/i18n/resources/codex-quota";
import type { Switch } from "@/components/ui/switch";

type Account = NonNullable<OmpProviderManagement["loginProviders"][number]["accounts"]>[number];
type Client = Pick<DaemonClient, "getOmpProviderManagement" | "consumeOmpCodexResetCredit"> &
  Partial<Pick<DaemonClient, "getOmpCodexResetSettings" | "updateOmpCodexResetSettings">>;
const runtime = vi.hoisted(() => ({
  client: null as Client | null,
  language: "en" as keyof typeof codexQuotaStrings,
  supportsSettings: false,
  confirm: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => runtime.client }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        test: {
          client: runtime.client,
          serverInfo: {
            features: {
              ompCodexResetCredits: true,
              ompCodexResetSettings: runtime.supportsSettings,
            },
          },
        },
      },
    }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: runtime.confirm }));
// Exercise async policy state independently of native animation; browser smoke uses the real switch.
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
    testID,
  }: React.ComponentProps<typeof Switch>) => (
    <button
      role="switch"
      aria-checked={value}
      aria-disabled={Boolean(disabled)}
      aria-label={accessibilityLabel}
      disabled={disabled}
      data-testid={testID}
      onClick={() => onValueChange?.(!value)}
    />
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: runtime.language },
    t: (key: string, args?: Record<string, unknown>) => {
      const value =
        codexQuotaStrings[runtime.language][
          key.split(".").at(-1) as keyof typeof codexQuotaStrings.en
        ] ?? key;
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
  runtime.language = "en";
  runtime.supportsSettings = false;
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

describe("Codex automatic reset setting", () => {
  it("allows an explicit disable from unset, then enables only after the host acknowledges", async () => {
    runtime.supportsSettings = true;
    const value = account();
    let settings: OmpCodexResetSettings = { configPath: "/tmp/config.yml", autoRedeem: "unset" };
    const saved = Promise.withResolvers<void>();
    const consume = vi.fn<Client["consumeOmpCodexResetCredit"]>();
    mount(value, {
      consumeOmpCodexResetCredit: consume,
      getOmpProviderManagement: async () => management(value),
      getOmpCodexResetSettings: async () => ({ ...settings, requestId: "read" }),
      updateOmpCodexResetSettings: async (enabled) => {
        if (enabled) await saved.promise;
        settings = { ...settings, autoRedeem: enabled ? "yes" : "no" };
        return { ...settings, requestId: "saved" };
      },
    });
    const toggle = screen.getByRole("switch", { name: "Automatically use reset cards" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText(/Not configured: asks first/)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Automatic use disabled")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-disabled")).toBe("true"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    saved.resolve();
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("Automatic use enabled")).toBeTruthy();
    expect(consume).not.toHaveBeenCalled();
  });

  it("keeps the acknowledged setting when saving fails and permits a later retry", async () => {
    runtime.supportsSettings = true;
    const value = account();
    let fail = true;
    mount(value, {
      consumeOmpCodexResetCredit: vi.fn(),
      getOmpProviderManagement: async () => management(value),
      getOmpCodexResetSettings: async () => ({
        configPath: "/tmp/config.yml",
        autoRedeem: "no",
        requestId: "read",
      }),
      updateOmpCodexResetSettings: async () => {
        if (fail) throw new Error("Read-only config");
        return { configPath: "/tmp/config.yml", autoRedeem: "yes", requestId: "saved" };
      },
    });
    const toggle = screen.getByRole("switch", { name: "Automatically use reset cards" });
    await waitFor(() => expect(toggle.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Read-only config"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fail = false;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("remaining Codex credits", () => {
  it.each([
    [undefined, "Credit balance unavailable"],
    [null, "Credit balance unavailable"],
    [{ hasCredits: true, unlimited: false, balance: null }, "Credit balance unavailable"],
    [{ hasCredits: true, unlimited: false }, "Credit balance unavailable"],
    [{ hasCredits: false, unlimited: false, balance: null }, "No credits available"],
    [{ hasCredits: false, unlimited: false, balance: "0" }, "Remaining: 0 credits"],
    [
      { hasCredits: true, unlimited: false, balance: "9007199254740993.000001" },
      "Remaining: 9007199254740993.000001 credits",
    ],
    [{ hasCredits: true, unlimited: true, balance: null }, "Unlimited credits"],
    [{ hasCredits: true, unlimited: true, balance: "0" }, "Unlimited credits"],
  ] as const)("displays the exact balance state %j", (credits, expected) => {
    const value = account();
    value.quota!.credits = credits;
    const consume = vi.fn<Client["consumeOmpCodexResetCredit"]>();
    mount(value, {
      consumeOmpCodexResetCredit: consume,
      getOmpProviderManagement: async () => management(value),
    });
    expect(screen.getByText("Codex credits")).toBeTruthy();
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.getByText("Reset cards")).toBeTruthy();
    expect(screen.getByText("Available: 1")).toBeTruthy();
    expect(consume).not.toHaveBeenCalled();
  });

  it("does not use reset-card inventory as the balance when there is no quota data", () => {
    const value: Account = { credentialId: nextId++ };
    mount(value, {
      consumeOmpCodexResetCredit: vi.fn(),
      getOmpProviderManagement: async () => management(value),
    });
    expect(screen.getByText("Credit balance unavailable")).toBeTruthy();
    expect(screen.queryByText("Remaining: 0 credits")).toBeNull();
    expect(screen.queryByText("Unlimited credits")).toBeNull();
  });

  it("localizes the balance label without rounding the reported decimal", () => {
    runtime.language = "zh-CN";
    const value = account();
    value.quota!.credits = { hasCredits: true, unlimited: false, balance: "123.4500" };
    mount(value, {
      consumeOmpCodexResetCredit: vi.fn(),
      getOmpProviderManagement: async () => management(value),
    });
    expect(screen.getByText("Codex 点数")).toBeTruthy();
    expect(screen.getByText("剩余：123.4500 点数")).toBeTruthy();
    expect(screen.getByText("重置卡")).toBeTruthy();
  });
});
