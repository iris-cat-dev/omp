import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatAgentFeatureLabel,
  formatAgentFeatureOptionLabel,
  formatAgentModeLabel,
  formatThinkingOptionLabel,
} from "./labels";

describe("formatAgentModeLabel", () => {
  it("sentence-cases provider mode labels", () => {
    expect(formatAgentModeLabel({ id: "plan", label: "Plan" })).toBe("Plan");
    expect(formatAgentModeLabel({ id: "full-access", label: "Full Access" })).toBe("Full access");
    expect(formatAgentModeLabel({ id: "auto-review", label: "Auto-review" })).toBe("Auto-review");
    expect(formatAgentModeLabel({ id: "read_only", label: "read_only" })).toBe("Read only");
    expect(formatAgentModeLabel({ id: "acceptEdits", label: "acceptEdits" })).toBe("Accept edits");
  });

  it("splits compact mode ids when no provider label is available", () => {
    expect(formatAgentModeLabel({ id: "auto-review" })).toBe("Auto review");
  });
});

describe("formatThinkingOptionLabel", () => {
  it("formats compact thinking option labels for display", () => {
    expect(formatThinkingOptionLabel({ id: "none", label: "none" })).toBe("None");
    expect(formatThinkingOptionLabel({ id: "low", label: "low" })).toBe("Low");
    expect(formatThinkingOptionLabel({ id: "medium", label: "medium" })).toBe("Medium");
    expect(formatThinkingOptionLabel({ id: "high", label: "high" })).toBe("High");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "xhigh" })).toBe("Extra high");
  });

  it("sentence-cases split provider labels", () => {
    expect(formatThinkingOptionLabel({ id: "extra_high", label: "extra_high" })).toBe("Extra high");
    expect(formatThinkingOptionLabel({ id: "think-hard", label: "think-hard" })).toBe("Think hard");
    expect(formatThinkingOptionLabel({ id: "xhigh", label: "XHigh" })).toBe("Extra high");
  });
});

describe("localized agent control labels", () => {
  it("localizes thinking, permission mode, and workflow labels in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(formatThinkingOptionLabel({ id: "medium", label: "Medium" })).toBe("中");
      expect(formatAgentFeatureLabel({ id: "workflow_mode", label: "Workflow" })).toBe("工作流");
      expect(formatAgentFeatureLabel({ id: "fast_mode", label: "Fast mode" })).toBe("快速");
      expect(
        formatAgentFeatureLabel({
          id: "oauth_account_credential",
          label: "OAuth account",
        }),
      ).toBe("账号");
      expect(
        formatAgentFeatureOptionLabel("workflow_mode", {
          id: "standard",
          label: "Standard",
        }),
      ).toBe("标准");
      expect(
        formatAgentFeatureOptionLabel("workflow_mode", {
          id: "enhanced",
          label: "Enhanced",
        }),
      ).toBe("增强");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
