import type pino from "pino";
import type { FirstAgentContext } from "@omp-desktop/protocol/messages";

import { getParentAgentIdFromLabels } from "@omp-desktop/protocol/agent-labels";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import type { GitMutationService } from "./session/git-mutation/git-mutation-service.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedBranchName,
  type GenerateBranchNameFromFirstAgentContextOptions,
} from "./worktree-branch-name-generator.js";

type BranchNameGenerator = typeof generateBranchNameFromFirstAgentContext;

type CurrentSelection = GenerateBranchNameFromFirstAgentContextOptions["currentSelection"] | null;

interface WorkspaceAutoNameOptions {
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  workspaceGitService: WorkspaceGitService;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
  generateBranchName?: BranchNameGenerator;
}

interface ScheduleContext {
  currentSelection?: CurrentSelection;
}

export class WorkspaceAutoName {
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly readDaemonConfig: () => StructuredGenerationDaemonConfig;
  private readonly gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  private readonly emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly logger: pino.Logger;
  private readonly generateBranchName: BranchNameGenerator;

  constructor(options: WorkspaceAutoNameOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.gitMutation = options.gitMutation;
    this.emitWorkspaceUpdateForCwd = options.emitWorkspaceUpdateForCwd;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.logger = options.logger;
    this.generateBranchName = options.generateBranchName ?? generateBranchNameFromFirstAgentContext;
  }

  scheduleForWorktree(
    input: {
      workspace: PersistedWorkspaceRecord;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.schedule(
      () =>
        this.maybeAutoNameWorkspaceBranchForFirstAgent({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        cwd: input.workspace.cwd,
        message: "Failed to auto-name worktree branch",
      },
    );
  }

  async applyNativeSessionTitle(input: {
    agentId: string;
    title: string;
  }): Promise<void> {
    const agent = this.agentManager.getAgent(input.agentId);
    if (
      !agent ||
      agent.internal ||
      agent.lifecycle === "closed" ||
      !agent.workspaceId ||
      getParentAgentIdFromLabels(agent.labels)
    ) {
      return;
    }
    const title = input.title.trim();
    if (!title) return;
    let changed = false;
    await this.workspaceRegistry.update(agent.workspaceId, (current) => {
      if (
        current.archivedAt ||
        current.titleSource === "user" ||
        (current.titleSource === null && current.title !== null) ||
        (current.title === title && current.titleSource === "auto")
      ) {
        return current;
      }
      changed = true;
      return {
        ...current,
        title,
        // Only an explicit workspace rename locks this mirror; native titles keep following the session.
        titleSource: "auto",
        updatedAt: new Date().toISOString(),
      };
    });
    if (changed) await this.emitWorkspaceUpdateForWorkspaceId(agent.workspaceId);
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    const worktreeRoot = input.workspace.worktreeRoot ?? input.workspace.cwd;
    const result: AttemptFirstAgentBranchAutoNameResult = await attemptFirstAgentBranchAutoName({
      cwd: worktreeRoot,
      firstAgentContext: input.firstAgentContext,
      generateBranchNameFromContext: async ({ firstAgentContext }) => {
        const generated = await this.generateFromContext({
          cwd: input.workspace.cwd,
          firstAgentContext,
          currentSelection: input.currentSelection,
        });
        return generated?.branch ?? null;
      },
    });
    if (!result.renamed) return;
    await this.workspaceRegistry.update(input.workspace.workspaceId, (current) => ({
      ...current,
      branch: result.branchName,
      updatedAt: new Date().toISOString(),
    }));
    await this.gitMutation.notifyGitMutation(worktreeRoot, "rename-branch");
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
  }

  private generateFromContext(input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<GeneratedBranchName | null> {
    return this.generateBranchName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      workspaceGitService: this.workspaceGitService,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentSelection: input.currentSelection ?? undefined,
      firstAgentContext: input.firstAgentContext,
      logger: this.logger,
    });
  }

  private schedule(run: () => Promise<void>, context: { cwd: string; message: string }): void {
    setTimeout(() => {
      void run().catch((error) => {
        this.logger.warn({ err: error, cwd: context.cwd }, context.message);
      });
    }, 0);
  }
}
