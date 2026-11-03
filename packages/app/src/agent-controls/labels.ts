import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { FAST_MODE_FEATURE_ID } from "@/agent-controls/policy";

interface ControlLabelInput {
  id: string;
  label?: string | null;
}

function sentenceCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function splitCompactLabel(value: string, splitHyphen: boolean): string {
  const separatorPattern = splitHyphen ? /[_-]+/g : /_+/g;

  return value
    .replace(separatorPattern, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function formatControlLabel(option: ControlLabelInput, splitHyphen: boolean): string {
  const rawLabel = (option.label ?? option.id).trim();
  return sentenceCase(splitCompactLabel(rawLabel, splitHyphen));
}

function translateKnownMode(compactValue: string): string | null {
  switch (compactValue) {
    case "ask":
    case "alwaysask":
      return i18n.t("agentControls.mode.options.alwaysAsk");
    case "full":
      return i18n.t("agentControls.mode.options.autoApproval");
    case "fullaccess":
      return i18n.t("agentControls.mode.options.fullAccess");
    case "auto":
      return i18n.t("agentControls.mode.options.auto");
    case "plan":
    case "planmode":
      return i18n.t("agentControls.mode.options.plan");
    case "default":
      return i18n.t("agentControls.mode.options.default");
    case "acceptedits":
      return i18n.t("agentControls.mode.options.acceptEdits");
    case "bypasspermissions":
      return i18n.t("agentControls.mode.options.bypassPermissions");
    case "build":
      return i18n.t("agentControls.mode.options.build");
    default:
      return null;
  }
}

export function formatAgentModeLabel(mode: ControlLabelInput): string {
  const rawLabel = (mode.label ?? mode.id).trim();
  const compactId = mode.id.replace(/[\s_-]+/g, "").toLowerCase();
  const compactLabel = rawLabel.replace(/[\s_-]+/g, "").toLowerCase();
  return (
    translateKnownMode(compactId) ??
    translateKnownMode(compactLabel) ??
    formatControlLabel(mode, mode.label == null)
  );
}

export function formatThinkingOptionLabel(option: ControlLabelInput): string {
  const rawLabel = (option.label ?? option.id).trim();
  const compactId = option.id.replace(/[\s_-]+/g, "").toLowerCase();
  const compactLabel = rawLabel.replace(/[\s_-]+/g, "").toLowerCase();

  switch (compactId) {
    case "off":
      return i18n.t("agentControls.thinking.options.off");
    case "minimal":
      return i18n.t("agentControls.thinking.options.minimal");
    case "low":
      return i18n.t("agentControls.thinking.options.low");
    case "medium":
      return i18n.t("agentControls.thinking.options.medium");
    case "high":
      return i18n.t("agentControls.thinking.options.high");
    case "xhigh":
      return i18n.t("agentControls.thinking.extraHigh");
    case "max":
      return i18n.t("agentControls.thinking.options.max");
  }
  if (compactLabel === "xhigh") {
    return i18n.t("agentControls.thinking.extraHigh");
  }

  return formatControlLabel(option, true);
}

export function formatAgentFeatureLabel(feature: ControlLabelInput & { type?: string }): string {
  if (feature.id === FAST_MODE_FEATURE_ID) {
    return i18n.t(
      feature.type === "select"
        ? "agentControls.features.fast.title"
        : "shell.commandCenter.fastModeGroupLabel",
    );
  }
  if (feature.id === "workflow_mode") return i18n.t("agentControls.features.workflow.title");
  if (feature.id === "oauth_account_credential") {
    return i18n.t("agentControls.features.oauthAccount.title");
  }
  return feature.label ?? feature.id;
}

export function formatAgentFeatureOptionLabel(
  featureId: string,
  option: ControlLabelInput,
  translate: TFunction = i18n.t,
): string {
  if (featureId === FAST_MODE_FEATURE_ID) {
    switch (option.id) {
      case "off":
        return translate("agentControls.features.fast.standard");
      case "on":
        return translate("agentControls.features.fast.fast");
      case "ultrafast":
        return translate("agentControls.features.fast.ultrafast");
      default:
        return option.label ?? option.id;
    }
  }
  if (featureId !== "workflow_mode") return option.label ?? option.id;
  switch (option.id) {
    case "standard":
      return translate("agentControls.features.workflow.standard");
    case "enhanced":
      return translate("agentControls.features.workflow.enhanced");
    case "plan":
      return translate("agentControls.features.workflow.plan");
    case "goal":
      return translate("agentControls.features.workflow.goal");
    default:
      return option.label ?? option.id;
  }
}

export function formatAgentFeatureOptionDescription(
  featureId: string,
  option: ControlLabelInput & { description?: string },
  translate: TFunction = i18n.t,
): string | undefined {
  if (featureId === FAST_MODE_FEATURE_ID) {
    switch (option.id) {
      case "off":
        return translate("agentControls.features.fast.standardDescription");
      case "on":
        return translate("shell.commandCenter.fastModeDescription");
      case "ultrafast":
        return translate("agentControls.features.fast.ultrafastDescription");
    }
  }
  return option.description;
}
