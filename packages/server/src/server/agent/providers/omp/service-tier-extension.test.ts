import { afterEach, describe, expect, test, vi } from "vitest";
import desktopServiceTier, {
  applyNativeServiceTier,
  readNativeServiceTier,
  type NativeServiceTierApi,
} from "./service-tier-extension.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6.1-sol",
  api: "openai-codex-responses",
  serviceTiers: ["priority", "ultrafast"],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createNative() {
  const tiers: Record<string, string | undefined> = { anthropic: "priority" };
  const api: NativeServiceTierApi = {
    on: vi.fn(),
    getServiceTiers: () => ({ ...tiers }),
    setServiceTier: vi.fn<NonNullable<NativeServiceTierApi["setServiceTier"]>>((family, tier) => {
      tiers[family] = tier;
    }),
  };
  return { api, tiers };
}

async function startBridge() {
  const native = createNative();
  let currentModel = { ...model };
  const context = {
    get model() {
      return currentModel;
    },
    set model(value) {
      currentModel = value;
    },
  };
  let start!: (event: unknown, ctx: typeof context) => Promise<void>;
  let shutdown!: () => void;
  native.api.on = (event, handler) => {
    if (event === "session_start") start = handler as typeof start;
    else shutdown = handler as () => void;
  };
  vi.stubEnv("OMP_DESKTOP_SERVICE_TIER_TOKEN", "private-tier-token");
  let port = 0;
  const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const message = JSON.parse(String(chunk)) as { port: number };
    port = message.port;
    return true;
  });
  try {
    desktopServiceTier(native.api);
    await start(undefined, context);
    cleanups.push(shutdown);
  } finally {
    output.mockRestore();
  }
  const request = (init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/tier`, {
      ...init,
      headers: { authorization: "Bearer private-tier-token", ...init?.headers },
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
  return { ...native, context, request };
}

describe("native OMP service tier control", () => {
  test("reads Ultrafast rather than the lossy enabled boolean and preserves other families", () => {
    const { api, tiers } = createNative();
    tiers.openai = "ultrafast";
    expect(readNativeServiceTier(api, model)).toEqual({
      available: true,
      model: { provider: model.provider, id: model.id },
      openaiFamily: true,
      tier: "ultrafast",
      ultrafastAvailable: true,
    });
    const result = applyNativeServiceTier(api, model, model, "on");
    expect(result.tier).toBe("priority");
    expect(tiers.anthropic).toBe("priority");
    expect(api.setServiceTier).toHaveBeenCalledTimes(1);
    expect(api.setServiceTier).toHaveBeenCalledWith("openai", "priority");
  });

  test("uses one native operation per mutually exclusive choice", () => {
    const { api, tiers } = createNative();
    for (const [selection, tier] of [
      ["ultrafast", "ultrafast"],
      ["on", "priority"],
      ["off", null],
    ] as const) {
      expect(applyNativeServiceTier(api, model, model, selection).tier).toBe(tier);
    }
    expect(api.setServiceTier).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.setServiceTier!).mock.calls).toEqual([
      ["openai", "ultrafast"],
      ["openai", "priority"],
      ["openai", undefined],
    ]);
    expect(tiers.anthropic).toBe("priority");
  });

  test.each([
    { ...model, serviceTiers: ["priority"] },
    { ...model, serviceTiers: undefined },
    { ...model, provider: "github-copilot" },
    { ...model, provider: "openrouter", api: "openai-completions", identity: { class: "openai" } },
  ])("rejects unadvertised or unrealizable Ultrafast for $provider", (unsupported) => {
    const { api, tiers } = createNative();
    tiers.openai = "priority";
    expect(() => applyNativeServiceTier(api, unsupported, unsupported, "ultrafast")).toThrow(
      "unavailable",
    );
    expect(tiers.openai).toBe("priority");
    expect(api.setServiceTier).not.toHaveBeenCalled();
  });

  test("rejects stale model identities and unsupported priority without changing tiers", () => {
    const { api, tiers } = createNative();
    expect(() =>
      applyNativeServiceTier(api, model, { ...model, id: "older" }, "ultrafast"),
    ).toThrow("model changed");
    const onlyUltra = { ...model, serviceTiers: ["ultrafast"] };
    expect(() => applyNativeServiceTier(api, onlyUltra, onlyUltra, "on")).toThrow(
      "Fast is unavailable",
    );
    tiers.openai = "flex";
    expect(readNativeServiceTier(api, model).tier).toBe("flex");
    expect(() => applyNativeServiceTier(api, model, model, "off")).toThrow(
      "outside the Fast selector",
    );
    expect(tiers.openai).toBe("flex");
    expect(api.setServiceTier).not.toHaveBeenCalled();
  });

  test("does not claim that missing APIs, thrown setters, or ignored updates succeeded", () => {
    const { api, tiers } = createNative();
    expect(readNativeServiceTier({ on: vi.fn() }, model).available).toBe(false);
    expect(() => applyNativeServiceTier({ on: vi.fn() }, model, model, "ultrafast")).toThrow(
      "unavailable",
    );
    vi.mocked(api.setServiceTier!).mockImplementationOnce(() => {
      throw new Error("Native failure");
    });
    expect(() => applyNativeServiceTier(api, model, model, "ultrafast")).toThrow("Native failure");
    vi.mocked(api.setServiceTier!).mockImplementationOnce(() => {});
    expect(() => applyNativeServiceTier(api, model, model, "ultrafast")).toThrow("did not apply");
    expect(tiers.openai).toBeUndefined();
  });

  test("authenticates private HTTP reads and writes without retaining its token in env", async () => {
    const h = await startBridge();
    expect(process.env.OMP_DESKTOP_SERVICE_TIER_TOKEN).toBeUndefined();
    expect((await h.request({ headers: { authorization: "Bearer wrong" } })).status).toBe(403);
    expect((await h.request({ headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await h.request()).status).toBe(200);
    const response = await h.request({
      method: "POST",
      body: JSON.stringify({ value: "ultrafast", model }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tier: "ultrafast", ultrafastAvailable: true });
    expect(h.tiers.openai).toBe("ultrafast");
  });

  test("rejects invalid, oversized, or model-raced HTTP updates without applying them", async () => {
    const h = await startBridge();
    for (const value of [true, ["ultrafast"], "ultra", null]) {
      expect(
        (await h.request({ method: "POST", body: JSON.stringify({ value, model }) })).status,
      ).toBe(400);
    }
    expect((await h.request({ method: "POST", body: " ".repeat(1025) })).status).toBe(400);
    h.context.model = { ...model, id: "changed" };
    expect(await (await h.request()).json()).toMatchObject({ model: { id: "changed" } });
    const response = await h.request({
      method: "POST",
      body: JSON.stringify({ value: "ultrafast", model }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "OMP model changed before the service tier update",
    });
    expect(h.api.setServiceTier).not.toHaveBeenCalled();
  });
});
