import React from "react";
import { createInstance } from "i18next";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  OmpStatsGetResponseMessage,
  OmpStatsRange,
  OmpStatsSnapshot,
} from "@omp-desktop/protocol/omp-stats";
import { providerUsage } from "@/i18n/resources/provider-usage";
import { OmpStatsSettingsSection } from "./omp-stats-section";

type StatsPayload = OmpStatsGetResponseMessage["payload"];
const runtime = vi.hoisted(() => ({
  clients: {} as Record<string, Pick<DaemonClient, "getOmpStats">>,
  connected: true,
  supported: true,
  t: (key: string, _options?: Record<string, unknown>): string => key,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => runtime.clients[serverId] ?? null,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        first: { serverInfo: { features: { ompStats: runtime.supported } } },
        second: { serverInfo: { features: { ompStats: runtime.supported } } },
      },
    }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: runtime.t, i18n: { language: "zh-CN" } }),
}));

let queryClient: QueryClient;

function snapshot(requests = 2, range: OmpStatsRange = "24h"): OmpStatsSnapshot {
  const metrics = {
    totalRequests: requests,
    failedRequests: requests === 0 ? 0 : 1,
    totalInputTokens: requests * 10,
    totalOutputTokens: requests * 20,
    totalCacheReadTokens: requests * 30,
    totalCacheWriteTokens: requests * 40,
    totalTokens: requests * 123,
    totalCostUsd: requests * 1.25,
    unpricedRequests: 0,
    transcriptCount: requests === 0 ? 0 : 1,
    firstTimestamp: requests === 0 ? null : 1_792_300_000_000,
    lastTimestamp: requests === 0 ? null : 1_792_300_000_000,
  };
  return {
    status: "available",
    source: "omp_stats_db",
    range,
    fetchedAt: "2026-10-18T12:00:00.000Z",
    scope: { kind: "host_profile", profile: "default" },
    indexedThrough: metrics.lastTimestamp,
    overall: metrics,
    byProvider: requests === 0 ? [] : [{ ...metrics, provider: "openai-codex" }],
    byModel: requests === 0 ? [] : [{ ...metrics, provider: "openai-codex", model: "gpt-5.4" }],
    byAgentType: requests === 0 ? [] : [{ ...metrics, agentType: "subagent" }],
  };
}
function page(serverId = "first") {
  return (
    <QueryClientProvider client={queryClient}>
      <OmpStatsSettingsSection serverId={serverId} />
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const i18n = createInstance();
  await i18n.init({
    lng: "zh-CN",
    fallbackLng: "en",
    resources: {
      en: { translation: { providerUsage: providerUsage.en } },
      "zh-CN": { translation: { providerUsage: providerUsage["zh-CN"] } },
    },
    interpolation: { escapeValue: false },
  });
  runtime.t = (key, options) => i18n.t(key, options);
  runtime.connected = true;
  runtime.supported = true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  runtime.clients = {};
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("keeps source-backed metrics accessible across breakdown tabs and collapsed index details", async () => {
  let resolve: (payload: StatsPayload) => void = () => {
    throw new Error("No pending request");
  };
  runtime.clients.first = {
    getOmpStats: vi.fn(
      () =>
        new Promise<StatsPayload>((done) => {
          resolve = done;
        }),
    ),
  };
  render(page());
  expect(screen.queryByTestId("omp-native-stats-summary")).toBeNull();
  expect(screen.getByTestId("omp-native-stats-refresh").getAttribute("aria-disabled")).toBe("true");
  resolve({ requestId: "stats", stats: snapshot() });
  await screen.findByTestId("omp-native-stats-summary");
  expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("2");
  expect(screen.getByTestId("omp-native-stats-failed").textContent).toBe("1");
  expect(screen.getByTestId("omp-native-stats-totalTokens").textContent).toBe("246");
  expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("US$2.50");
  expect(screen.getByTestId("omp-native-stats-transcripts").textContent).toBe("1");
  expect(screen.getByTestId("omp-native-stats-cacheWrite").textContent).toBe("80");
  expect(screen.queryByTestId("omp-native-stats-byModel")).toBeNull();
  expect(screen.queryByTestId("omp-native-stats-details")).toBeNull();

  fireEvent.click(screen.getByTestId("omp-native-stats-tab-byModel"));
  const model = within(screen.getByTestId("omp-native-stats-byModel-row"));
  expect(model.getByTestId("omp-native-stats-breakdown-label").textContent).toBe("gpt-5.4");
  expect(model.getByTestId("omp-native-stats-breakdown-provider").textContent).toBe("openai-codex");
  expect(model.getByTestId("omp-native-stats-breakdown-requests").textContent).toBe("2");
  expect(model.getByTestId("omp-native-stats-breakdown-tokens").textContent).toBe("246");
  expect(model.getByTestId("omp-native-stats-breakdown-cost").textContent).toBe("US$2.50");
  expect(screen.queryByTestId("omp-native-stats-byProvider")).toBeNull();

  fireEvent.click(screen.getByTestId("omp-native-stats-tab-byAgentType"));
  const agent = within(screen.getByTestId("omp-native-stats-byAgentType-row"));
  expect(agent.getByTestId("omp-native-stats-breakdown-requests").textContent).toBe("2");
  expect(screen.queryByTestId("omp-native-stats-byModel")).toBeNull();

  const toggle = screen.getByTestId("omp-native-stats-details-toggle");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByTestId("omp-native-stats-indexedThrough").textContent).toContain(
    new Date(snapshot().indexedThrough!).toLocaleString("zh-CN"),
  );
  expect(screen.getByTestId("omp-native-stats-fetchedAt").textContent).toContain(
    new Date(snapshot().fetchedAt).toLocaleString("zh-CN"),
  );
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByTestId("omp-native-stats-details")).toBeNull();
});

