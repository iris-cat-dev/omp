// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeOutputMetrics } from "@omp-desktop/protocol/agent-types";
import type { PluginTurnMetricProps } from "@omp-desktop/plugin";
import { TurnMetrics } from "./turn-metrics";
import { createActivationScope } from "@omp-desktop/plugin/host";
import { setupPluginClient } from "./context";
import { pluginClientRegistry, type PluginClientInstance } from "./registry";

vi.mock("./view", () => ({
  PluginView: ({ children }: { children: React.ReactNode }) => children,
}));

const NOW = 1_800_000_000_000;
const native: AgentNativeOutputMetrics = {
  generation: 1,
  phase: "idle",
  inFlightStartMs: null,
  lastActivityMs: NOW,
  latestEndMs: NOW,
  measuredOutputTokens: 1_000,
  measuredDurationMs: 10_000,
  recentRequests: [{ startMs: NOW - 10_000, endMs: NOW, outputTokens: 1_000 }],
  agentReferences: [],
  modelReferences: [],
};
const props: PluginTurnMetricProps = {
  hostId: "host-a",
  agentId: "agent-a",
  turnId: "turn-a",
  visible: true,
  active: false,
  cancelling: false,
  recordedUsage: { scope: "turn", outputTokens: 1_500, nativeMetrics: native },
  replayedUsage: null,
};

const instances: PluginClientInstance[] = [];
const unavailable = (): never => {
  throw new Error("Unexpected host API access");
};

async function installSpeed(hostId: string, owner: "desktop" | "daemon") {
  const instance = await setupPluginClient({
    hostId,
    installation: {
      id: "speed",
      packageId: "fixture",
      owner,
      version: "1.0.0",
      generation: 1,
      enabled: true,
      declaredCapabilities: [],
      grantedCapabilities: [],
    },
    mode: "active",
    format: "package",
    scope: createActivationScope(1),
    services: {
      getOmp: unavailable,
      storage: { get: async () => unavailable(), patch: async () => unavailable() },
      secrets: {
        configured: async () => unavailable(),
        set: async () => unavailable(),
        delete: async () => unavailable(),
      },
      native: { invoke: async () => unavailable(), subscribe: unavailable },
      invoke: async () => unavailable(),
    },
    setup(ctx) {
      ctx.addTurnMetric({
        id: "output-speed",
        component: () => <span data-testid="plugin-speed">Plugin throughput</span>,
      });
    },
  });
  if (!instance) throw new Error("Metric activation was cancelled");
  instances.push(instance);
  pluginClientRegistry.replace(instance);
  return instance;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await Promise.all(
    instances.splice(0).map(async (instance) => {
      pluginClientRegistry.remove(instance.key, instance.scope);
      await instance.scope.dispose();
    }),
  );
});

