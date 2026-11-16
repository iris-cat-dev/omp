import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "./agent/agent-response-loop.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { generateBranchNameFromFirstAgentContext } from "./worktree-branch-name-generator.js";
import {
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  writePaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createStructuredGenerator(result: { branch: string }) {

  async function generateStructured<T>(
    _options: StructuredAgentGenerationWithFallbackOptions<T>,
  ): Promise<T> {
    return result as T;
  }

  return { generateStructured };
}

describe("generateBranchNameFromFirstAgentContext", () => {

  test("keeps the branch slug validator fallback when instructions are present", async () => {
    const repoRoot = createTempDir("paseo-branch-config-");
    const worktreeRoot = createTempDir("paseo-branch-worktree-");
    mkdirSync(path.join(worktreeRoot, ".git"));
    writePaseoWorktreeMetadata(worktreeRoot, { baseRefName: "main" });
    writePaseoWorktreeFirstAgentBranchAutoNameMetadata(worktreeRoot, {
      placeholderBranchName: "dazzling-yak",
    });
    writeConfig(repoRoot, {
      metadataGeneration: {
        branchName: {
          instructions: "Use the prefix mb/.",
        },
      },
    });
    const structured = createStructuredGenerator({
      branch: "Invalid Branch Name",
    });
    const renameCurrentBranch = vi.fn(async () => ({
      previousBranch: "dazzling-yak",
      currentBranch: "Invalid Branch Name",
    }));

    const result: AttemptFirstAgentBranchAutoNameResult = await attemptFirstAgentBranchAutoName({
      cwd: worktreeRoot,
      firstAgentContext: { prompt: "Fix the login flow" },
      generateBranchNameFromContext: ({ cwd, firstAgentContext }) =>
        generateBranchNameFromFirstAgentContext({
          agentManager: {} as AgentManager,
          cwd,
          workspaceGitService: createNoopWorkspaceGitService({
            resolveRepoRoot: async () => repoRoot,
          }),
          firstAgentContext,
          logger: createLogger(),
          deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
        }).then((r) => r?.branch ?? null),
      getCurrentBranch: async () => "dazzling-yak",
      renameCurrentBranch,
    });

    expect(result).toEqual({ attempted: true, renamed: false, branchName: null });
    expect(renameCurrentBranch).not.toHaveBeenCalled();
  });
});

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupPaths.push(tempDir);
  return tempDir;
}

function writeConfig(repoRoot: string, config: unknown): void {
  writeFileSync(path.join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
}
