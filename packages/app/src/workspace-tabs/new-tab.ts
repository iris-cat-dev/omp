import { generateMessageId } from "@/types/stream";
import type { WorkspaceTab } from "@/workspace-tabs/model";

export type NewTabSelection =
  | { kind: "target"; target: WorkspaceTab["target"] }
  | { kind: "agent" }
  | { kind: "terminal" };

export function createNewWorkspaceTab(): WorkspaceTab {
  return {
    tabId: `tab_${generateMessageId()}`,
    target: { kind: "new_tab" },
    createdAt: Date.now(),
  };
}
