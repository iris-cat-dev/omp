import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDesktopSdkRoot } from "./runtime-paths";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  app: {
    isPackaged: true,
  },
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
}));

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

const originalPlatform = process.platform;
const originalExecPath = process.execPath;
const originalResourcesPath = process.resourcesPath;

function setProcessRuntime(input: {
  platform: NodeJS.Platform;
  execPath: string;
  resourcesPath?: string;
}): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: input.platform,
  });
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: input.execPath,
  });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: input.resourcesPath,
  });
}

describe("runtime-paths", () => {
  beforeEach(() => {
    mocks.existsSync.mockReset();
    mocks.app.isPackaged = true;
    mocks.existsSync.mockReturnValue(true);
    setProcessRuntime({
      platform: "darwin",
      execPath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
      resourcesPath: "/Applications/Paseo.app/Contents/Resources",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProcessRuntime({
      platform: originalPlatform,
      execPath: originalExecPath,
      resourcesPath: originalResourcesPath,
    });
  });

  it("requires staged SDK resources without a PATH fallback", async () => {
    const fs = await vi.importActual<typeof NodeFs>("node:fs");
    const resourcesPath = fs.mkdtempSync(path.join(tmpdir(), "omp resources 中文 "));
    const sdkRoot = path.join(
      resourcesPath,
      "omp-sdk",
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
    );
    try {
      setProcessRuntime({ platform: originalPlatform, execPath: originalExecPath, resourcesPath });
      mocks.existsSync.mockImplementation(fs.existsSync);
      expect(() => resolveDesktopSdkRoot({ OMP_DESKTOP_SDK_ROOT: "/inherited/sdk" })).toThrow(
        "Bundled OMP SDK manifest is missing",
      );
      fs.mkdirSync(sdkRoot, { recursive: true });
      fs.writeFileSync(path.join(resourcesPath, "omp-sdk", "manifest.json"), "{}");
      expect(resolveDesktopSdkRoot({ OMP_DESKTOP_SDK_ROOT: "/inherited/sdk" })).toBe(sdkRoot);
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });

  it("preserves an explicit development SDK root", () => {
    mocks.app.isPackaged = false;
    expect(resolveDesktopSdkRoot({ OMP_DESKTOP_SDK_ROOT: "/custom/sdk" })).toBe("/custom/sdk");
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });

  it("prefers the canonical development stage and otherwise uses built submodule artifacts", () => {
    mocks.app.isPackaged = false;
    mocks.existsSync.mockReturnValue(true);
    expect(resolveDesktopSdkRoot({})).toMatch(
      /[\\/]desktop[\\/]sdk-dist[\\/]node_modules[\\/]@oh-my-pi[\\/]pi-coding-agent$/u,
    );
    mocks.existsSync.mockReturnValue(false);
    expect(resolveDesktopSdkRoot({})).toMatch(/[\\/]omp-sdk[\\/]packages[\\/]coding-agent$/u);
  });
});
