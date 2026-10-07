import pino from "pino";
import { describe, expect, it } from "vitest";

import type {
  MutableDaemonConfig,
  OmpDesktopToolCapabilities,
} from "@omp-desktop/protocol/messages";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const toolsByCapability = {
  workspace: ["create_workspace", "list_workspaces", "archive_workspace", "rename_workspace"],
  agents: [
    "create_agent",
    "send_agent_prompt",
    "get_agent_status",
    "list_agents",
    "cancel_agent",
    "archive_agent",
    "kill_agent",
    "delete_agent",
    "update_agent",
    "get_agent_activity",
    "set_agent_mode",
  ],
  permissions: ["list_pending_permissions", "respond_to_permission"],
  schedules: [
    "create_schedule",
    "list_schedules",
    "inspect_schedule",
    "pause_schedule",
    "resume_schedule",
    "delete_schedule",
    "update_schedule",
    "schedule_logs",
    "run_schedule_once",
  ],
  heartbeat: ["create_heartbeat", "delete_heartbeat"],
  terminals: [
    "list_terminals",
    "create_terminal",
    "kill_terminal",
    "capture_terminal",
    "send_terminal_keys",
  ],
  scripts: ["list_workspace_scripts", "start_workspace_script", "stop_workspace_script"],
  providers: ["list_providers", "list_models", "list_profiles", "inspect_provider"],
  optional: ["image_gen", "present_image"],
} satisfies Record<keyof OmpDesktopToolCapabilities, string[]>;

const allEnabled: OmpDesktopToolCapabilities = {
  workspace: true,
  agents: true,
  permissions: true,
  schedules: true,
  heartbeat: true,
  terminals: true,
  scripts: true,
  providers: true,
  optional: true,
};

function createCatalog(
  toolCapabilities: OmpDesktopToolCapabilities,
  callerAgentId: string | undefined = "agent-1",
) {
  const config: MutableDaemonConfig = {
    mcp: { injectIntoAgents: true, toolCapabilities },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };

  return createPaseoToolCatalog({
    agentManager: {} as AgentManager,
    agentStorage: {} as AgentStorage,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    daemonConfigStore: { get: () => config },
    callerAgentId,
    logger: pino({ level: "silent" }),
  });
}

describe("OMP Desktop tool capability switches", () => {
  it.each(Object.keys(toolsByCapability) as (keyof OmpDesktopToolCapabilities)[])(
    "removes only the %s capability from agent-scoped catalogs",
    (disabledCapability) => {
      const catalog = createCatalog({ ...allEnabled, [disabledCapability]: false });
      const names = new Set(catalog.tools.keys());

      for (const toolName of toolsByCapability[disabledCapability]) {
        expect(names.has(toolName), `${toolName} should be disabled`).toBe(false);
      }
      for (const [capability, toolNames] of Object.entries(toolsByCapability)) {
        if (capability === disabledCapability) continue;
        for (const toolName of toolNames) {
          expect(names.has(toolName), `${toolName} should remain enabled`).toBe(true);
        }
      }
    },
  );

  it("does not apply agent injection preferences to the top-level catalog", () => {
    const allDisabled: OmpDesktopToolCapabilities = {
      workspace: false,
      agents: false,
      permissions: false,
      schedules: false,
      heartbeat: false,
      terminals: false,
      scripts: false,
      providers: false,
      optional: false,
    };
    const catalog = createCatalog(allDisabled, "");

    expect(catalog.getTool("create_workspace")).toBeDefined();
    expect(catalog.getTool("create_agent")).toBeDefined();
    expect(catalog.getTool("image_gen")).toBeDefined();
    expect(catalog.getTool("present_image")).toBeDefined();
  });
});