it.each([
  { input: 20, read: 60, write: 80, expected: "37.5%" },
  { input: 0, read: 80, write: 0, expected: "100.0%" },
  { input: 80, read: 0, write: 0, expected: "0.0%" },
  { input: 0, read: 0, write: 80, expected: "0.0%" },
  { input: 0, read: 0, write: 0, expected: "—" },
])(
  "calculates token cache hits for input=$input, read=$read, write=$write",
  async ({ input, read, write, expected }) => {
    const stats = snapshot();
    Object.assign(stats.overall, {
      totalInputTokens: input,
      totalCacheReadTokens: read,
      totalCacheWriteTokens: write,
      totalOutputTokens: 999_999,
      totalTokens: 1_234_567,
    });
    runtime.clients.first = { getOmpStats: async () => ({ requestId: "stats", stats }) };
    render(page());
    expect((await screen.findByTestId("omp-native-stats-cacheHitRate")).textContent).toBe(expected);
  },
);

it("distinguishes unpriced usage from a recorded zero in summary and breakdown costs", async () => {
  let cost = 0;
  let unpricedRequests = 2;
  runtime.clients.first = {
    getOmpStats: async () => {
      const stats = snapshot();
      for (const metrics of [
        stats.overall,
        ...stats.byModel,
        ...stats.byProvider,
        ...stats.byAgentType,
      ]) {
        metrics.totalCostUsd = cost;
        metrics.unpricedRequests = unpricedRequests;
      }
      return { requestId: "stats", stats };
    },
  };
  render(page());
  await screen.findByTestId("omp-native-stats-summary");
  expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("未定价");
  const row = within(screen.getByTestId("omp-native-stats-byProvider-row"));
  expect(row.getByTestId("omp-native-stats-breakdown-cost").textContent).toBe("未定价");
  expect(row.getByTestId("omp-native-stats-breakdown-unpriced").textContent).toContain("2");
  cost = 1.25;
  unpricedRequests = 1;
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("US$1.25"),
  );
  expect(row.getByTestId("omp-native-stats-breakdown-unpriced").textContent).toContain("1");
  cost = 0;
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("US$0.00"),
  );
  for (const group of ["byModel", "byProvider", "byAgentType"]) {
    fireEvent.click(screen.getByTestId(`omp-native-stats-tab-${group}`));
    const breakdown = within(screen.getByTestId(`omp-native-stats-${group}-row`));
    expect(breakdown.getByTestId("omp-native-stats-breakdown-cost").textContent).toBe("US$0.00");
    expect(breakdown.getByTestId("omp-native-stats-breakdown-unpriced").textContent).toContain("1");
  }
  unpricedRequests = 0;
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  await waitFor(() =>
    expect(screen.queryByTestId("omp-native-stats-breakdown-unpriced")).toBeNull(),
  );
  expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("US$0.00");
});

it("refreshes previously cached ranges from the same native index", async () => {
  let recent = 2;
  let all = 9;
  runtime.clients.first = {
    getOmpStats: async ({ range = "24h" } = {}) => ({
      requestId: "stats",
      stats: snapshot(range === "all" ? all : recent, range),
    }),
  };
  render(page());
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("2"),
  );
  fireEvent.click(screen.getByTestId("omp-native-stats-range-all"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("9"),
  );
  fireEvent.click(screen.getByTestId("omp-native-stats-range-24h"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("2"),
  );
  recent = 5;
  all = 12;
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("5"),
  );
  fireEvent.click(screen.getByTestId("omp-native-stats-range-all"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("12"),
  );
  expect(screen.getByTestId("omp-native-stats-totalTokens").textContent).toBe("1,476");
  expect(screen.getByTestId("omp-native-stats-cost").textContent).toBe("US$15.00");
});

it("does not leak a previous host's late result when switching hosts", async () => {
  let resolveFirst: (payload: StatsPayload) => void = () => {
    throw new Error("No pending request");
  };
  runtime.clients.first = {
    getOmpStats: () =>
      new Promise<StatsPayload>((done) => {
        resolveFirst = done;
      }),
  };
  runtime.clients.second = {
    getOmpStats: async () => ({ requestId: "second", stats: snapshot(9) }),
  };
  const rendered = render(page("first"));
  rendered.rerender(page("second"));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("9"),
  );
  resolveFirst({ requestId: "first", stats: snapshot(99) });
  await waitFor(() => expect(queryClient.getQueryData(["ompStats", "first", "24h"])).toBeTruthy());
  expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("9");
});

