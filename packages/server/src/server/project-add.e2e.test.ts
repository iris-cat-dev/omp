import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test.each(["index", "head-object"] as const)(
  "adds a project with a corrupt Git %s and creates a directory workspace without changing files",
  async (corruption) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "project-add-corrupt-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "Project import test");
    git("config", "user.email", "project-import@example.com");
    writeFileSync(path.join(cwd, "notes.txt"), "keep project contents\n");
    git("add", "notes.txt");
    git("commit", "-m", "Initial commit");
    const head = git("rev-parse", "HEAD");
    const damagedPath =
      corruption === "index"
        ? path.join(cwd, ".git", "index")
        : path.join(cwd, ".git", "objects", head.slice(0, 2), head.slice(2));
    const original = readFileSync(damagedPath);
    if (corruption === "index") {
      writeFileSync(damagedPath, "corrupt index\n");
    } else {
      rmSync(damagedPath);
    }

    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      const added = await client.addProject(cwd);
      expect(added.error).toBeNull();
      expect(added.project).toMatchObject({ projectRootPath: cwd, projectKind: "non_git" });
      const projectId = added.project!.projectId;
      const reopened = await client.addProject(cwd);
      expect(reopened.error).toBeNull();
      expect(reopened.project?.projectId).toBe(projectId);

      const created = await client.createWorkspace({
        source: { kind: "directory", path: cwd, projectId },
      });
      expect(created.error).toBeNull();
      expect(created.workspace).toMatchObject({
        projectId,
        workspaceDirectory: cwd,
        projectKind: "non_git",
        workspaceKind: "directory",
        project: {
          checkout: {
            cwd,
            isGit: false,
            currentBranch: null,
            worktreeRoot: null,
          },
        },
      });
      expect(readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("keep project contents\n");
      if (corruption === "index") {
        expect(readFileSync(damagedPath, "utf8")).toBe("corrupt index\n");
      } else {
        expect(existsSync(damagedPath)).toBe(false);
      }

      writeFileSync(damagedPath, original);
      const repaired = await client.addProject(cwd);
      expect(repaired.error).toBeNull();
      expect(repaired.project).toMatchObject({
        projectId,
        projectRootPath: cwd,
        projectKind: "git",
      });
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60_000,
);
