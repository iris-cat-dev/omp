import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { findModelByReference, getModelDraftFeatures } from "./model-catalog";

describe("findModelByReference", () => {
  it("prefers an exact model id over another model's alias", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "canonical-model",
        label: "Canonical model",
        aliases: ["gateway-model"],
      },
      {
        provider: "claude",
        id: "gateway-model",
        label: "Exact gateway model",
      },
    ];

    expect(findModelByReference(models, "gateway-model")?.label).toBe("Exact gateway model");
  });
});

describe("getModelDraftFeatures", () => {
  it("honors capability metadata after an OMP provider is renamed by the registry", () => {
    const model: AgentModelDefinition = {
      provider: "custom-omp",
      id: "provider/model",
      label: "Model",
      metadata: { draftFeatures: [] },
    };
    expect(
      getModelDraftFeatures(model, [
        { id: "fast_mode", label: "Fast", type: "toggle", value: true },
        { id: "other_feature", label: "Other", type: "toggle", value: false },
      ]),
    ).toEqual([{ id: "other_feature", label: "Other", type: "toggle", value: false }]);
  });
});
