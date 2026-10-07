import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { execCommandMock, findExecutableMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  findExecutableMock: vi.fn(),
}));

vi.mock("../../../../executable-resolution/executable-resolution.js", () => ({
  findExecutable: findExecutableMock,
}));
vi.mock("../../../../utils/spawn.js", () => ({
  execCommand: execCommandMock,
}));

import {
  applyPendingOmpUpdate,
  cancelOmpInstall,
  compareOmpVersions,
  ensureManagedOmpOnPath,
  getOmpInstallationStatus,
  installOmp,
  OmpExecutableBusyError,
  replaceManagedOmpBinary,
  resolveManagedOmpInstallPath,
  resolveOmpUpdatePaths,
} from "./installer.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OMP_COMMAND", "");
  vi.stubEnv("PASEO_DESKTOP_MANAGED", "");
  vi.stubEnv("PI_INSTALL_DIR", "");
  findExecutableMock.mockResolvedValue("/mock/bin/omp");
  execCommandMock.mockResolvedValue({ stdout: "omp/18.1.5", stderr: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function createPendingFetch(markStarted: () => void) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const rejectWithAbortReason = () => reject(init?.signal?.reason);
      init?.signal?.addEventListener("abort", rejectWithAbortReason, { once: true });
    });
  });
}

