import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBundledOmpPath, resolveNodeExecPath } from "./runtime-paths";

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

vi.mock("@omp-desktop/server", () => ({
  spawnProcess: vi.fn(),
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

  it("uses the macOS Helper executable for packaged daemon node launches", () => {
    expect(resolveNodeExecPath()).toBe(
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
    );
  });

  it("resolves the packaged OMP executable from app resources", () => {
    expect(resolveBundledOmpPath()).toBe("/Applications/Paseo.app/Contents/Resources/bin/omp");

    setProcessRuntime({
      platform: "linux",
      execPath: "/opt/omp/omp-desktop",
      resourcesPath: "/opt/omp/resources",
    });
    expect(resolveBundledOmpPath()).toBe("/opt/omp/resources/bin/omp");

    setProcessRuntime({
      platform: "win32",
      execPath: "/opt/omp/OMP Desktop.exe",
      resourcesPath: "/opt/omp/resources",
    });
    expect(resolveBundledOmpPath()).toBe("/opt/omp/resources/bin/omp.exe");
  });

  it("falls back to OMP on PATH when a package does not bundle the executable", () => {
    mocks.existsSync.mockReturnValue(false);
    expect(resolveBundledOmpPath()).toBeNull();
  });

  it("does not resolve a bundled OMP executable during development", () => {
    mocks.app.isPackaged = false;
    expect(resolveBundledOmpPath()).toBeNull();
  });
});