describe("conversation output speed without optional plugins", () => {
  it("shows completed throughput from measured requests, excluding untimed output", () => {
    render(<TurnMetrics {...props} />);
    expect(screen.getByTestId("turn-avg-speed").textContent).toContain("100 t/s");
  });

  it("replaces partial live facts with authoritative replay and keeps missing timing unknown", () => {
    const replayedUsage: PluginTurnMetricProps["replayedUsage"] = {
      scope: "turn",
      outputTokens: 600,
      nativeMetrics: { ...native, measuredOutputTokens: 500 },
    };
    const untimedReplay: PluginTurnMetricProps["replayedUsage"] = {
      scope: "turn",
      outputTokens: 600,
    };
    const sessionReplay: PluginTurnMetricProps["replayedUsage"] = {
      scope: "session",
      outputTokens: 9000,
    };
    const view = render(React.createElement(TurnMetrics, { ...props, replayedUsage }));
    expect(screen.getByTestId("turn-avg-speed").textContent).toContain("50.0 t/s");
    view.rerender(React.createElement(TurnMetrics, { ...props, replayedUsage: untimedReplay }));
    expect(screen.queryByTestId("turn-avg-speed")).toBeNull();
    view.rerender(React.createElement(TurnMetrics, { ...props, replayedUsage: sessionReplay }));
    expect(screen.getByTestId("turn-avg-speed").textContent).toContain("100 t/s");
  });

  it("updates the live window, then keeps the completed request average", () => {
    const view = render(<TurnMetrics {...props} active />);
    expect(screen.getByTestId("turn-token-output-speed").textContent).toContain("100 t/s");
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("turn-token-output-speed").textContent).toContain("50.0 t/s");
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByTestId("turn-token-output-speed")).toBeNull();
    view.rerender(<TurnMetrics {...props} />);
    expect(screen.getByTestId("turn-avg-speed").textContent).toContain("100 t/s");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("labels an in-flight estimate and does not carry it across turns or cancellation", () => {
    const generating = {
      ...native,
      phase: "generating" as const,
      inFlightStartMs: NOW - 1500,
      latestEndMs: null,
      recentRequests: [],
      agentReferences: native.recentRequests,
    };
    const recordedUsage: PluginTurnMetricProps["recordedUsage"] = {
      scope: "turn",
      nativeMetrics: generating,
    };
    const view = render(
      React.createElement(TurnMetrics, { ...props, active: true, recordedUsage }),
    );
    expect(screen.getByTestId("turn-token-output-speed").getAttribute("aria-label")).toBe(
      "50.0 t/s, Estimated",
    );
    view.rerender(
      React.createElement(TurnMetrics, { ...props, active: true, cancelling: true, recordedUsage }),
    );
    expect(screen.queryByTestId("turn-token-output-speed")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<TurnMetrics {...props} active turnId="turn-b" recordedUsage={null} />);
    expect(screen.queryByTestId("turn-token-output-speed")).toBeNull();
  });

  it("pauses hidden conversations and resumes with the current native window", () => {
    const view = render(<TurnMetrics {...props} active />);
    view.rerender(<TurnMetrics {...props} active visible={false} />);
    expect(screen.queryByTestId("turn-token-output-speed")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(4000));
    view.rerender(<TurnMetrics {...props} active />);
    expect(screen.queryByTestId("turn-token-output-speed")).toBeNull();
  });

  it("rejects session aggregates and invalid completed request timing", () => {
    const sessionUsage: PluginTurnMetricProps["recordedUsage"] = {
      ...props.recordedUsage,
      scope: "session",
    };
    const view = render(
      React.createElement(TurnMetrics, { ...props, recordedUsage: sessionUsage }),
    );
    expect(screen.queryByTestId("turn-avg-speed")).toBeNull();
    for (const patch of [
      { measuredDurationMs: 0 },
      { measuredDurationMs: 499 },
      { measuredDurationMs: Number.NaN },
      { measuredOutputTokens: 1501 },
    ]) {
      const recordedUsage: PluginTurnMetricProps["recordedUsage"] = {
        scope: "turn",
        outputTokens: 1500,
        nativeMetrics: { ...native, ...patch },
      };
      view.rerender(React.createElement(TurnMetrics, { ...props, recordedUsage }));
      expect(screen.queryByTestId("turn-avg-speed")).toBeNull();
    }
  });

  it.each(["desktop", "daemon"] as const)(
    "preserves a matching %s speed plugin without duplicate built-in speed",
    async (owner) => {
      const instance = await installSpeed(owner === "desktop" ? "desktop" : "host-a", owner);
      render(<TurnMetrics {...props} />);
      expect(screen.getByTestId("plugin-speed")).toBeTruthy();
      expect(screen.queryByTestId("turn-avg-speed")).toBeNull();
      act(() => pluginClientRegistry.remove(instance.key, instance.scope));
      expect(screen.queryByTestId("plugin-speed")).toBeNull();
      expect(screen.getByTestId("turn-avg-speed").textContent).toContain("100 t/s");
    },
  );

  it("ignores another daemon's speed plugin", async () => {
    await installSpeed("host-b", "daemon");
    render(<TurnMetrics {...props} />);
    expect(screen.queryByTestId("plugin-speed")).toBeNull();
    expect(screen.getByTestId("turn-avg-speed").textContent).toContain("100 t/s");
  });
});
