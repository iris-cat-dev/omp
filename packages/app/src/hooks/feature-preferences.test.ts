import { describe, expect, it } from "vitest";

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
