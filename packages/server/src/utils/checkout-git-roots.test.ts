import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  createLinkedSubmoduleFixture,
  fixtureGit,
  initializeFixtureRepo,
} from "../test-utils/git-submodule-worktree.js";
import { getMainRepoRoot, getWorkingTreeRootForGitDir } from "./checkout-git.js";

const tempDirs: string[] = [];
function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "checkout-git-roots-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["relative", "absolute"])(
  "resolves a linked parent's submodule source from its additional worktree (%s core.worktree)",
  async (format) => {
    const fixture = createLinkedSubmoduleFixture(temporaryDirectory());
    fixtureGit(
      fixture.gitDir,
      "config",
      "--file",
      join(fixture.gitDir, "config"),
      "core.worktree",
      format === "relative" ? relative(fixture.gitDir, fixture.sourceRoot) : fixture.sourceRoot,
    );

    expect(await getWorkingTreeRootForGitDir(fixture.gitDir)).toBe(fixture.sourceRoot);
    expect(await getMainRepoRoot(fixture.sourceRoot)).toBe(fixture.sourceRoot);
    expect(await getMainRepoRoot(fixture.worktreeRoot)).toBe(fixture.sourceRoot);
  },
);

it.each(["missing-config", "missing-source", "other-repo", "nested-source", "linked-source"])(
  "does not infer a source from unverified metadata: %s",
  async (kind) => {
    const tempDir = temporaryDirectory();
    const fixture = createLinkedSubmoduleFixture(tempDir);
    const configArgs = ["config", "--file", join(fixture.gitDir, "config")];
    if (kind === "missing-config") {
      fixtureGit(fixture.gitDir, ...configArgs, "--unset", "core.worktree");
    } else {
      let target = join(tempDir, "missing");
      if (kind === "other-repo") {
        target = join(tempDir, "unrelated");
        initializeFixtureRepo(target);
      } else if (kind === "nested-source") {
        target = join(fixture.sourceRoot, "nested");
        mkdirSync(target);
      } else if (kind === "linked-source") {
        target = fixture.worktreeRoot;
      }
      fixtureGit(fixture.gitDir, ...configArgs, "core.worktree", target);
    }
    expect(await getWorkingTreeRootForGitDir(fixture.gitDir)).toBeNull();
  },
);

it("does not use an included core.worktree as local repair authority", async () => {
  const fixture = createLinkedSubmoduleFixture(temporaryDirectory());
  const configPath = join(fixture.gitDir, "config");
  const includedPath = join(fixture.gitDir, "included-config");
  writeFileSync(includedPath, `[core]\n\tworktree = ${JSON.stringify(fixture.sourceRoot)}\n`);
  fixtureGit(fixture.gitDir, "config", "--file", configPath, "--unset", "core.worktree");
  fixtureGit(fixture.gitDir, "config", "--file", configPath, "include.path", includedPath);
  expect(await getWorkingTreeRootForGitDir(fixture.gitDir)).toBeNull();
});

it("preserves ordinary repository roots and bare repository main-child preference", async () => {
  const tempDir = temporaryDirectory();
  const repoRoot = join(tempDir, "ordinary");
  initializeFixtureRepo(repoRoot);
  expect(await getMainRepoRoot(repoRoot)).toBe(realpathSync(repoRoot));
  expect(await getWorkingTreeRootForGitDir(join(repoRoot, ".git"))).toBeNull();
  expect(await getWorkingTreeRootForGitDir(join(tempDir, "absent"))).toBeNull();

  const bareRoot = join(tempDir, "bare");
  fixtureGit(tempDir, "clone", "--bare", repoRoot, bareRoot);
  expect(await getMainRepoRoot(bareRoot)).toBe(realpathSync(bareRoot));
  expect(await getWorkingTreeRootForGitDir(bareRoot)).toBeNull();
  const otherRoot = join(bareRoot, "aaa");
  const mainRoot = join(bareRoot, "main");
  fixtureGit(bareRoot, "worktree", "add", "-b", "other", otherRoot);
  fixtureGit(bareRoot, "worktree", "add", mainRoot, "main");
  expect(await getMainRepoRoot(otherRoot)).toBe(realpathSync(mainRoot));
});
