import { createElement, type ComponentType } from "react";
import {
  createLucideIcon,
  Bot,
  Brain,
  ListTodo,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  SlidersHorizontal,
  Sparkles,
  Zap,
  Target,
} from "lucide-react-native";
import {
  getModeVisuals,
  type AgentProviderDefinition,
} from "@omp-desktop/protocol/provider-manifest";

export interface AgentControlIconProps {
  size: number;
  color: string;
  accessibilityLabel?: string;
}

export type AgentControlIcon = ComponentType<AgentControlIconProps>;

export const ThinkingIcon = Brain;
export const PlanModeIcon = ListTodo;

const UltrafastGlyph = createLucideIcon("Ultrafast", [
  ["path", { d: "m16 3 1-1v7h6L13 22", fill: "none", key: "rear-bolt" }],
  ["path", { d: "m13 2-11 12h7l-2 8L19 9h-7l1-7Z", key: "front-bolt" }],
]);

function UltrafastIcon({ size, color, accessibilityLabel }: AgentControlIconProps) {
  return createElement(UltrafastGlyph, { size, color, fill: color, accessibilityLabel });
}

const MODE_ICONS: Record<string, AgentControlIcon> = {
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldPlus,
  ShieldQuestionMark,
  Target,
};

const FEATURE_ICONS: Record<string, AgentControlIcon> = {
  "list-todo": ListTodo,
  "shield-check": ShieldCheck,
  zap: Zap,
};

export function getAgentModeIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return (icon ? MODE_ICONS[icon] : undefined) ?? Bot;
}

export function getAgentModeOptionIcon(
  provider: string,
  modeId: string,
  providerDefinitions: AgentProviderDefinition[],
): AgentControlIcon | undefined {
  const icon = getModeVisuals(provider, modeId, providerDefinitions)?.icon;
  return icon ? MODE_ICONS[icon] : undefined;
}

export function getAgentFeatureIcon(icon?: string): AgentControlIcon {
  return (icon ? FEATURE_ICONS[icon] : undefined) ?? Settings2;
}

export function getAgentFeatureOptionIcon(
  featureId: string,
  optionId: string | null,
  icon?: string,
): AgentControlIcon {
  if (featureId === "fast_mode" && optionId === "ultrafast") {
    return UltrafastIcon;
  }
  if (featureId !== "workflow_mode") {
    return getAgentFeatureIcon(icon);
  }
  switch (optionId) {
    case "enhanced":
      return Sparkles;
    case "plan":
      return ListTodo;
    case "goal":
      return Target;
    default:
      return SlidersHorizontal;
  }
}