describe("OMP managed installer", () => {
  test("uses the official per-user install location on macOS and Linux", () => {
    expect(resolveManagedOmpInstallPath("darwin", {}, "/Users/test")).toBe(
      join("/Users/test", ".local", "bin", "omp"),
    );
    expect(resolveManagedOmpInstallPath("linux", {}, "/home/test")).toBe(
      join("/home/test", ".local", "bin", "omp"),
    );
  });

  test("uses LOCALAPPDATA for Windows", () => {
    expect(
      resolveManagedOmpInstallPath(
        "win32",
        { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        "C:\\Users\\test",
      ),
    ).toBe(join("C:\\Users\\test\\AppData\\Local", "omp", "omp.exe"));
  });

  test("reports the configured Desktop runtime instead of another OMP on PATH", async () => {
    const bundledPath = "C:\\Program Files\\OMP Desktop\\resources\\bin\\omp.exe";
    const standalonePath = "C:\\Users\\test\\AppData\\Local\\omp\\omp.exe";
    vi.stubEnv("OMP_COMMAND", bundledPath);
    vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
    findExecutableMock.mockImplementation(async (command: string) =>
      command === bundledPath ? bundledPath : standalonePath,
    );
    execCommandMock.mockImplementation(async (command: string) => ({
      stdout: command === bundledPath ? "omp/18.4.4" : "omp/18.6.1",
      stderr: "",
    }));

    await expect(getOmpInstallationStatus()).resolves.toMatchObject({
      installed: true,
      version: "omp/18.4.4",
      installPath: bundledPath,
      source: "bundled",
    });
    expect(findExecutableMock).toHaveBeenCalledWith(bundledPath);
    expect(execCommandMock).toHaveBeenCalledWith(
      bundledPath,
      ["--version"],
      expect.objectContaining({ envMode: "internal" }),
    );
  });

  test("uses durable next and previous executable names on Windows", () => {
    expect(resolveOmpUpdatePaths("C:\\Users\\test\\omp\\omp.exe", "win32")).toEqual({
      stagedPath: "C:\\Users\\test\\omp\\omp.next.exe",
      checksumPath: "C:\\Users\\test\\omp\\omp.next.exe.sha256",
      previousPath: "C:\\Users\\test\\omp\\omp.previous.exe",
    });
  });

  test("prepends the managed install directory to PATH once", () => {
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/local/bin", "/usr/bin"].join(delimiter) };
    ensureManagedOmpOnPath("darwin", env);
    ensureManagedOmpOnPath("darwin", env);

    const installDirectory = dirname(resolveManagedOmpInstallPath("darwin", env));
    expect(env.PATH?.split(delimiter)).toEqual([installDirectory, "/usr/local/bin", "/usr/bin"]);
  });

  test("compares installed and latest OMP versions without offering downgrades", () => {
    expect(compareOmpVersions("omp/18.0.4", "v18.0.4")).toBe(0);
    expect(compareOmpVersions("oh-my-pi v17.9.9", "18.0.0")).toBe(-1);
    expect(compareOmpVersions("omp 19.0.0", "v18.2.3")).toBe(1);
    expect(compareOmpVersions("unknown", "v18.2.3")).toBeNull();
  });

  test("checks the latest version through the public release redirect", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://github.com/can1357/oh-my-pi/releases/tag/v18.1.8",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOmpInstallationStatus({ checkForUpdates: true })).resolves.toMatchObject({
      installed: true,
      version: "omp/18.1.5",
      latestVersion: "18.1.8",
      updateAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/can1357/oh-my-pi/releases/latest",
      expect.objectContaining({ method: "HEAD", redirect: "follow" }),
    );
  });

  test("keeps the installed status when the update check is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        url: "https://github.com/can1357/oh-my-pi/releases/latest",
      } as Response),
    );

    await expect(getOmpInstallationStatus({ checkForUpdates: true })).resolves.toMatchObject({
      installed: true,
      version: "omp/18.1.5",
      message:
        "Failed to check for OMP updates: Failed to resolve the latest OMP release: HTTP 403",
    });
  });

  test("maps a locked Windows executable to an actionable update error", async () => {
    const busyError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const fileSystem = {
      access: vi.fn(async (path: string) => {
        if (path === "omp.exe") return;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }),
      rename: vi.fn(async (from: string) => {
        if (from === "omp.exe") throw busyError;
      }),
      rm: vi.fn(async () => {}),
    };

    await expect(
      replaceManagedOmpBinary({
        installPath: "omp.exe",
        stagedPath: "omp.next.exe",
        previousPath: "omp.previous.exe",
        platform: "win32",
        fileSystem,
        validate: vi.fn(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: OmpExecutableBusyError.name,
        message:
          "OMP is still running. Exit OMP Desktop and restart it to finish the staged update.",
      }),
    );
    expect(fileSystem.rename).toHaveBeenCalledTimes(1);
  });

  test("restores the previous binary when post-install validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-installer-"));
    const installPath = join(directory, "omp");
    const stagedPath = join(directory, "omp.next");
    const previousPath = join(directory, "omp.previous");
    await writeFile(installPath, "old");
    await writeFile(stagedPath, "invalid-new");

    try {
      await expect(
        replaceManagedOmpBinary({
          installPath,
          stagedPath,
          previousPath,
          validate: async () => {
            throw new Error("invalid binary");
          },
        }),
      ).rejects.toThrow("invalid binary");
      await expect(readFile(installPath, "utf8")).resolves.toBe("old");
      await expect(access(stagedPath)).rejects.toThrow();
      await expect(access(previousPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("applies a verified pending update to the configured runtime before Agents start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-pending-update-"));
    const installPath = join(directory, "bundled", "omp.exe");
    const managedDirectory = join(directory, "managed");
    const { stagedPath, checksumPath, previousPath } = resolveOmpUpdatePaths(installPath, "win32");
    findExecutableMock.mockResolvedValue(installPath);
    const nextBinary = Buffer.from("verified-new");
    await mkdir(dirname(installPath), { recursive: true });
    await writeFile(installPath, "old");
    await writeFile(stagedPath, nextBinary);
    await writeFile(checksumPath, createHash("sha256").update(nextBinary).digest("hex"));

    try {
      await expect(
        applyPendingOmpUpdate({
          platform: "win32",
          env: {
            OMP_COMMAND: installPath,
            PASEO_DESKTOP_MANAGED: "1",
            PI_INSTALL_DIR: managedDirectory,
          },
          home: directory,
        }),
      ).resolves.toEqual({ applied: true, pending: false });
      await expect(readFile(installPath)).resolves.toEqual(nextBinary);
      await expect(access(stagedPath)).rejects.toThrow();
      await expect(access(checksumPath)).rejects.toThrow();
      await expect(access(previousPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("downloads and replaces the configured Desktop runtime without touching managed OMP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-bundled-update-"));
    const installPath = join(directory, "resources", "bin", "omp");
    const managedPath = join(directory, "managed", "omp");
    const nextBinary = Buffer.from("downloaded-bundled-runtime");
    const checksum = createHash("sha256").update(nextBinary).digest("hex");
    const checksumManifest = [
      "omp-windows-x64.exe",
      "omp-windows-arm64.exe",
      "omp-darwin-x64",
      "omp-darwin-arm64",
      "omp-linux-x64",
      "omp-linux-arm64",
      "omp-linux-musl-x64",
      "omp-linux-musl-arm64",
    ]
      .map((asset) => `${checksum}  ${asset}`)
      .join("\n");
    await mkdir(dirname(installPath), { recursive: true });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(installPath, "current-bundled-runtime");
    await writeFile(managedPath, "standalone-runtime");
    vi.stubEnv("OMP_COMMAND", installPath);
    vi.stubEnv("PASEO_DESKTOP_MANAGED", "1");
    vi.stubEnv("PI_INSTALL_DIR", dirname(managedPath));
    findExecutableMock.mockResolvedValue(installPath);
    execCommandMock.mockImplementation(async (command: string) => {
      const contents = await readFile(command, "utf8");
      return {
        stdout: contents === "current-bundled-runtime" ? "omp/18.1.5" : "omp/18.1.8",
        stderr: "",
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/releases/latest")) {
          return {
            ok: true,
            status: 200,
            url: "https://github.com/can1357/oh-my-pi/releases/tag/v18.1.8",
          } as Response;
        }
        if (url.endsWith("/SHA256SUMS.txt")) return new Response(checksumManifest);
        return new Response(nextBinary);
      }),
    );

    try {
      await expect(installOmp()).resolves.toMatchObject({
        installed: true,
        version: "omp/18.1.8",
        installPath,
        source: "bundled",
        updatePhase: "complete",
      });
      await expect(readFile(installPath)).resolves.toEqual(nextBinary);
      await expect(readFile(managedPath, "utf8")).resolves.toBe("standalone-runtime");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("coalesces concurrent install requests into one update operation", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("release unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const first = installOmp();
    const second = installOmp();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow("release unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("can cancel an update while the release request is in flight", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal("fetch", createPendingFetch(markStarted));

    const installation = installOmp();
    await started;
    await expect(getOmpInstallationStatus()).resolves.toMatchObject({
      installed: true,
      updatePhase: "downloading",
      updateProgress: 0,
    });
    await expect(cancelOmpInstall()).resolves.toMatchObject({
      installed: true,
      updatePhase: "canceled",
      message: "OMP update canceled",
    });
    await expect(installation).resolves.toMatchObject({ updatePhase: "canceled" });
  });
});
