import { z } from "zod";
import type { AgentMode } from "./agent-types.js";

export type AgentModeColorTier = "safe" | "moderate" | "dangerous" | "planning" | `#${string}`;
// Open string by design: the client looks icons up in a registry and falls back
// to a default for unknown values. Daemon downgrades unknown icons for clients
// that pre-date the open-string contract (see CLIENT_CAPS.customModeIcons).
export type AgentModeIcon = string;

export interface AgentModeVisuals {
  icon: AgentModeIcon;
  colorTier: AgentModeColorTier;
}

export type AgentProviderModeDefinition = Omit<AgentMode, "icon" | "colorTier"> &
  AgentModeVisuals & {
    // Marks the provider's most-permissioned no-prompt mode. Selecting it means tools run without approval; the runtime mechanism is provider-specific.
    isUnattended?: boolean;
  };

// TODO: `modes` should not be static. Providers (especially ACP) report their
// own modes at runtime via session/new. We should fetch modes from the provider
// as source of truth and enrich with UI metadata (icons, colorTier) on top.
export interface AgentProviderDefinition {
  id: string;
  label: string;
  description: string;
  enabledByDefault?: boolean;
  defaultModeId: string | null;
  modes: AgentProviderModeDefinition[];
}

export const OMP_MODES: AgentProviderModeDefinition[] = [
  {
    id: "ask",
    label: "Always Ask",
    description: "Prompt before OMP writes files or executes commands.",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
  {
    id: "write",
    label: "Write Approval",
    description: "Allow reads while prompting before writes.",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: "full",
    label: "Full Access",
    description: "Run OMP tools without approval prompts.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "omp",
    label: "Oh My Pi",
    description: "OMP coding agent with native approvals, host tools, and subagents",
    enabledByDefault: true,
    defaultModeId: "ask",
    modes: OMP_MODES,
  },
  // Import-only providers: they run sessions on the OMP runtime but list and
  // import external transcripts (pi / Codex). No creation modes — the UI
  // surfaces them through the import-sessions sheet only.
  {
    id: "pi",
    label: "pi",
    description: "Import existing pi coding-agent sessions (runs on OMP)",
    enabledByDefault: true,
    defaultModeId: null,
    modes: [],
  },
  {
    id: "codex",
    label: "Codex",
    description: "Import existing Codex rollout sessions (runs on OMP)",
    enabledByDefault: true,
    defaultModeId: null,
    modes: [],
  },
];

export const DEV_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];

export function getAgentProviderDefinition(
  provider: string,
  definitions: AgentProviderDefinition[] = [
    ...AGENT_PROVIDER_DEFINITIONS,
    ...DEV_AGENT_PROVIDER_DEFINITIONS,
  ],
): AgentProviderDefinition {
  const definition = definitions.find((entry) => entry.id === provider);
  if (!definition) {
    throw new Error(`Unknown agent provider: ${provider}`);
  }
  return definition;
}

export const BUILTIN_PROVIDER_IDS = AGENT_PROVIDER_DEFINITIONS.map((d) => d.id);
export const AGENT_PROVIDER_IDS = BUILTIN_PROVIDER_IDS;

export const AgentProviderSchema = z.string();

export function isValidAgentProvider(
  value: string,
  validIds: Iterable<string> = BUILTIN_PROVIDER_IDS,
): boolean {
  return Array.isArray(validIds) ? validIds.includes(value) : new Set(validIds).has(value);
}

export function getUnattendedModeId(
  provider: string,
  definitions: AgentProviderDefinition[] = [
    ...AGENT_PROVIDER_DEFINITIONS,
    ...DEV_AGENT_PROVIDER_DEFINITIONS,
  ],
): string | undefined {
  const definition = definitions.find((entry) => entry.id === provider);
  return definition?.modes.find((mode) => mode.isUnattended)?.id;
}

export function getModeVisuals(
  provider: string,
  modeId: string,
  definitions: AgentProviderDefinition[],
): AgentModeVisuals | undefined {
  const definition = definitions.find((entry) => entry.id === provider);
  const mode = definition?.modes.find((m) => m.id === modeId);
  if (!mode) return undefined;
  return { icon: mode.icon, colorTier: mode.colorTier };
}
