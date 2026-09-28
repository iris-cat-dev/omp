import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { assertNativeKeyringBinding, prepareBundledOmp } =
  require("../../scripts/after-pack.js") as {
    assertNativeKeyringBinding: (resourcesDir: string, platform: string, arch: string) => void;
    prepareBundledOmp: (resourcesDir: string, platform: string, arch: string) => void;
  };

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { includeHelper: boolean }): {
  root: string;
  shimPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "paseo-cli-shim-test-"));
  const appPath = join(root, "Paseo.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const shimPath = join(resourcesPath, "bin", "paseo");
  const mainPath = join(contentsPath, "MacOS", "Paseo");
  const helperPath = join(
    contentsPath,
    "Frameworks",
    "Paseo Helper.app",
    "Contents",
    "MacOS",
    "Paseo Helper",
  );

  mkdirSync(dirname(shimPath), { recursive: true });
  mkdirSync(dirname(mainPath), { recursive: true });
  copyFileSync(join(packageRoot, "bin", "paseo"), shimPath);
  chmodSync(shimPath, 0o755);

  writeExecutable(mainPath, "#!/bin/sh\necho main-executable\n");

  if (options.includeHelper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeExecutable(
      helperPath,
      [
        "#!/bin/sh",
        'printf "helper env=%s/%s cli=%s\\n" "$ELECTRON_RUN_AS_NODE" "$PASEO_NODE_ENV" "$PASEO_CLI"',
        'printf "args=%s\\n" "$*"',
        "",
      ].join("\n"),
    );
  }

  return { root, shimPath };
}

describe("desktop packaging", () => {
  it("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@omp-desktop/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@omp-desktop/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  it("excludes package debug/source files from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!**/*.map");
    expect(config).toContain("!node_modules/@omp-desktop/*/src/**");
    expect(config).toContain("!node_modules/@omp-desktop/**/*.test.*");
    expect(config).toContain("!node_modules/@omp-desktop/**/*.spec.*");
  });

  it("excludes the bundled daemon web UI from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!node_modules/@omp-desktop/server/dist/server/web-ui/**");
  });

  it("uses the server skill catalog without a duplicate desktop resource", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    const serverPackage = readFileSync(join(packageRoot, "..", "server", "package.json"), "utf8");

    expect(config).not.toContain("from: ../../skills");
    expect(serverPackage).toContain("fs.rmSync('dist/server/skills',{recursive:true,force:true})");
    expect(serverPackage).toContain("fs.cpSync('../../skills','dist/server/skills'");
  });

  it("registers OMP Desktop agent links with the operating system", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("name: OMP Desktop agent link");
    expect(config).toContain("- omp-desktop");
  });

  it("defines a Windows package variant without the OMP executable", () => {
    const config = require("../../electron-builder-no-omp.cjs") as {
      win: { artifactName: string; extraResources: Array<{ to?: string }> };
    };

    expect(config.win.artifactName).toContain("No-OMP");
    expect(config.win.extraResources.some((resource) => resource.to === "bin/omp.exe")).toBe(false);
    expect(
      config.win.extraResources.some((resource) => resource.to === "bin/omp-desktop.cmd"),
    ).toBe(true);
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/paseo dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    for (const required of ["@omp-desktop/cli", "@omp-desktop/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBe("*");
    }
  });

  it("rejects Windows packages without the target keyring binding", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-keyring-package-test-"));
    try {
      expect(() => assertNativeKeyringBinding(resourcesDir, "win32", "x64")).toThrow(
        "Packaged Windows keyring binding is missing for x64",
      );
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it("accepts Windows packages containing the target keyring binding", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-keyring-package-test-"));
    const bindingPath = join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      "@napi-rs",
      "keyring-win32-arm64-msvc",
      "keyring.win32-arm64-msvc.node",
    );
    try {
      mkdirSync(dirname(bindingPath), { recursive: true });
      writeFileSync(bindingPath, "");

      expect(() => assertNativeKeyringBinding(resourcesDir, "win32", "arm64")).not.toThrow();
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it("removes OMP from packages built with bundling disabled", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-unbundled-package-test-"));
    const executablePath = join(resourcesDir, "bin", "omp.exe");
    const previous = process.env.OMP_DESKTOP_BUNDLE_OMP;
    try {
      mkdirSync(dirname(executablePath), { recursive: true });
      writeFileSync(executablePath, "not bundled");
      process.env.OMP_DESKTOP_BUNDLE_OMP = "0";

      prepareBundledOmp(resourcesDir, "win32", "x64");

      expect(() => readFileSync(executablePath)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.OMP_DESKTOP_BUNDLE_OMP;
      else process.env.OMP_DESKTOP_BUNDLE_OMP = previous;
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it("launches the packaged macOS CLI through Helper instead of the main app executable", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`helper env=1/production cli=${bundle.shimPath}`);
      expect(result.stdout).toContain("node-entrypoint-runner.js");
      expect(result.stdout).toContain("node-script");
      expect(result.stdout).toContain("@omp-desktop/cli/dist/index.js");
      expect(result.stdout).toContain("--version");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("fails packaged macOS CLI startup when Helper is missing", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: false });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Bundled Paseo Helper executable not found");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });
});
