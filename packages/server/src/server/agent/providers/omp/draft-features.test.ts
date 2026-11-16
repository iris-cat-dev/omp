import { describe, expect, test } from "vitest";
import { createOmpDraftFeatures } from "./agent.js";
import { mapOmpModel } from "./map-omp-model.js";
import type { OmpModel } from "./rpc-types.js";

const model: OmpModel = {
  provider: "openai-codex",
  id: "catalog-supplied-model",
  api: "openai-codex-responses",
  serviceTiers: ["priority", "ultrafast"],
};
const apiModel: OmpModel = {
  provider: "custom-openai",
  id: "gpt-api",
  identity: { class: "openai" },
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};

describe("OMP catalog draft features", () => {
  test("offers all advertised speed choices without needing an active session", () => {
    const features = createOmpDraftFeatures({
      model,
      capabilities: { fastMode: true, ultrafast: true },
    });
    const speed = features.find((feature) => feature.id === "fast_mode");
    expect(speed).toMatchObject({ type: "select", value: "off" });
    expect(speed?.type === "select" && speed.options.map((option) => option.id)).toEqual([
      "off",
      "on",
      "ultrafast",
    ]);
    expect(features.map((feature) => feature.id)).toEqual(["workflow_mode", "fast_mode"]);
    expect(features.find((feature) => feature.id === "workflow_mode")?.value).toBe("standard");
    expect(mapOmpModel(model, "omp").metadata?.serviceTiers).toEqual(["priority", "ultrafast"]);
  });
  test.each([
    apiModel,
    { ...apiModel, api: "openai-completions" },
    { ...apiModel, baseUrl: "https://gateway.example/v1", serviceTiers: ["ultrafast"] },
  ])("offers API speed choices from catalog capability alone: $api/$baseUrl", (candidate) => {
    const features = createOmpDraftFeatures({
      model: candidate,
      capabilities: { fastMode: true, ultrafast: true },
    });
    expect(features.find((feature) => feature.id === "fast_mode")).toMatchObject({
      type: "select",
      value: "off",
      options: [{ id: "off" }, { id: "on" }, { id: "ultrafast" }],
    });
  });

  test.each([
    { candidate: apiModel, nativeUltra: false },
    { candidate: { ...apiModel, baseUrl: "https://gateway.example/v1" }, nativeUltra: true },
    { candidate: { ...apiModel, serviceTiers: [] }, nativeUltra: true },
    { candidate: { ...apiModel, serviceTiers: ["priority"] }, nativeUltra: true },
    {
      candidate: { ...apiModel, baseUrl: "https://api.openai.com.evil.example/v1" },
      nativeUltra: true,
    },
  ])("keeps ordinary API Fast when Ultrafast is unavailable", ({ candidate, nativeUltra }) => {
    const features = createOmpDraftFeatures({
      model: candidate,
      capabilities: { fastMode: true, ultrafast: nativeUltra },
    });
    expect(features.find((feature) => feature.id === "fast_mode")).toMatchObject({
      type: "toggle",
      value: false,
    });
  });

  test.each([
    { candidate: { ...model, serviceTiers: ["priority"] }, nativeUltra: true },
    { candidate: { ...model, serviceTiers: undefined }, nativeUltra: true },
    { candidate: model, nativeUltra: false },
  ])(
    "retains the legacy two-state control without both Ultrafast capabilities",
    ({ candidate, nativeUltra }) => {
      const features = createOmpDraftFeatures({
        model: candidate,
        capabilities: { fastMode: true, ultrafast: nativeUltra },
      });
      expect(features.find((feature) => feature.id === "fast_mode")).toMatchObject({
        type: "toggle",
        value: false,
      });
    },
  );

  test.each([
    { candidate: model, fastMode: false },
    { candidate: { ...model, provider: "github-copilot" }, fastMode: true },
    { candidate: { ...model, provider: "fireworks" }, fastMode: true },
    { candidate: { ...model, provider: "openrouter", api: "openai-completions" }, fastMode: true },
  ])("does not advertise unsupported speed controls", ({ candidate, fastMode }) => {
    expect(
      createOmpDraftFeatures({
        model: candidate,
        capabilities: { fastMode, ultrafast: true },
      }).map((feature) => feature.id),
    ).toEqual(["workflow_mode"]);
  });
});
