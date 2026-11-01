import { describe, expect, it } from "vitest";
import type { AgentFeature } from "@omp-desktop/protocol/agent-types";

import {
  applyFeatureValues,
  pruneFeatureValues,
  resolveFeatureValues,
  retainDraftWorkflowValues,
} from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];
  const speedFeature: AgentFeature = {
    id: "fast_mode",
    label: "Speed",
    type: "select",
    value: "off",
    options: [
      { id: "off", label: "Standard" },
      { id: "on", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
    ],
  };

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });

  it.each([
    [false, "off"],
    [true, "on"],
  ])("normalizes saved boolean %s for the speed select", (storedValue, expectedValue) => {
    const values = { fast_mode: storedValue };
    expect(
      resolveFeatureValues({
        features: [speedFeature],
        persistedFeatureValues: values,
        localFeatureValues: {},
      }),
    ).toEqual({ fast_mode: expectedValue });
    expect(pruneFeatureValues(values, [speedFeature])).toEqual({
      fast_mode: expectedValue,
    });
    expect(applyFeatureValues([speedFeature], values)[0]).toMatchObject({
      type: "select",
      value: expectedValue,
    });
  });

  it.each(["off", "on", "ultrafast"])("retains the selected %s id without coercion", (value) => {
    const resolved = resolveFeatureValues({
      features: [speedFeature],
      persistedFeatureValues: {},
      localFeatureValues: { fast_mode: value },
    });
    expect(resolved).toEqual({ fast_mode: value });
    expect(applyFeatureValues([speedFeature], resolved)[0]).toMatchObject({ value });
  });

  it("preserves unavailable Ultrafast without applying it or falling back to saved Fast", () => {
    const values = { fast_mode: "ultrafast" };
    for (const availableFeatures of [[], [features[0]]]) {
      const retained = pruneFeatureValues(values, availableFeatures);
      const resolved = resolveFeatureValues({
        features: availableFeatures,
        persistedFeatureValues: { fast_mode: true },
        localFeatureValues: retained,
      });
      expect(retained).toBe(values);
      expect(resolved).toEqual({});
      expect(applyFeatureValues(availableFeatures, retained)).toEqual(availableFeatures);
    }
    const restored = resolveFeatureValues({
      features: [speedFeature],
      persistedFeatureValues: {},
      localFeatureValues: values,
    });
    expect(restored).toEqual({ fast_mode: "ultrafast" });
    expect(applyFeatureValues([speedFeature], restored)[0]).toMatchObject({
      value: "ultrafast",
    });
  });

  it("does not enable a speed tier without an explicit preference", () => {
    const resolved = resolveFeatureValues({
      features: [speedFeature],
      persistedFeatureValues: {},
      localFeatureValues: {},
    });
    expect(resolved).toEqual({});
    expect(applyFeatureValues([speedFeature], resolved)[0]).toBe(speedFeature);
  });

  it.each([
    ["off", false],
    ["on", true],
  ])("adapts the %s standard/Fast id to existing boolean providers", (value, expectedValue) => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: { fast_mode: value },
        localFeatureValues: {},
      }),
    ).toEqual({ fast_mode: expectedValue });
    expect(applyFeatureValues(features, { fast_mode: value })[0].value).toBe(expectedValue);
  });

  it("clears a stale effective selection when a draft select value changes", () => {
    const accountFeature = {
      type: "select" as const,
      id: "oauth_account_credential",
      label: "OAuth account",
      value: "automatic",
      effectiveValue: "1",
      options: [
        { id: "automatic", label: "Automatic" },
        { id: "1", label: "Account 1" },
        { id: "2", label: "Account 2" },
      ],
    };

    expect(
      applyFeatureValues([accountFeature], {
        oauth_account_credential: "2",
      }),
    ).toEqual([
      {
        ...accountFeature,
        value: "2",
        effectiveValue: null,
      },
    ]);
    expect(
      applyFeatureValues([accountFeature], {
        oauth_account_credential: "automatic",
      }),
    ).toEqual([accountFeature]);
  });

  it("keeps transient goal draft values alongside the workflow feature", () => {
    const values = {
      workflow_mode: "goal",
      goal_objective: "Ship the goal bar",
      goal_status: "active",
      unknown_feature: true,
    };
    const workflowFeatures = [
      {
        type: "select" as const,
        id: "workflow_mode",
        label: "Workflow",
        value: "standard",
        options: [],
      },
    ];

    expect(pruneFeatureValues(values, workflowFeatures)).toEqual({
      workflow_mode: "goal",
      goal_objective: "Ship the goal bar",
      goal_status: "active",
    });
    expect(
      resolveFeatureValues({
        features: workflowFeatures,
        persistedFeatureValues: {},
        localFeatureValues: values,
      }),
    ).toEqual({
      workflow_mode: "goal",
      goal_objective: "Ship the goal bar",
      goal_status: "active",
    });
  });

  it("retains an in-progress goal while the selected provider settles", () => {
    expect(
      retainDraftWorkflowValues({
        workflow_mode: "goal",
        goal_objective: "Ship the goal bar",
        workflow_locale: "zh-CN",
        fast_mode: true,
      }),
    ).toEqual({
      workflow_mode: "goal",
      goal_objective: "Ship the goal bar",
      workflow_locale: "zh-CN",
    });
  });
});
