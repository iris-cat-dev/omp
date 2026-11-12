import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCli } from "./install.js";
import { getBundledCliShimPath, getCliTargetPath } from "./paths.js";

const fixture = vi.hoisted(() => ({ executable: "" }));
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => fixture.executable },
}));
vi.mock("electron-log/main", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cli-install-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("SHELL", "/bin/zsh");
  vi.stubEnv("PATH", process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin");
  vi.stubEnv("APPIMAGE", "");
  fixture.executable =
    process.platform === "darwin"
      ? path.join(home, "OMP Desktop.app", "Contents", "MacOS", "OMP Desktop")
      : path.join(
          home,
          "application",
          process.platform === "win32" ? "OMP Desktop.exe" : "omp-desktop",
        );
  const launcher = process.platform === "linux" ? fixture.executable : getBundledCliShimPath();
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "launcher", { mode: 0o755 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

describe("default CLI installation", () => {
  it("preserves the installed entry and shell configuration on repeated startup", async () => {
    await installCli();
    const target = getCliTargetPath();
    const before = await fs.lstat(target);
    const rc =
      process.platform === "win32" ? null : await fs.readFile(path.join(home, ".zshrc"), "utf8");
    await installCli();
    const after = await fs.lstat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    if (rc !== null) expect(await fs.readFile(path.join(home, ".zshrc"), "utf8")).toBe(rc);
  });

  it("replaces a launcher pointing at a removed application", async () => {
    const target = getCliTargetPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (process.platform === "win32") await fs.writeFile(target, "obsolete launcher");
    else await fs.symlink(path.join(home, "removed-application"), target);
    await installCli();
    if (process.platform === "win32")
      expect(await fs.readFile(target, "utf8")).not.toBe("obsolete launcher");
    else {
      const launcher = process.platform === "linux" ? fixture.executable : getBundledCliShimPath();
      expect(await fs.realpath(target)).toBe(await fs.realpath(launcher));
    }
  });

  it("reports an obstructed installation path without deleting its contents", async () => {
    const target = getCliTargetPath();
    await fs.mkdir(target, { recursive: true });
    const ownedFile = path.join(target, "keep.txt");
    await fs.writeFile(ownedFile, "keep");
    await expect(installCli()).rejects.toThrow();
    expect(await fs.readFile(ownedFile, "utf8")).toBe("keep");
  });
});
