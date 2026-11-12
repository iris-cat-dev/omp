import type { ReactNode } from "react";
import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
import type { CreateAgentRequestMessage } from "@omp-desktop/protocol/messages";
import type { DesktopPetRevision, PetCreationWorkspace } from "./types.js";
export type PetInterfaceLocale = NonNullable<CreateAgentRequestMessage["locale"]>;
export interface PetActivityAgent {
  readonly id: string; readonly serverId?: string; readonly archivedAt?: Date | null; readonly labels: Readonly<Record<string, string>>;
  readonly pendingPermissionCount?: number; readonly pendingPermissions?: readonly unknown[]; readonly requiresAttention?: boolean;
  readonly attentionReason?: "permission" | "error" | "finished" | null; readonly status: string; readonly title?: string | null;
  readonly lastActivityAt: Date; readonly attentionTimestamp?: Date | null; readonly workspaceId?: string | null;
}
export interface PetHostActivity {
  readonly serverId: string; readonly connected: boolean; readonly revision: DesktopPetRevision | null;
  readonly connectionKey: string;
  readonly agents: Iterable<PetActivityAgent>;
  resolveAgentLabel(agent: PetActivityAgent, untitled: string): string;
}
export interface PetActivitySnapshot { readonly hosts: readonly PetHostActivity[]; readonly fontFamily: string }
export interface PetCreationHost {
  readonly serverId: string;
  prepareWorkspace(description: string): Promise<PetCreationWorkspace>;
  createMessageId(): string;
  createWorkspace(directory: string): Promise<{ id: string; cwd: string }>;
  createAgent(input: { workspaceId: string; config: AgentSessionConfig; locale: PetInterfaceLocale; initialPrompt: string; clientMessageId: string; timestamp: Date }): Promise<{ id: string }>;
  openAgent(agentId: string): void;
}
export interface PetCreationDraft { host: PetCreationHost | null; ready: boolean; error: string | null; preferences: Omit<AgentSessionConfig, "cwd">; controls: ReactNode }
export interface PetClientFeedback { notify(message: string, variant: "success" | "error"): void; reportError(error: unknown, message: string): void }
export interface DesktopPetClientHost {
  useTranslation(): { t(key: string, values?: Record<string, unknown>): string; locale: PetInterfaceLocale };
  useActivitySnapshot(): PetActivitySnapshot;
  refreshAgentDirectory(serverId: string, generation: string): Promise<void>;
  useCreationDraft(installationId: string, disabled: boolean, initialPreferences: Omit<AgentSessionConfig, "cwd"> | null): PetCreationDraft;
  useFeedback(): PetClientFeedback;
}
let host: DesktopPetClientHost | undefined;
export function configureDesktopPetClientHost(value: DesktopPetClientHost): void { host = value; }
export function getDesktopPetClientHost(): DesktopPetClientHost { if (!host) throw new Error("Desktop pet client host is not configured."); return host; }