it("distinguishes missing and corrupt sources from indexed zero use in Chinese", async () => {
  const read = vi.fn<NonNullable<typeof runtime.clients.first>["getOmpStats"]>();
  read.mockResolvedValueOnce({
    requestId: "stats",
    stats: {
      status: "unavailable",
      reason: "missing",
      range: "24h",
      source: "omp_stats_db",
      fetchedAt: "2026-10-18T12:00:00.000Z",
      scope: { kind: "host_profile", profile: "default" },
    },
  });
  read.mockResolvedValueOnce({
    requestId: "stats",
    stats: {
      status: "error",
      reason: "unreadable",
      range: "24h",
      source: "omp_stats_db",
      fetchedAt: "2026-10-18T12:00:00.000Z",
      scope: { kind: "host_profile", profile: "default" },
    },
  });
  read.mockResolvedValueOnce({ requestId: "stats", stats: snapshot(0) });
  runtime.clients.first = { getOmpStats: read };
  render(page());
  await screen.findByText(/尚无原生统计索引/);
  expect(screen.queryByTestId("omp-native-stats-summary")).toBeNull();
  fireEvent.click(screen.getByText("重试"));
  await screen.findByText(/未使用零值代替/);
  fireEvent.click(screen.getByText("重试"));
  await screen.findByText("此时间范围内暂无已索引请求");
  expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("0");
  fireEvent.click(screen.getByTestId("omp-native-stats-details-toggle"));
  expect(screen.getByText("原生索引中暂无请求")).toBeTruthy();
});

it("marks a failed refresh instead of silently presenting an old snapshot as fresh", async () => {
  const read = vi
    .fn<NonNullable<typeof runtime.clients.first>["getOmpStats"]>()
    .mockResolvedValueOnce({ requestId: "stats", stats: snapshot(2) })
    .mockRejectedValueOnce(new Error("private raw transport error"));
  runtime.clients.first = { getOmpStats: read };
  render(page());
  await screen.findByTestId("omp-native-stats-summary");
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  await screen.findByText("刷新失败，当前仍显示上次读取的索引快照。");
  expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("2");
  expect(screen.queryByText(/private raw/)).toBeNull();
});

it("does not present cached zero use as fresh after native indexing times out", async () => {
  const read = vi
    .fn<NonNullable<typeof runtime.clients.first>["getOmpStats"]>()
    .mockResolvedValueOnce({ requestId: "stats", stats: snapshot(0) })
    .mockResolvedValueOnce({
      requestId: "stats",
      stats: {
        status: "error",
        reason: "index_refresh_timeout",
        range: "24h",
        source: "omp_stats_db",
        fetchedAt: "2026-10-23T12:00:00.000Z",
        scope: { kind: "host_profile", profile: "default" },
      },
    })
    .mockResolvedValueOnce({ requestId: "stats", stats: snapshot(4) });
  runtime.clients.first = { getOmpStats: read };
  render(page());
  await screen.findByTestId("omp-native-stats-summary");
  expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("0");
  fireEvent.click(screen.getByTestId("omp-native-stats-refresh"));
  const error = await screen.findByRole("alert");
  expect(screen.queryByTestId("omp-native-stats-summary")).toBeNull();
  expect(error.textContent).not.toContain("providerUsage.nativeStats");
  fireEvent.click(within(error).getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(screen.getByTestId("omp-native-stats-requests").textContent).toBe("4"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows connection/upgrade requirements without requesting native data", async () => {
  const read = vi.fn();
  runtime.clients.first = { getOmpStats: read };
  runtime.connected = false;
  const rendered = render(page());
  expect(screen.getByText("连接此主机后可查看其原生统计")).toBeTruthy();
  runtime.connected = true;
  runtime.supported = false;
  rendered.rerender(page());
  expect(screen.getByText("请更新此主机以启用原生统计")).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
});

it("rejects a mismatched response range instead of mislabeling its statistics", async () => {
  runtime.clients.first = {
    getOmpStats: async () => ({ requestId: "stats", stats: snapshot(2, "7d") }),
  };
  render(page());
  await screen.findByText("主机未能返回原生统计");
  expect(screen.queryByTestId("omp-native-stats-summary")).toBeNull();
});
