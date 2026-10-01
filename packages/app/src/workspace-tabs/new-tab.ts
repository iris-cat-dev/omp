import { generateMessageId } from "@/types/stream";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import type { TerminalProfile } from "@omp-desktop/protocol/messages";

export type NewTabSelection =
  | { kind: "target"; target: WorkspaceTab["target"] }
  | { kind: "agent" }
  | { kind: "terminal"; profile?: TerminalProfile };

export function createNewWorkspaceTab(): WorkspaceTab {
  return {
    tabId: `tab_${generateMessageId()}`,
    target: { kind: "new_tab" },
    createdAt: Date.now(),
  };
}
