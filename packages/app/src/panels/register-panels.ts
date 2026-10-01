import { agentPanelRegistration } from "@/panels/agent-panel";
import { commitDiffPanelRegistration, workingDiffPanelRegistration } from "@/panels/diff-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { localFilePanelRegistration } from "@/panels/local-file-panel";
import { filesPanelRegistration } from "@/panels/files-panel";
import { registerPanel } from "@/panels/panel-registry";
import { setupPanelRegistration } from "@/panels/setup-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";
import { backgroundProcessPanelRegistration } from "@/panels/background-process-panel";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";
import { pullRequestPanelRegistration } from "@/panels/pull-request-panel";
import { newTabPanelRegistration } from "@/panels/new-tab-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(newTabPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(providerSubagentPanelRegistration);
  registerPanel(setupPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(backgroundProcessPanelRegistration);
  registerPanel(filePanelRegistration);
  registerPanel(localFilePanelRegistration);
  registerPanel(filesPanelRegistration);
  registerPanel(pullRequestPanelRegistration);
  registerPanel(commitDiffPanelRegistration);
  registerPanel(workingDiffPanelRegistration);
  panelsRegistered = true;
}
