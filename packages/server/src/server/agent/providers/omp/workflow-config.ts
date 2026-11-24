import type { AgentFeature } from "../../agent-sdk-types.js";

export const OMP_WORKFLOW_FEATURE_ID = "workflow_mode";
export const OMP_WORKFLOW_LOCALE_FEATURE_ID = "workflow_locale";
/** The selection before a cold change, used to restore native state before applying it. */
export const OMP_WORKFLOW_RESUME_FROM = "omp_workflow_resume_from";

export type OmpWorkflowMode = "plan" | "goal";
export type OmpWorkflowSelection = "standard" | "chat" | "enhanced" | OmpWorkflowMode;

export const OMP_CONTINUATION_BY_LOCALE = {
  ar: "تابع",
  en: "Continue",
  es: "Continúa",
  fr: "Continue",
  ja: "続けて",
  ko: "계속해",
  "pt-BR": "Continue",
  ru: "Продолжай",
  "zh-CN": "继续",
} as const;
export type OmpWorkflowLocale = keyof typeof OMP_CONTINUATION_BY_LOCALE;

export function isOmpWorkflowFeature(id: string): boolean {
  return id === OMP_WORKFLOW_FEATURE_ID || id === OMP_WORKFLOW_LOCALE_FEATURE_ID;
}

export function isOmpWorkflowSelection(value: unknown): value is OmpWorkflowSelection {
  return (
    value === "standard" ||
    value === "chat" ||
    value === "enhanced" ||
    value === "plan" ||
    value === "goal"
  );
}

export function normalizeOmpWorkflowSelection(value: unknown): OmpWorkflowSelection {
  return isOmpWorkflowSelection(value) ? value : "standard";
}

export function parseOmpWorkflowSelection(value: unknown): OmpWorkflowSelection {
  if (!isOmpWorkflowSelection(value)) throw new Error(`Invalid OMP workflow '${String(value)}'`);
  return value;
}

export function parseOmpWorkflowLocale(value: unknown): OmpWorkflowLocale {
  if (typeof value !== "string" || !Object.hasOwn(OMP_CONTINUATION_BY_LOCALE, value)) {
    throw new Error(`Invalid OMP workflow locale '${String(value)}'`);
  }
  return value as OmpWorkflowLocale;
}

export function createOmpWorkflowFeature(
  value: unknown,
  nativePlanAvailable: boolean,
): Extract<AgentFeature, { type: "select" }> {
  return {
    type: "select",
    id: OMP_WORKFLOW_FEATURE_ID,
    label: "Workflow",
    description: "Choose a conversation workflow independently from tool approvals.",
    icon: "Target",
    value:
      !nativePlanAvailable && value === "plan" ? "standard" : normalizeOmpWorkflowSelection(value),
    options: [
      { id: "standard", label: "Standard" },
      { id: "chat", label: "Chat" },
      { id: "enhanced", label: "Enhanced" },
      ...(nativePlanAvailable ? [{ id: "plan", label: "Plan" }] : []),
      { id: "goal", label: "Goal" },
    ],
  };
}
