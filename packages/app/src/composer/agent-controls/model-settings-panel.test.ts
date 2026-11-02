import { describe, expect, it } from "vitest";
import type { AgentFeature } from "@omp-desktop/protocol/agent-types";
import { getFastModeTier, partitionModelFeatures } from "./utils";

describe("model settings feature partition", () => {
  it("moves fast mode into model settings without dropping or reordering other controls", () => {
    const features: AgentFeature[] = [
      {
        id: "web_search",
        label: "Web search",
        type: "toggle",
        value: true,
      },
      {
        id: "fast_mode",
        label: "Fast mode",
        description: "Lower latency",
        type: "toggle",
        value: false,
      },
      {
        id: "approval_policy",
        label: "Approval policy",
        type: "select",
        value: "ask",
        options: [{ id: "ask", label: "Ask" }],
      },
    ];

    const partitioned = partitionModelFeatures(features);

    expect(partitioned.fastMode).toBe(features[1]);
    expect(partitioned.remaining).toEqual([features[0], features[2]]);
  });

  it.each(["off", "on", "ultrafast"])("keeps the %s speed selection in model settings", (value) => {
    const speedFeature: AgentFeature = {
      id: "fast_mode",
      label: "Speed",
      type: "select",
      value,
      options: [
        { id: "off", label: "Standard" },
        { id: "on", label: "Fast" },
        { id: "ultrafast", label: "Ultrafast" },
      ],
    };
    const otherFeature: AgentFeature = {
      id: "web_search",
      label: "Web search",
      type: "toggle",
      value: false,
    };

    const partitioned = partitionModelFeatures([otherFeature, speedFeature]);

    expect(partitioned.fastMode).toBe(speedFeature);
    expect(getFastModeTier(partitioned.fastMode)).toBe(value);
    expect(partitioned.remaining).toEqual([otherFeature]);
  });

  it("keeps legacy boolean speeds and does not display unsupported tiers as Fast", () => {
    const legacyFeature: AgentFeature = {
      id: "fast_mode",
      label: "Fast",
      type: "toggle",
      value: false,
    };
    expect(getFastModeTier(legacyFeature)).toBe("off");
    expect(getFastModeTier({ ...legacyFeature, value: true })).toBe("on");
    expect(
      getFastModeTier({
        id: "fast_mode",
        label: "Speed",
        type: "select",
        value: "ultrafast",
        options: [
          { id: "off", label: "Standard" },
          { id: "on", label: "Fast" },
        ],
      }),
    ).toBeNull();
    expect(getFastModeTier(null)).toBeNull();
  });

  it("leaves ordinary controls untouched when fast mode is unavailable", () => {
    const features: AgentFeature[] = [
      { id: "web_search", label: "Web search", type: "toggle", value: false },
    ];

    expect(partitionModelFeatures(features)).toEqual({
      fastMode: null,
      remaining: features,
    });
  });
});
