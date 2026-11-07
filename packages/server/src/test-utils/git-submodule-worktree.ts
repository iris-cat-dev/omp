import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function initializeFixtureRepo(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true });
  fixtureGit(repoRoot, "init", "-b", "main");
  fixtureGit(repoRoot, "config", "user.name", "Git root regression");
  fixtureGit(repoRoot, "config", "user.email", "git-root@example.com");
  writeFileSync(join(repoRoot, "source.txt"), "source\n");
  fixtureGit(repoRoot, "add", "source.txt");
  fixtureGit(repoRoot, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
}

export function createLinkedSubmoduleFixture(tempDir: string): {
  parentRoot: string;
  sourceRoot: string;
  gitDir: string;
  paseoHome: string;
  worktreeRoot: string;
} {
  const sdkOrigin = join(tempDir, "sdk-origin");
  const parentRoot = join(tempDir, "parent");
  const parentWorktree = join(tempDir, "parent-linked");
  initializeFixtureRepo(sdkOrigin);
  initializeFixtureRepo(parentRoot);
  fixtureGit(
    parentRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    sdkOrigin,
    "omp-sdk",
  );
  fixtureGit(parentRoot, "-c", "commit.gpgsign=false", "commit", "-am", "add SDK");
  fixtureGit(parentRoot, "worktree", "add", "-b", "parent-linked", parentWorktree);
  fixtureGit(
    parentWorktree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
  );
  const sourceRoot = realpathSync(join(parentWorktree, "omp-sdk"));
  const gitDir = realpathSync(fixtureGit(sourceRoot, "rev-parse", "--absolute-git-dir"));
  const paseoHome = join(realpathSync(tempDir), ".paseo");
  const worktreeRoot = join(paseoHome, "worktrees", "sdk-fixture", "sdk-feature");
  mkdirSync(join(worktreeRoot, ".."), { recursive: true });
  fixtureGit(sourceRoot, "worktree", "add", "-b", "sdk-feature", worktreeRoot);
  return { parentRoot: realpathSync(parentRoot), sourceRoot, gitDir, paseoHome, worktreeRoot };
}
