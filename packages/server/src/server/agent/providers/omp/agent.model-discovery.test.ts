import { setImmediate as waitForImmediate } from "node:timers/promises";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentSession } from "./agent.js";
import type { OmpSessionState } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6.1-sol",
  api: "openai-codex-responses",
  serviceTiers: ["priority", "ultrafast"],
};
const sessions: OmpAgentSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

async function discoverySession(live = true, enabled = false) {
  const fake = new FakeOmp();
  fake.setInitialModel({ ...model, serviceTiers: ["priority"] });
  const runtime = await fake.startSession({ cwd: "/repo" });
  runtime.state = {
    ...runtime.state,
    thinkingLevel: "high",
    fastModeEnabled: enabled,
    fastModeActive: enabled,
    fastModeTier: enabled ? "priority" : null,
  };
  runtime.nativeOpenAITier = runtime.state.fastModeTier;
  runtime.nativeUltrafastSupported = true;
  const config = {
    provider: "omp" as const,
    cwd: "/repo",
    model: `${model.provider}/${model.id}`,
    thinkingOptionId: "high",
    featureValues: { fast_mode: enabled },
  };
  const logger = pino({ level: "silent" });
  const session = new OmpAgentSession({
    runtimeSession: runtime,
    initialState: runtime.state,
    config,
    logger,
    live,
  });
  sessions.push(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  function discover() {
    runtime.state = { ...runtime.state, model, ultrafastSupported: true };
    runtime.emit({ type: "model_changed" });
  }
  function fastMode() {
    return session.features.find((feature) => feature.id === "fast_mode");
  }
  return { session, runtime, events, config, logger, discover, fastMode };
}

describe("OMP native model discovery", () => {
  test.each([
    { live: true, enabled: false },
    { live: false, enabled: true },
  ])("publishes confirmed speeds before agent_start: $live/$enabled", async ({ live, enabled }) => {
    const h = await discoverySession(live, enabled);
    expect(h.fastMode()).toMatchObject({ type: "toggle", value: enabled });
    h.discover();
    await waitForImmediate();
    expect(h.runtime.getStateRequestCount).toBe(1);
    expect(h.fastMode()).toMatchObject({
      type: "select",
      value: enabled ? "on" : "off",
      options: [{ id: "off" }, { id: "on" }, { id: "ultrafast" }],
    });
    expect(h.events).toEqual([
      { type: "features_changed", provider: "omp" },
      {
        type: "model_changed",
        provider: "omp",
        runtimeInfo: {
          provider: "omp",
          sessionId: h.runtime.state.sessionId,
          model: `${model.provider}/${model.id}`,
          thinkingOptionId: "high",
          modeId: "full",
        },
      },
    ]);
    expect(h.config.featureValues.fast_mode).toBe(enabled);
    expect(h.runtime.setModelRequests).toEqual([]);
    expect(h.runtime.setFastModeRequests).toEqual([]);
    expect(h.runtime.setFastModeTierRequests).toEqual([]);
    expect(h.runtime.prompts).toEqual([]);
    expect(h.runtime.steerRequests).toEqual([]);
    expect(h.runtime.followUpRequests).toEqual([]);
  });

  test("removes Ultrafast while preserving legacy Fast", async () => {
    const h = await discoverySession(false, true);
    h.discover();
    await waitForImmediate();
    h.events.length = 0;
    h.runtime.state = {
      ...h.runtime.state,
      model: { ...model, serviceTiers: ["priority"] },
      ultrafastSupported: false,
    };
    h.runtime.emit({ type: "model_changed" });
    await waitForImmediate();
    expect(h.fastMode()).toMatchObject({ type: "toggle", value: true });
    expect(h.events.map((event) => event.type)).toEqual(["features_changed", "model_changed"]);
    expect(h.runtime.setFastModeRequests).toEqual([]);
    expect(h.runtime.setFastModeTierRequests).toEqual([]);
  });

  test("hides unsupported native Ultrafast without demoting the tier", async () => {
    const h = await discoverySession();
    h.discover();
    await waitForImmediate();
    await h.session.setFeature("fast_mode", "ultrafast");
    h.events.length = 0;
    h.runtime.state = { ...h.runtime.state, ultrafastSupported: false, fastModeActive: false };
    h.runtime.emit({ type: "model_changed" });
    await waitForImmediate();
    expect(h.fastMode()).toBeUndefined();
    expect(h.runtime.state.fastModeTier).toBe("ultrafast");
    expect(h.runtime.setFastModeTierRequests).toEqual(["ultrafast"]);
    expect(h.events.map((event) => event.type)).toEqual(["features_changed", "model_changed"]);
  });

  test("does not enable catalog-only capability and reports readback failures", async () => {
    const h = await discoverySession();
    const warning = vi.spyOn(h.logger, "warn");
    h.runtime.state = { ...h.runtime.state, model };
    h.runtime.emit({ type: "model_changed" });
    await waitForImmediate();
    expect(h.fastMode()).toMatchObject({ type: "toggle", value: false });
    expect(h.events.map((event) => event.type)).toEqual(["model_changed"]);
    h.events.length = 0;
    const error = new Error("Native state unavailable");
    h.runtime.getStateError = error;
    h.discover();
    await waitForImmediate();
    expect(h.fastMode()).toMatchObject({ type: "toggle", value: false });
    expect(h.events).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toEqual({ err: error });
  });

  test.each(["model", "tier", "thinking"] as const)(
    "serializes a held discovery readback before a later %s selection",
    async (selection) => {
      const h = await discoverySession();
      const held = Promise.withResolvers<OmpSessionState>();
      const started = Promise.withResolvers<void>();
      const reader = vi.spyOn(h.runtime, "getState").mockImplementationOnce(() => {
        started.resolve();
        return held.promise;
      });
      h.discover();
      const snapshot = structuredClone(h.runtime.state);
      await started.promise;
      h.runtime.setModelResult = {
        provider: "anthropic",
        id: "claude-opus-5-5",
        api: "anthropic-messages",
      };
      let change: Promise<void>;
      switch (selection) {
        case "model":
          change = h.session.setModel("anthropic/claude-opus-5-5");
          break;
        case "tier":
          change = h.session.setFeature("fast_mode", "on");
          break;
        case "thinking":
          change = h.session.setThinkingOption("low");
          break;
      }
      await Promise.resolve();
      expect(h.runtime.setModelRequests).toEqual([]);
      expect(h.runtime.setFastModeTierRequests).toEqual([]);
      expect(h.runtime.state.thinkingLevel).toBe("high");
      held.resolve(snapshot);
      await change;
      const info = await h.session.getRuntimeInfo();
      expect(info.model).toBe(
        selection === "model" ? "anthropic/claude-opus-5-5" : `${model.provider}/${model.id}`,
      );
      expect(info.thinkingOptionId).toBe(selection === "thinking" ? "low" : "high");
      expect(h.fastMode()).toMatchObject({
        value: { model: false, tier: "on", thinking: "off" }[selection],
      });
      reader.mockRestore();
    },
  );

  test("reads the confirmed model after discovery arrives during a model switch", async () => {
    const h = await discoverySession();
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const original = h.runtime.setModel.bind(h.runtime);
    vi.spyOn(h.runtime, "setModel").mockImplementationOnce(async (provider, id) => {
      started.resolve();
      await held.promise;
      return original(provider, id);
    });
    h.runtime.setModelResult = { provider: "custom-openai", id: "other" };
    const change = h.session.setModel("custom-openai/other");
    await started.promise;
    h.discover();
    await Promise.resolve();
    expect(h.runtime.getStateRequestCount).toBe(0);
    held.resolve();
    await change;
    await waitForImmediate();
    expect(h.fastMode()).toBeUndefined();
    expect(h.events.filter((event) => event.type === "model_changed")).toEqual([
      {
        type: "model_changed",
        provider: "omp",
        runtimeInfo: expect.objectContaining({ model: "custom-openai/other" }),
      },
    ]);
    expect(h.events.filter((event) => event.type === "timeline")).toEqual([]);
  });

  test("discards a pre-control state read after model selection", async () => {
    const h = await discoverySession();
    const held = Promise.withResolvers<OmpSessionState>();
    const snapshot = structuredClone(h.runtime.state);
    vi.spyOn(h.runtime, "getState").mockImplementationOnce(() => held.promise);
    const staleInfo = h.session.getRuntimeInfo();
    h.runtime.setModelResult = { provider: "custom-openai", id: "other" };
    await h.session.setModel("custom-openai/other");
    held.resolve(snapshot);
    expect(await staleInfo).toMatchObject({ model: "custom-openai/other" });
  });

  test.each(["close", "unload"] as const)(
    "suppresses queued discovery during %s",
    async (lifecycle) => {
      const h = await discoverySession();
      const reader = vi.spyOn(h.runtime, "getState");
      h.discover();
      const release = lifecycle === "unload" ? h.session.beginRuntimeUnload() : undefined;
      if (lifecycle === "close") await h.session.close();
      await waitForImmediate();
      expect(reader).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
      release?.();
    },
  );

  test.each(["close", "unload"] as const)(
    "discards in-flight discovery after %s",
    async (lifecycle) => {
      const h = await discoverySession();
      const held = Promise.withResolvers<OmpSessionState>();
      const started = Promise.withResolvers<void>();
      vi.spyOn(h.runtime, "getState").mockImplementationOnce(() => {
        started.resolve();
        return held.promise;
      });
      h.discover();
      const snapshot = structuredClone(h.runtime.state);
      await started.promise;
      if (lifecycle === "close") await h.session.close();
      else h.session.beginRuntimeUnload()();
      held.resolve(snapshot);
      await waitForImmediate();
      expect(h.fastMode()).toMatchObject({ type: "toggle", value: false });
      expect(h.events).toEqual([]);
      h.runtime.emit({ type: "model_changed" });
      await waitForImmediate();
      expect(h.events.map((event) => event.type)).toEqual(
        lifecycle === "close" ? [] : ["features_changed", "model_changed"],
      );
    },
  );
});
