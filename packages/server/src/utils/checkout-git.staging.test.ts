import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "fs/promises";
import type * as FsPromises from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitChanges,
  discardUnstagedChanges,
  getCheckoutDiff,
  stageChanges,
  unstageChanges,
} from "./checkout-git.js";

// Observe inspections while retaining real filesystem and Git behavior.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

describe("checkout git staging", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "checkout-git-staging-"));
    repoDir = join(tempDir, "repo");
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repoDir });
    writeFileSync(join(repoDir, "staged.txt"), "before staged\n");
    writeFileSync(join(repoDir, "unstaged.txt"), "before unstaged\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
      cwd: repoDir,
    });
  });

  afterEach(() => {
    vi.mocked(lstat).mockClear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("separates staged changes and commits only the index", async () => {
    writeFileSync(join(repoDir, "staged.txt"), "after staged\n");
    writeFileSync(join(repoDir, "unstaged.txt"), "after unstaged\n");

    await stageChanges(repoDir, ["staged.txt"]);

    const staged = await getCheckoutDiff(repoDir, { mode: "staged", includeStructured: true });
    const unstaged = await getCheckoutDiff(repoDir, { mode: "unstaged", includeStructured: true });
    expect(staged.structured?.map((file) => file.path)).toEqual(["staged.txt"]);
    expect(unstaged.structured?.map((file) => file.path)).toEqual(["unstaged.txt"]);

    await commitChanges(repoDir, { message: "commit staged only" });

    expect(execFileSync("git", ["show", "HEAD:staged.txt"], { cwd: repoDir }).toString()).toBe(
      "after staged\n",
    );
    expect(execFileSync("git", ["show", "HEAD:unstaged.txt"], { cwd: repoDir }).toString()).toBe(
      "before unstaged\n",
    );
    expect(execFileSync("git", ["status", "--short"], { cwd: repoDir }).toString()).toContain(
      " M unstaged.txt",
    );
  });

  it("moves a staged path back to unstaged changes", async () => {
    writeFileSync(join(repoDir, "staged.txt"), "after staged\n");
    await stageChanges(repoDir, ["staged.txt"]);
    await unstageChanges(repoDir, ["staged.txt"]);

    const staged = await getCheckoutDiff(repoDir, { mode: "staged", includeStructured: true });
    const unstaged = await getCheckoutDiff(repoDir, { mode: "unstaged", includeStructured: true });
    expect(staged.structured).toEqual([]);
    expect(unstaged.structured?.map((file) => file.path)).toEqual(["staged.txt"]);
  });

  it("discards worktree changes while preserving the staged version", async () => {
    writeFileSync(join(repoDir, "staged.txt"), "staged version\n");
    await stageChanges(repoDir, ["staged.txt"]);
    writeFileSync(join(repoDir, "staged.txt"), "unstaged version\n");
    writeFileSync(join(repoDir, "scratch.txt"), "remove\n");

    await discardUnstagedChanges(repoDir, ["staged.txt", "scratch.txt"]);

    expect(readFileSync(join(repoDir, "staged.txt"), "utf8")).toBe("staged version\n");
    expect(existsSync(join(repoDir, "scratch.txt"))).toBe(false);
    expect(execFileSync("git", ["show", ":staged.txt"], { cwd: repoDir }).toString()).toBe(
      "staged version\n",
    );
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repoDir }).toString(),
    ).toBe("staged.txt\n");
  });

  it("summarizes both sides of partial staging without inventing net HEAD changes", async () => {
    writeFileSync(join(repoDir, "staged.txt"), "index version\n");
    writeFileSync(join(repoDir, "unstaged.txt"), "temporary index version\n");
    await stageChanges(repoDir, ["staged.txt", "unstaged.txt"]);
    writeFileSync(join(repoDir, "staged.txt"), "worktree version\nextra line\n");
    writeFileSync(join(repoDir, "unstaged.txt"), "before unstaged\n");

    const result = await getCheckoutDiff(repoDir, { mode: "uncommitted", detail: "summary" });
    expect(result.diff).toBe("");
    expect(result.structured).toEqual([
      expect.objectContaining({ path: "staged.txt", additions: 2, deletions: 1, hunks: [] }),
    ]);
    expect(result.staging?.stagedFiles).toEqual([
      expect.objectContaining({ path: "staged.txt", additions: 1, deletions: 1, hunks: [] }),
      expect.objectContaining({ path: "unstaged.txt", additions: 1, deletions: 1, hunks: [] }),
    ]);
    expect(result.staging?.unstagedFiles).toEqual([
      expect.objectContaining({ path: "staged.txt", additions: 2, deletions: 1, hunks: [] }),
      expect.objectContaining({ path: "unstaged.txt", additions: 1, deletions: 1, hunks: [] }),
    ]);
    const staged = await getCheckoutDiff(repoDir, {
      mode: "staged",
      paths: ["staged.txt"],
      includeStructured: true,
    });
    const unstaged = await getCheckoutDiff(repoDir, {
      mode: "unstaged",
      paths: ["staged.txt"],
      includeStructured: true,
    });
    expect(staged.diff).toContain("+index version");
    expect(staged.diff).not.toContain("worktree version");
    expect(unstaged.diff).toContain("-index version");
    expect(unstaged.diff).toContain("+worktree version");
  });

  it("preserves unusual rename paths and filters literal paths before rendering", async () => {
    const oldPath = "旧 文件.ts";
    const newPath = process.platform === "win32" ? "新 [one] 文件.ts" : "新\t[one]\n文件.ts ";
    writeFileSync(join(repoDir, oldPath), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    execFileSync("git", ["add", "--", oldPath], { cwd: repoDir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "rename source"], {
      cwd: repoDir,
    });
    execFileSync("git", ["mv", "--", oldPath, newPath], { cwd: repoDir });
    writeFileSync(
      join(repoDir, newPath),
      "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
    );
    await stageChanges(repoDir, [newPath]);
    writeFileSync(join(repoDir, "unrelated.ts"), "not requested\n");

    const summary = await getCheckoutDiff(repoDir, {
      mode: "staged",
      detail: "summary",
      paths: [newPath],
    });
    expect(summary.structured).toEqual([
      expect.objectContaining({ path: newPath, oldPath, additions: 1, deletions: 0, hunks: [] }),
    ]);
    const full = await getCheckoutDiff(repoDir, {
      mode: "staged",
      paths: [newPath],
      includeStructured: true,
    });
    expect(full.structured).toEqual([
      expect.objectContaining({ path: newPath, oldPath, additions: 1, deletions: 0, status: "ok" }),
    ]);
    expect(full.diff).toContain("+const d = 4;");
    expect(full.diff).not.toContain("unrelated.ts");
    expect(
      (
        await getCheckoutDiff(repoDir, {
          mode: "uncommitted",
          detail: "summary",
          paths: ["*.ts"],
        })
      ).structured,
    ).toEqual([]);
    expect(
      await getCheckoutDiff(repoDir, {
        mode: "uncommitted",
        detail: "summary",
        paths: [],
      }),
    ).toEqual({ diff: "", structured: [], staging: { stagedFiles: [], unstagedFiles: [] } });
  });

  it("summarizes unborn staging, binary files and unterminated untracked lines", async () => {
    const unborn = join(tempDir, "unborn");
    mkdirSync(unborn);
    execFileSync("git", ["init", "-b", "main"], { cwd: unborn });
    writeFileSync(join(unborn, "new.ts"), "const value = 1;\n");
    await stageChanges(unborn, ["new.ts"]);
    writeFileSync(join(unborn, "new.ts"), "const value = 1;\nconst extra = 2;\n");
    writeFileSync(join(unborn, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(unborn, "notes.txt"), "first\nlast");

    const summary = await getCheckoutDiff(unborn, { mode: "uncommitted", detail: "summary" });
    expect(summary.structured).toEqual([
      expect.objectContaining({ path: "binary.bin", status: "binary", additions: 0, hunks: [] }),
      expect.objectContaining({ path: "new.ts", isNew: true, additions: 2, deletions: 0 }),
      expect.objectContaining({ path: "notes.txt", isNew: true, additions: 2, deletions: 0 }),
    ]);
    expect(summary.staging?.stagedFiles).toEqual([
      expect.objectContaining({ path: "new.ts", isNew: true, additions: 1, deletions: 0 }),
    ]);
    expect(summary.staging?.unstagedFiles).toContainEqual(
      expect.objectContaining({ path: "new.ts", isNew: false, additions: 1, deletions: 0 }),
    );
    const full = await getCheckoutDiff(unborn, {
      mode: "uncommitted",
      includeStructured: true,
      paths: ["binary.bin"],
    });
    expect(full.structured).toEqual([
      expect.objectContaining({ path: "binary.bin", status: "binary", hunks: [] }),
    ]);
  });

  it("inspects each untracked path once per summary and rereads it on the next request", async () => {
    writeFileSync(join(repoDir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repoDir, "empty.txt"), "");
    writeFileSync(join(repoDir, "large.txt"), "line\n".repeat(220_000) + "last");
    writeFileSync(join(repoDir, "notes.txt"), "first\nlast");
    writeFileSync(join(repoDir, "staged.txt"), "index version\n");
    await stageChanges(repoDir, ["staged.txt"]);
    vi.mocked(lstat).mockClear();

    const summary = await getCheckoutDiff(repoDir, { mode: "uncommitted", detail: "summary" });
    const untracked = [
      expect.objectContaining({ path: "binary.bin", additions: 0, deletions: 0, status: "binary" }),
      expect.objectContaining({ path: "empty.txt", additions: 0, deletions: 0, status: "ok" }),
      expect.objectContaining({
        path: "large.txt",
        additions: 220_001,
        deletions: 0,
        status: "too_large",
      }),
      expect.objectContaining({ path: "notes.txt", additions: 2, deletions: 0, status: "ok" }),
    ];
    expect(summary.structured).toEqual([
      ...untracked,
      expect.objectContaining({ path: "staged.txt", additions: 1, deletions: 1 }),
    ]);
    expect(summary.staging?.stagedFiles).toEqual([
      expect.objectContaining({ path: "staged.txt", additions: 1, deletions: 1 }),
    ]);
    expect(summary.staging?.unstagedFiles).toEqual(untracked);
    for (const path of ["binary.bin", "empty.txt", "large.txt", "notes.txt"]) {
      expect(
        vi.mocked(lstat).mock.calls.filter(([file]) => file === join(repoDir, path)),
      ).toHaveLength(1);
    }

    writeFileSync(join(repoDir, "notes.txt"), "changed\n");
    const refreshed = await getCheckoutDiff(repoDir, { mode: "uncommitted", detail: "summary" });
    expect(refreshed.structured?.find((file) => file.path === "notes.txt")).toMatchObject({
      additions: 1,
      deletions: 0,
      status: "ok",
    });
    expect(refreshed.staging?.unstagedFiles).toEqual(
      refreshed.structured?.filter((file) => file.path !== "staged.txt"),
    );
    for (const path of ["binary.bin", "empty.txt", "large.txt", "notes.txt"]) {
      expect(
        vi.mocked(lstat).mock.calls.filter(([file]) => file === join(repoDir, path)),
      ).toHaveLength(2);
    }
  });

  it.skipIf(process.platform === "win32")(
    "shares symlink metadata without inspecting its binary target",
    async () => {
      writeFileSync(join(tempDir, "target.bin"), Buffer.from([0, 1, 2, 3]));
      symlinkSync("../target.bin", join(repoDir, "link"));
      vi.mocked(lstat).mockClear();

      const summary = await getCheckoutDiff(repoDir, { mode: "uncommitted", detail: "summary" });
      expect(summary.structured).toEqual([
        expect.objectContaining({
          path: "link",
          additions: 1,
          deletions: 0,
          status: "ok",
          hunks: [],
        }),
      ]);
      expect(summary.staging?.stagedFiles).toEqual([]);
      expect(summary.staging?.unstagedFiles).toEqual(summary.structured);
      expect(
        vi.mocked(lstat).mock.calls.filter(([file]) => file === join(repoDir, "link")),
      ).toHaveLength(1);
    },
  );

  it("retains binary metadata alongside a staged deletion", async () => {
    writeFileSync(join(repoDir, "tracked.bin"), Buffer.from([0, 1, 2, 3]));
    await stageChanges(repoDir, ["tracked.bin"]);
    await commitChanges(repoDir, { message: "track binary" });
    writeFileSync(join(repoDir, "tracked.bin"), Buffer.from([0, 4, 5, 6]));
    await stageChanges(repoDir, ["tracked.bin"]);
    execFileSync("git", ["rm", "--", "unstaged.txt"], { cwd: repoDir });
    const summary = await getCheckoutDiff(repoDir, { mode: "staged", detail: "summary" });
    expect(summary.structured).toEqual([
      expect.objectContaining({ path: "tracked.bin", status: "binary", hunks: [], additions: 0 }),
      expect.objectContaining({
        path: "unstaged.txt",
        isDeleted: true,
        additions: 0,
        deletions: 1,
      }),
    ]);
    const full = await getCheckoutDiff(repoDir, { mode: "staged", includeStructured: true });
    expect(full.structured?.find((file) => file.path === "tracked.bin")).toMatchObject({
      status: "binary",
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    expect(full.structured?.find((file) => file.path === "unstaged.txt")).toMatchObject({
      status: "ok",
      isDeleted: true,
      additions: 0,
      deletions: 1,
    });
    expect(full.diff).toContain("-before unstaged");
  });
});
