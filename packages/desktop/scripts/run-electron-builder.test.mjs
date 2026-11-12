import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { createQualifiedPackager } from "./run-electron-builder.mjs";
import { windowsBuildOutput } from "./windows-build-output.mjs";
import { stageNodeSdk } from "../../../omp-sdk/scripts/stage-node-sdk.mjs";
import { resolveOmpSdkBuildConfig } from "../../../scripts/omp-sdk-build-config.mjs";

const require = createRequire(import.meta.url);
const { WinPackager } = require("app-builder-lib/out/winPackager");
const { copyFiles, getMainFileMatchers } = require("app-builder-lib/out/fileMatcher");
const { Arch } = require("builder-util");
const { Platform } = require("app-builder-lib/out/core");

const scriptPath = fileURLToPath(new URL("./run-electron-builder.mjs", import.meta.url));

test("absolute symlinked CLI paths still validate builds", () => {
  const fixture = createPackagingFixture();
  try {
    const link = path.join(fixture.directory, "linked-scripts");
    symlinkSync(path.dirname(scriptPath), link, process.platform === "win32" ? "junction" : "dir");
    const build = spawnSync(
      process.execPath,
      [path.join(link, "run-electron-builder.mjs"), "--mac", "--arm64", "--publish", "never"],
      {
        cwd: fixture.directory,
        encoding: "utf8",
        env: { ...process.env, MINI_ELECTRON_DIST_PATH: fixture.runtimeDist },
        timeout: 20_000,
      },
    );
    expect(build.error).toBeUndefined();
    expect(build.status).toBe(1);
    expect(build.stderr).toContain("Cannot package darwin-arm64 with the win32-x64 runtime");
  } finally {
    fixture.dispose();
  }
});

test("reports packaging failures even when dependency exit handlers reset the status", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omp-packaging-exit-"));
  try {
    const preload = path.join(directory, "reset-exit.cjs");
    writeFileSync(preload, 'process.on("exit", () => { process.exitCode = 0; });\n');
    const result = spawnSync(process.execPath, [scriptPath, "--with-bundled-plugins"], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("obsolete OMP executable host");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaging runtime compatibility", () => {
  test.each([
    {
      runtime: { platform: "win32", arch: "x64" },
      args: ["--mac", "--arm64"],
      target: "darwin-arm64",
    },
    {
      runtime: { platform: "darwin", arch: "arm64" },
      args: ["--win", "--x64"],
      target: "win32-x64",
    },
    {
      runtime: { platform: "win32", arch: "x64" },
      args: ["--win", "--arm64"],
      target: "win32-arm64",
    },
    {
      runtime: { platform: "darwin", arch: "arm64" },
      args: ["--mac", "dmg:x64"],
      target: "darwin-x64",
    },
  ])(
    "rejects $target with a $runtime.platform-$runtime.arch runtime",
    ({ runtime, args, target }) => {
      const runtimeDist = mkdtempSync(path.join(os.tmpdir(), "omp-runtime-target-"));
      try {
        writeFileSync(
          path.join(runtimeDist, "version.json"),
          JSON.stringify({
            ...runtime,
            runtimeVersion: "0.1.17",
            electronApiVersion: "41.2.0",
          }),
        );
        const result = spawnSync(process.execPath, [scriptPath, ...args, "--publish", "never"], {
          cwd: path.resolve(path.dirname(scriptPath), ".."),
          encoding: "utf8",
          env: { ...process.env, MINI_ELECTRON_DIST_PATH: runtimeDist },
          timeout: 20_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(target);
        expect(result.stderr).toContain(`${runtime.platform}-${runtime.arch}`);
        expect(result.stderr).toContain(runtimeDist);
      } finally {
        rmSync(runtimeDist, { recursive: true, force: true });
      }
    },
  );

  test.each([undefined, {}, { nativeClipboardFiles: true }, { nativeClipboardFiles: 2 }])(
    "rejects Windows runtimes without the implemented clipboard-file capability (%j)",
    async (features) => {
      const fixture = createPackagingFixture("win32", "99.0.0");
      try {
        await expect(
          createQualifiedPackager(
            fixture.runtimeDist,
            { ...fixture.runtime, features },
            fixture.args,
            fixture.directory,
          ),
        ).rejects.toThrow("nativeClipboardFiles=1");
      } finally {
        fixture.dispose();
      }
    },
  );

  test.each([undefined, true, 0, 2])(
    "rejects Windows runtimes without verified async context propagation (%j)",
    async (asyncContextPropagation) => {
      const fixture = createPackagingFixture("win32", "99.0.0");
      try {
        await expect(
          createQualifiedPackager(
            fixture.runtimeDist,
            { ...fixture.runtime, features: { nativeClipboardFiles: 1, asyncContextPropagation } },
            fixture.args,
            fixture.directory,
          ),
        ).rejects.toThrow("asyncContextPropagation=1");
      } finally {
        fixture.dispose();
      }
    },
  );

  test.each([undefined, true, 0, 2])(
    "rejects Windows runtimes without asynchronous broker storage persistence (%j)",
    async (asyncStoragePersistence) => {
      const fixture = createPackagingFixture("win32", "99.0.0");
      try {
        await expect(
          createQualifiedPackager(
            fixture.runtimeDist,
            {
              ...fixture.runtime,
              features: { ...fixture.runtime.features, asyncStoragePersistence },
            },
            fixture.args,
            fixture.directory,
          ),
        ).rejects.toThrow("asyncStoragePersistence=1");
      } finally {
        fixture.dispose();
      }
    },
  );

  test.each([
    {
      name: "installer protocol",
      overrides: { installerProtocol: 2 },
      message: "executable metadata",
    },
    {
      name: "executable inventory",
      overrides: { files: {} },
      message: "executable metadata",
    },
    {
      name: "runtime version",
      overrides: { runtimeVersion: undefined },
      message: "runtime metadata",
    },
  ])("rejects incompatible or missing $name on a newer runtime", async ({ overrides, message }) => {
    const fixture = createPackagingFixture("darwin");
    try {
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          { ...fixture.runtime, ...overrides },
          fixture.args,
          fixture.directory,
        ),
      ).rejects.toThrow(message);
    } finally {
      fixture.dispose();
    }
  });
});

function createPackagingFixture(
  platform = "win32",
  runtimeVersion = platform === "win32" ? "0.1.18" : "0.1.17",
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omp-build-options-"));
  const executable = platform === "win32" ? "electron.exe" : "Electron.app/Contents/MacOS/Electron";
  const runtimeDist = path.join(directory, "runtime");
  mkdirSync(path.dirname(path.join(runtimeDist, executable)), {
    recursive: true,
  });
  const executableBytes = Buffer.from("mini-electron packaging unit fixture");
  writeFileSync(path.join(runtimeDist, executable), executableBytes);
  const runtime = {
    platform,
    arch: platform === "win32" ? "x64" : "arm64",
    runtimeVersion,
    electronApiVersion: "41.2.0",
    installerProtocol: 1,
    features:
      platform === "win32"
        ? { nativeClipboardFiles: 1, asyncContextPropagation: 1, asyncStoragePersistence: 1 }
        : {},
    files: {
      [executable]: createHash("sha256").update(executableBytes).digest("hex"),
    },
  };
  writeFileSync(path.join(runtimeDist, "version.json"), JSON.stringify(runtime));
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "packaging-fixture",
      version: "1.0.0",
      description: "Owned packaging fixture",
      author: "OMP Desktop",
    }),
  );
  writeFileSync(
    path.join(directory, "electron-builder.yml"),
    [
      "directories:",
      "  output: release",
      "win:",
      '  artifactName: "OMP-Desktop-Setup-${version}-${arch}.${ext}"',
      "  signAndEditExecutable: true",
      "  extraResources:",
      "    - from: assets/icon.png",
      "      to: icon.png",
    ].join("\n"),
  );
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "assets/icon.png"), "icon fixture");
  const { source } = resolveOmpSdkBuildConfig();
  const stage = path.join(directory, "sdk-dist");
  const packageRoot = "node_modules/@oh-my-pi/pi-coding-agent";
  mkdirSync(path.join(stage, packageRoot, "dist/node"), { recursive: true });
  writeFileSync(
    path.join(stage, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@oh-my-pi/pi-coding-agent",
      packageRoot,
      platform: runtime.platform,
      arch: runtime.arch,
      buildTarget: "desktop",
      profile: "core",
    }),
  );
  writeFileSync(
    path.join(stage, "source.json"),
    JSON.stringify({ packageRoot: realpathSync(source) }),
  );
  writeFileSync(
    path.join(stage, packageRoot, "package.json"),
    JSON.stringify({
      name: "@oh-my-pi/pi-coding-agent",
      ompNodeSdk: { target: "desktop", profile: "core" },
    }),
  );
  for (const file of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"])
    writeFileSync(path.join(stage, packageRoot, "dist/node", file), "owned SDK artifact");
  return {
    directory,
    runtimeDist,
    runtime,
    args: platform === "win32" ? ["--win", "--x64"] : ["--mac", "--arm64"],
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test.each([
  { requested: "generic", staged: undefined },
  { requested: "generic", staged: "generic" },
  { requested: "desktop", staged: "desktop" },
])("copies a matching $requested SDK outside ASAR (metadata: $staged)", ({ requested, staged }) => {
  const fixture = createPackagingFixture("darwin");
  try {
    const source = path.join(fixture.directory, "sdk-source");
    mkdirSync(source);
    const stage = path.join(fixture.directory, "sdk-dist");
    const packageRoot = "node_modules/@oh-my-pi/pi-coding-agent";
    const payload = [
      [
        "manifest.json",
        JSON.stringify({
          schemaVersion: 1,
          packageName: "@oh-my-pi/pi-coding-agent",
          packageRoot,
          platform: fixture.runtime.platform,
          arch: fixture.runtime.arch,
          buildTarget: staged,
        }),
      ],
      ["source.json", JSON.stringify({ packageRoot: realpathSync(source) })],
      ["omp-sdk.tgz", "owned SDK archive"],
      [
        `${packageRoot}/package.json`,
        JSON.stringify({
          name: "@oh-my-pi/pi-coding-agent",
          version: "1.0.0",
          ompNodeSdk: staged ? { target: staged } : undefined,
        }),
      ],
      ...["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"].map((file) => [
        `${packageRoot}/dist/node/${file}`,
        "owned SDK artifact",
      ]),
      [
        `${packageRoot}/node_modules/@oh-my-pi/pi-utils/dist/node/runtime.mjs`,
        "owned runtime artifact",
      ],
      [
        `${packageRoot}/node_modules/@oh-my-pi/pi-natives/native/pi_natives.darwin-arm64.node`,
        "owned native artifact",
      ],
    ];
    for (const [relative, content] of payload) {
      const file = path.join(stage, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { createRequire } from "node:module";
      import { createQualifiedPackager } from ${JSON.stringify(new URL("./run-electron-builder.mjs", import.meta.url).href)};
      const require = createRequire(${JSON.stringify(import.meta.url)});
      const { copyFiles, getFileMatchers } = require("app-builder-lib/out/fileMatcher");
      const root = ${JSON.stringify(fixture.directory)};
      const packager = await createQualifiedPackager(
        ${JSON.stringify(fixture.runtimeDist)}, ${JSON.stringify(fixture.runtime)},
        ${JSON.stringify(fixture.args)}, root,
      );
      const destination = path.join(root, "out/resources");
      fs.mkdirSync(destination, { recursive: true });
      await copyFiles(getFileMatchers(packager.config, "extraResources", destination, {
        defaultSrc: root, globalOutDir: path.join(root, "out"),
        macroExpander: value => value, customBuildOptions: packager.config.mac ?? {},
      }), null, false);
      for (const [relative, content] of ${JSON.stringify(payload.filter(([relative]) => relative !== "source.json" && relative !== "omp-sdk.tgz"))}) {
        assert.equal(fs.readFileSync(path.join(destination, "omp-sdk", relative), "utf8"), content);
      }
      assert.equal(fs.existsSync(path.join(destination, "omp-sdk/source.json")), false);
      assert.equal(fs.existsSync(path.join(destination, "omp-sdk/omp-sdk.tgz")), false);
      fs.rmSync(path.join(root, "sdk-dist", ${JSON.stringify(packageRoot)}, "dist/node/plugins.mjs"));
      await assert.rejects(
        createQualifiedPackager(
          ${JSON.stringify(fixture.runtimeDist)}, ${JSON.stringify(fixture.runtime)},
          ${JSON.stringify(fixture.args)}, root,
        ),
        /Required SDK payload is incomplete: dist\\/node\\/plugins\\.mjs/,
      );
    `,
      ],
      {
        cwd: fixture.directory,
        encoding: "utf8",
        env: {
          ...process.env,
          OMP_DESKTOP_SDK_SOURCE: source,
          OMP_DESKTOP_SDK_TARGET: requested,
          OMP_DESKTOP_SDK_PROFILE: "full",
        },
        timeout: 20_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    fixture.dispose();
  }
});

test.each([
  { requested: "desktop", staged: undefined },
  { requested: "generic", staged: "desktop" },
  { requested: "unknown", staged: "generic" },
  { requested: "desktop", staged: "desktop", installed: "generic" },
])(
  "rejects stale SDK target $staged/$installed when requesting $requested",
  async ({ requested, staged, installed }) => {
    const fixture = createPackagingFixture("darwin");
    try {
      const source = path.join(fixture.directory, "sdk-source");
      const stage = path.join(fixture.directory, "sdk-dist");
      mkdirSync(source);
      mkdirSync(stage, { recursive: true });
      writeFileSync(
        path.join(stage, "source.json"),
        JSON.stringify({ packageRoot: realpathSync(source) }),
      );
      writeFileSync(
        path.join(stage, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          packageName: "@oh-my-pi/pi-coding-agent",
          packageRoot: "node_modules/@oh-my-pi/pi-coding-agent",
          platform: fixture.runtime.platform,
          arch: fixture.runtime.arch,
          buildTarget: staged,
        }),
      );
      const packageRoot = path.join(stage, "node_modules/@oh-my-pi/pi-coding-agent");
      mkdirSync(path.join(packageRoot, "dist/node"), { recursive: true });
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@oh-my-pi/pi-coding-agent",
          ompNodeSdk: installed ? { target: installed } : undefined,
        }),
      );
      for (const file of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"])
        writeFileSync(path.join(packageRoot, "dist/node", file), "owned SDK artifact");
      vi.stubEnv("OMP_DESKTOP_SDK_SOURCE", source);
      vi.stubEnv("OMP_DESKTOP_SDK_TARGET", requested);
      vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", "full");
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          fixture.runtime,
          fixture.args,
          fixture.directory,
        ),
      ).rejects.toThrow("OMP_DESKTOP_SDK_TARGET");
    } finally {
      vi.unstubAllEnvs();
      fixture.dispose();
    }
  },
);

function createSdkFixture(buildTarget = "desktop", { native = buildTarget === "generic" } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omp-sdk-stage-"));
  const source = path.join(directory, "source");
  const sdkName = "@oh-my-pi/pi-coding-agent";
  const artifact = `dist/${buildTarget === "desktop" ? "node-desktop" : "node"}`;
  const files = {
    "package.json": JSON.stringify({
      name: sdkName,
      version: "1.0.0",
      type: "module",
      bin: { omp: "./dist/cli.js" },
      exports: { ".": "./dist/node/sdk.mjs" },
    }),
    "data/resource.txt": "owned SDK resource",
    [`${artifact}/sdk.mjs`]: 'export { marker } from "./chunks/shared.mjs";',
    [`${artifact}/rpc.mjs`]: 'export { marker } from "./chunks/shared.mjs";',
    [`${artifact}/host.mjs`]: 'export { marker } from "./chunks/shared.mjs";',
    [`${artifact}/plugins.mjs`]: 'export { marker } from "./chunks/shared.mjs";',
    [`${artifact}/chunks/shared.mjs`]: `export const marker = ${JSON.stringify(buildTarget)};`,
    [`${artifact}/modules/root.mjs`]: 'export { marker } from "../chunks/shared.mjs";',
    [`${artifact}/modules.json`]: JSON.stringify({
      version: 1,
      buildTarget,
      modules: { [sdkName]: "./modules/root.mjs" },
    }),
  };
  const packages = {
    [sdkName]: {
      files: [...Object.keys(files), `${artifact}/runtime-dependencies.json`],
      dependencies: [
        "@oh-my-pi/pi-utils",
        ...(native ? ["@oh-my-pi/pi-natives"] : []),
        "sdk-optional-capability",
      ],
      optionalDependencies: ["missing-optional-peer"],
    },
    "@oh-my-pi/pi-utils": {
      files: [
        "package.json",
        ...["runtime.mjs", "runtime-image.mjs", "sqlite-driver.mjs"].map(
          (name) => `dist/node/${name}`,
        ),
      ],
      dependencies: [],
    },
    "sdk-optional-capability": {
      files: ["package.json", "index.js"],
      dependencies: [],
    },
  };
  if (native) {
    packages["@oh-my-pi/pi-natives"] = {
      files: ["package.json", `native/pi_natives.${process.platform}-${process.arch}.node`],
      dependencies: [],
    };
  }
  files[`${artifact}/runtime-dependencies.json`] = JSON.stringify({
    version: 1,
    buildTarget,
    optionalCapabilities: { fixture: ["sdk-optional-capability"] },
    packages,
  });
  for (const [name, scope] of Object.entries(packages)) {
    if (name === sdkName) continue;
    for (const relative of scope.files) {
      files[`node_modules/${name}/${relative}`] =
        relative === "package.json"
          ? JSON.stringify({ name, version: "1.0.0", main: "index.js" })
          : "owned dependency resource";
    }
  }
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    directory,
    source,
    artifact,
    output: path.join(directory, "stage"),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("SDK artifact target staging", () => {
  test("development output loads SDK entries, registry modules and resources without a checkout or archive", async () => {
    const fixture = createSdkFixture("generic");
    try {
      writeFileSync(
        path.join(fixture.source, fixture.artifact, "sdk.mjs"),
        'import { readFileSync } from "node:fs"; export { marker } from "./chunks/shared.mjs"; export const resource = readFileSync(new URL("../../data/resource.txt", import.meta.url), "utf8");',
      );
      const result = await stageNodeSdk(fixture.source, fixture.output, {
        buildTarget: "generic",
        buildMode: "development",
        profile: "core",
        cacheDir: path.join(fixture.directory, "cache"),
      });
      expect(result.archive).toBeNull();
      expect(existsSync(path.join(fixture.output, "omp-sdk.tgz"))).toBe(false);
      expect(result.dependencyInputs).toContainEqual({
        name: "missing-optional-peer",
        owner: realpathSync(fixture.source),
        directory: null,
      });
      const metadata = JSON.parse(readFileSync(path.join(fixture.output, "manifest.json"), "utf8"));
      const installed = JSON.parse(
        readFileSync(path.join(result.directory, "package.json"), "utf8"),
      );
      expect(metadata.buildMode).toBe("development");
      expect(installed.ompNodeSdk.buildMode).toBe("development");
      rmSync(fixture.source, { recursive: true, force: true });
      const consumed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            `import { marker, resource } from ${JSON.stringify(pathToFileURL(path.join(result.directory, "dist/node/sdk.mjs")).href)};`,
            `import { marker as plugin } from ${JSON.stringify(pathToFileURL(path.join(result.directory, "dist/node/plugins.mjs")).href)};`,
            `import { marker as module } from ${JSON.stringify(pathToFileURL(path.join(result.directory, "dist/node/modules/root.mjs")).href)};`,
            "process.stdout.write(JSON.stringify({ marker, resource, plugin, module }));",
          ].join("\n"),
        ],
        { cwd: fixture.output, encoding: "utf8" },
      );
      expect(consumed.error).toBeUndefined();
      expect(consumed.status, consumed.stderr).toBe(0);
      expect(JSON.parse(consumed.stdout)).toEqual({
        marker: "generic",
        resource: "owned SDK resource",
        plugin: "generic",
        module: "generic",
      });
    } finally {
      fixture.dispose();
    }
  });

  test("persistent package lists preserve local edits, ignore rules, additions and removals at the same package version", async () => {
    const fixture = createSdkFixture("generic");
    try {
      const name = "sdk-local-runtime";
      const dependency = path.join(fixture.directory, "workspace-runtime");
      mkdirSync(dependency);
      symlinkSync(
        dependency,
        path.join(fixture.source, "node_modules", name),
        process.platform === "win32" ? "junction" : "dir",
      );
      const packageFile = path.join(dependency, "package.json");
      writeFileSync(
        packageFile,
        JSON.stringify({
          name,
          version: "1.0.0",
          main: "index.cjs",
        }),
      );
      writeFileSync(path.join(dependency, "index.cjs"), 'module.exports = "first";');
      writeFileSync(path.join(dependency, "hidden-a.txt"), "first resource");
      writeFileSync(path.join(dependency, "hidden-b.txt"), "other resource");
      const ignore = path.join(dependency, ".npmignore");
      writeFileSync(ignore, "hidden-a.txt\n");
      const runtimeFile = path.join(fixture.source, fixture.artifact, "runtime-dependencies.json");
      const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
      runtime.packages["@oh-my-pi/pi-coding-agent"].dependencies.push(name);
      writeFileSync(runtimeFile, JSON.stringify(runtime));
      const options = {
        buildTarget: "generic",
        buildMode: "development",
        profile: "core",
        cacheDir: path.join(fixture.directory, "cache"),
      };
      const stage = async () => {
        const result = await stageNodeSdk(fixture.source, fixture.output, options);
        return path.join(result.directory, "node_modules", name);
      };
      let installed = await stage();
      expect(existsSync(path.join(installed, "hidden-a.txt"))).toBe(false);
      expect(readFileSync(path.join(installed, "hidden-b.txt"), "utf8")).toBe("other resource");
      const times = statSync(ignore);
      writeFileSync(ignore, "hidden-b.txt\n");
      utimesSync(ignore, times.atime, times.mtime);
      const entryTimes = statSync(path.join(dependency, "index.cjs"));
      writeFileSync(path.join(dependency, "index.cjs"), 'module.exports = "later";');
      utimesSync(path.join(dependency, "index.cjs"), entryTimes.atime, entryTimes.mtime);
      installed = await stage();
      expect(readFileSync(path.join(installed, "index.cjs"), "utf8")).toContain('"later"');
      expect(readFileSync(path.join(installed, "hidden-a.txt"), "utf8")).toBe("first resource");
      expect(existsSync(path.join(installed, "hidden-b.txt"))).toBe(false);
      writeFileSync(path.join(dependency, "added.txt"), "new resource");
      installed = await stage();
      expect(readFileSync(path.join(installed, "added.txt"), "utf8")).toBe("new resource");
      rmSync(path.join(dependency, "added.txt"));
      installed = await stage();
      expect(existsSync(path.join(installed, "added.txt"))).toBe(false);
      writeFileSync(
        packageFile,
        JSON.stringify({
          name,
          version: "1.0.0",
          main: "index.cjs",
          files: ["*.cjs"],
        }),
      );
      installed = await stage();
      expect(existsSync(path.join(installed, "hidden-a.txt"))).toBe(false);
      const cachedLists = path.join(options.cacheDir, "npm-pack-files");
      for (const entry of readdirSync(cachedLists)) {
        const file = path.join(cachedLists, entry);
        const cached = JSON.parse(readFileSync(file, "utf8"));
        cached.files = ["package.json", "../escaped.txt"];
        writeFileSync(file, JSON.stringify(cached));
      }
      installed = await stage();
      expect(readFileSync(path.join(installed, "index.cjs"), "utf8")).toContain('"later"');
      expect(existsSync(path.join(fixture.output, "escaped.txt"))).toBe(false);
      for (const entry of readdirSync(cachedLists)) {
        const file = path.join(cachedLists, entry);
        const cached = JSON.parse(readFileSync(file, "utf8"));
        cached.files = ["package.json"];
        writeFileSync(file, JSON.stringify(cached));
      }
      installed = await stage();
      expect(readFileSync(path.join(installed, "index.cjs"), "utf8")).toContain('"later"');
      for (const entry of readdirSync(cachedLists))
        writeFileSync(path.join(cachedLists, entry), "{");
      installed = await stage();
      expect(readFileSync(path.join(installed, "index.cjs"), "utf8")).toContain('"later"');
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  test.each([
    "chunks/shared.mjs",
    "modules/root.mjs",
    "../../data/resource.txt",
    `../../node_modules/@oh-my-pi/pi-natives/native/pi_natives.${process.platform}-${process.arch}.node`,
  ])("development staging rejects missing runtime content %s", async (relative) => {
    const fixture = createSdkFixture("generic");
    try {
      rmSync(path.join(fixture.source, fixture.artifact, relative));
      await expect(
        stageNodeSdk(fixture.source, fixture.output, {
          buildTarget: "generic",
          buildMode: "development",
          profile: "core",
        }),
      ).rejects.toThrow();
      expect(existsSync(fixture.output)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  test.each(["full", "core"])(
    "packs the generic %s package and tar without its source",
    async (profile) => {
      const fixture = createSdkFixture("generic");
      try {
        // Desktop artifacts must not leak into the generic package.
        mkdirSync(path.join(fixture.source, "dist/node-desktop"), {
          recursive: true,
        });
        writeFileSync(
          path.join(fixture.source, "dist/node-desktop/desktop-only.mjs"),
          "desktop artifact",
        );
        vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "generic");
        vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", profile);
        const result = await stageNodeSdk(
          fixture.source,
          fixture.output,
          resolveOmpSdkBuildConfig(),
        );
        const manifest = JSON.parse(
          readFileSync(path.join(result.directory, "package.json"), "utf8"),
        );
        const runtime = JSON.parse(
          readFileSync(path.join(result.directory, "dist/node/runtime-dependencies.json"), "utf8"),
        );
        expect(manifest.ompNodeSdk.profile).toBe(profile);
        expect(manifest.ompNodeSdk.target).toBe("generic");
        expect(runtime.buildTarget).toBe("generic");
        expect(manifest.bin).toBeUndefined();
        expect(manifest.files).toContain("dist/node/sdk.mjs");
        expect(manifest.files).toContain("dist/node/plugins.mjs");
        expect(runtime.packages["@oh-my-pi/pi-coding-agent"].files).toContain(
          "dist/node/plugins.mjs",
        );
        expect(manifest.files.some((relative) => relative.startsWith("dist/node-desktop/"))).toBe(
          false,
        );
        expect(existsSync(path.join(result.directory, "dist/node-desktop"))).toBe(false);
        expect(
          existsSync(path.join(result.directory, "node_modules/sdk-optional-capability")),
        ).toBe(profile === "full");
        expect(manifest.dependencies["@oh-my-pi/pi-natives"]).toBe("1.0.0");
        expect(
          existsSync(
            path.join(
              result.directory,
              `node_modules/@oh-my-pi/pi-natives/native/pi_natives.${process.platform}-${process.arch}.node`,
            ),
          ),
        ).toBe(true);
        expect(existsSync(path.join(result.directory, "node_modules/missing-optional-peer"))).toBe(
          false,
        );
        expect(readFileSync(path.join(result.directory, "data/resource.txt"), "utf8")).toBe(
          "owned SDK resource",
        );
        rmSync(fixture.source, { recursive: true, force: true });
        const unpacked = path.join(fixture.directory, "unpacked");
        mkdirSync(unpacked);
        const extracted = spawnSync("tar", ["-xzf", result.archive, "-C", unpacked], {
          encoding: "utf8",
        });
        expect(extracted.error).toBeUndefined();
        expect(extracted.status, extracted.stderr).toBe(0);
        const packageRoot = path.join(unpacked, "package");
        for (const relative of runtime.packages["@oh-my-pi/pi-coding-agent"].files) {
          expect(existsSync(path.join(packageRoot, relative))).toBe(true);
        }
        expect(
          existsSync(
            path.join(packageRoot, "node_modules/@oh-my-pi/pi-utils/dist/node/runtime.mjs"),
          ),
        ).toBe(true);
        expect(existsSync(path.join(packageRoot, "dist/node-desktop"))).toBe(false);
        expect(existsSync(path.join(packageRoot, "dist/node/plugins.mjs"))).toBe(true);
        expect(
          existsSync(
            path.join(
              packageRoot,
              `node_modules/@oh-my-pi/pi-natives/native/pi_natives.${process.platform}-${process.arch}.node`,
            ),
          ),
        ).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        fixture.dispose();
      }
    },
    30_000,
  );

  test.each(["generic", "desktop"])(
    "rejects a %s SDK without its plugin management artifact",
    async (buildTarget) => {
      const fixture = createSdkFixture(buildTarget);
      try {
        rmSync(path.join(fixture.source, fixture.artifact, "plugins.mjs"));
        vi.stubEnv("OMP_DESKTOP_SDK_TARGET", buildTarget);
        await expect(
          stageNodeSdk(fixture.source, fixture.output, resolveOmpSdkBuildConfig()),
        ).rejects.toThrow("plugins.mjs");
        expect(existsSync(fixture.output)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        fixture.dispose();
      }
    },
  );

  test("accepts legacy generic artifact metadata with an explicit generic target", async () => {
    const fixture = createSdkFixture("generic");
    try {
      for (const name of ["modules.json", "runtime-dependencies.json"]) {
        const file = path.join(fixture.source, fixture.artifact, name);
        const metadata = JSON.parse(readFileSync(file, "utf8"));
        delete metadata.buildTarget;
        writeFileSync(file, JSON.stringify(metadata));
      }
      vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "generic");
      vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", "full");
      const result = await stageNodeSdk(fixture.source, fixture.output, resolveOmpSdkBuildConfig());
      expect(existsSync(path.join(result.directory, "dist/node/sdk.mjs"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fixture.dispose();
    }
  });

  test.each([
    { artifactTarget: "desktop", file: "modules.json", target: "generic" },
    {
      artifactTarget: "desktop",
      file: "runtime-dependencies.json",
      target: "generic",
    },
    { artifactTarget: "generic", file: "modules.json", target: "desktop" },
    {
      artifactTarget: "generic",
      file: "runtime-dependencies.json",
      target: "desktop",
    },
  ])(
    "rejects $artifactTarget $file metadata target $target",
    async ({ artifactTarget, file, target }) => {
      const fixture = createSdkFixture(artifactTarget);
      try {
        const metadataFile = path.join(fixture.source, fixture.artifact, file);
        const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
        metadata.buildTarget = target;
        writeFileSync(metadataFile, JSON.stringify(metadata));
        vi.stubEnv("OMP_DESKTOP_SDK_TARGET", artifactTarget);
        vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", "full");
        await expect(
          stageNodeSdk(fixture.source, fixture.output, resolveOmpSdkBuildConfig()),
        ).rejects.toThrow("SDK build target mismatch");
      } finally {
        vi.unstubAllEnvs();
        fixture.dispose();
      }
    },
  );

  test("never falls back to a generic artifact when desktop output is absent", async () => {
    const fixture = createSdkFixture("generic");
    try {
      vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "desktop");
      await expect(
        stageNodeSdk(fixture.source, fixture.output, resolveOmpSdkBuildConfig()),
      ).rejects.toThrow();
      expect(existsSync(fixture.output)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fixture.dispose();
    }
  });

  test.each(["missing", "full local addon", "full platform package"])(
    "rejects desktop native staging with %s instead of an isolated addon",
    async (fallback) => {
      const fixture = createSdkFixture("desktop", { native: true });
      try {
        const natives = path.join(fixture.source, "node_modules/@oh-my-pi/pi-natives");
        if (fallback === "missing") {
          rmSync(path.join(natives, "native"), {
            recursive: true,
            force: true,
          });
        }
        if (fallback === "full platform package") {
          const leafName = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
          const leaf = path.join(fixture.source, "node_modules", leafName);
          mkdirSync(leaf, { recursive: true });
          writeFileSync(
            path.join(leaf, "package.json"),
            JSON.stringify({
              name: leafName,
              version: "1.0.0",
              main: "pi_natives.node",
            }),
          );
          writeFileSync(path.join(leaf, "pi_natives.node"), "invalid full-native fixture");
          const metadataFile = path.join(
            fixture.source,
            fixture.artifact,
            "runtime-dependencies.json",
          );
          const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
          metadata.packages["@oh-my-pi/pi-natives"].optionalDependencies = [leafName];
          metadata.packages[leafName] = {
            files: ["package.json", "pi_natives.node"],
            dependencies: [],
          };
          writeFileSync(metadataFile, JSON.stringify(metadata));
          writeFileSync(
            path.join(natives, "package.json"),
            JSON.stringify({
              name: "@oh-my-pi/pi-natives",
              version: "1.0.0",
              optionalDependencies: { [leafName]: "1.0.0" },
            }),
          );
        }
        vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "desktop");
        vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", "full");
        await expect(
          stageNodeSdk(fixture.source, fixture.output, resolveOmpSdkBuildConfig()),
        ).rejects.toThrow("Desktop SDK has no isolated addon");
        expect(existsSync(fixture.output)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        fixture.dispose();
      }
    },
  );

  test.each([
    { buildMode: "release", otherDirectory: "native/desktop/local" },
    { buildMode: "development", otherDirectory: "native/desktop" },
  ])(
    "$buildMode staging never borrows the addon from $otherDirectory",
    async ({ buildMode, otherDirectory }) => {
      const fixture = createSdkFixture("desktop", { native: true });
      try {
        const directory = path.join(
          fixture.source,
          "node_modules/@oh-my-pi/pi-natives",
          otherDirectory,
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, `pi_natives.${process.platform}-${process.arch}.node`),
          "wrong-mode addon must never be loaded",
        );
        await expect(
          stageNodeSdk(fixture.source, fixture.output, {
            buildTarget: "desktop",
            buildMode,
            profile: "core",
          }),
        ).rejects.toThrow("Desktop SDK has no isolated addon");
        expect(existsSync(fixture.output)).toBe(false);
      } finally {
        fixture.dispose();
      }
    },
  );

  test.each([
    {
      name: "release profile in local directory",
      buildMode: "development",
      overrides: { profile: "release" },
    },
    { name: "missing sidecar", sidecar: "missing" },
    { name: "malformed sidecar", sidecar: "malformed" },
    { name: "schema version", overrides: { schemaVersion: 0 } },
    { name: "generic build target", overrides: { buildTarget: "generic" } },
    { name: "debug profile", overrides: { profile: "debug" } },
    { name: "local profile in release directory", overrides: { profile: "local" } },
    { name: "stale package version", overrides: { version: "0.9.0" } },
    { name: "wrong platform", overrides: { platform: "wrong-platform" } },
    { name: "wrong architecture", overrides: { arch: "wrong-arch" } },
    { name: "wrong filename", overrides: { filename: "other.node" } },
    { name: "stale binary hash", overrides: { sha256: "0".repeat(64) } },
  ])(
    "rejects desktop native metadata with $name",
    async ({ sidecar, overrides, buildMode = "release" }) => {
      const fixture = createSdkFixture("desktop", { native: true });
      try {
        const filename = `pi_natives.${process.platform}-${process.arch}.node`;
        const directory = path.join(
          fixture.source,
          "node_modules/@oh-my-pi/pi-natives/native/desktop",
          ...(buildMode === "development" ? ["local"] : []),
        );
        mkdirSync(directory, { recursive: true });
        // These bytes are deliberately not loadable: every case must reject metadata first.
        const bytes = Buffer.from("invalid isolated addon for rejection-only fixture");
        const addon = path.join(directory, filename);
        writeFileSync(addon, bytes);
        if (sidecar !== "missing") {
          writeFileSync(
            `${addon}.json`,
            sidecar === "malformed"
              ? "{"
              : JSON.stringify({
                  schemaVersion: 1,
                  buildTarget: "desktop",
                  profile: "release",
                  version: "1.0.0",
                  platform: process.platform,
                  arch: process.arch,
                  filename,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                  capabilities: {
                    smollm: false,
                    liveVoice: false,
                    wasmGrammars: false,
                  },
                  ...overrides,
                }),
          );
        }
        vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "desktop");
        vi.stubEnv("OMP_DESKTOP_SDK_PROFILE", "full");
        await expect(
          stageNodeSdk(fixture.source, fixture.output, {
            ...resolveOmpSdkBuildConfig(),
            buildMode,
          }),
        ).rejects.toThrow("Desktop native addon metadata is stale or incompatible");
        expect(existsSync(fixture.output)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        fixture.dispose();
      }
    },
  );
});

describe("SDK-only packaging boundaries", () => {
  test("standard builds require the SDK but no vendor executable and retain executable editing", async () => {
    const fixture = createPackagingFixture();
    try {
      const result = await createQualifiedPackager(
        fixture.runtimeDist,
        fixture.runtime,
        fixture.args,
        fixture.directory,
      );
      expect(result.config.directories.output).toBe("release");
      expect(result.config.win.artifactName).toBe("OMP-Desktop-Setup-${version}-${arch}.${ext}");
      expect(result.config.win.signAndEditExecutable).toBe(true);
      expect(result.config.extraMetadata?.ompDesktopDistribution).toBeUndefined();
      expect(result.config.win.extraResources.map((resource) => resource.to)).toEqual(["icon.png"]);
      expect(result.config.electronDist).toBe(fixture.runtimeDist);
      expect(result.config.electronVersion).toBe("41.2.0");
    } finally {
      fixture.dispose();
    }
  });

  test("rejects obsolete executable-host plugin builds", async () => {
    const fixture = createPackagingFixture();
    try {
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          fixture.runtime,
          [...fixture.args, "--with-bundled-plugins"],
          fixture.directory,
        ),
      ).rejects.toThrow("not supported by SDK-only packaging");
    } finally {
      fixture.dispose();
    }
  });

  test("macOS retains explicit stable local signing options", async () => {
    const fixture = createPackagingFixture("darwin");
    try {
      const result = await createQualifiedPackager(
        fixture.runtimeDist,
        fixture.runtime,
        [
          ...fixture.args,
          "--config.mac.identity=OMP Desktop Local",
          "--config.mac.notarize=false",
          "--config.forceCodeSigning=true",
        ],
        fixture.directory,
      );
      expect(result.config.mac.identity).toBe("OMP Desktop Local");
      expect(result.config.mac.notarize).toBe(false);
      expect(result.config.forceCodeSigning).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  test("Windows rejects disabling PE editing instead of fixing the signing tool cache", async () => {
    const fixture = createPackagingFixture();
    try {
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          fixture.runtime,
          [...fixture.args, "--config.win.signAndEditExecutable=false"],
          fixture.directory,
        ),
      ).rejects.toThrow("requires real executable resource editing");
    } finally {
      fixture.dispose();
    }
  });

  test.each(["win32", "darwin"])(
    "a changed %s runtime executable cannot be packaged as the qualified runtime",
    async (platform) => {
      const fixture = createPackagingFixture(platform);
      try {
        writeFileSync(
          path.join(fixture.runtimeDist, Object.keys(fixture.runtime.files)[0]),
          "changed runtime",
        );
        await expect(
          createQualifiedPackager(
            fixture.runtimeDist,
            fixture.runtime,
            fixture.args,
            fixture.directory,
          ),
        ).rejects.toThrow("mini-electron executable SHA256 mismatch");
      } finally {
        fixture.dispose();
      }
    },
  );
});

test.each([
  { platform: "win32", runtimeVersion: "0.1.18" },
  { platform: "darwin", runtimeVersion: "0.1.17" },
  { platform: "win32", runtimeVersion: "1.0.0" },
  { platform: "darwin", runtimeVersion: "1.0.0" },
])(
  "runtime $runtimeVersion retains qualified resource staging across build validation ($platform)",
  async ({ platform, runtimeVersion }) => {
    const fixture = createPackagingFixture(platform, runtimeVersion);
    try {
      mkdirSync(path.join(fixture.directory, "public-resources"));
      writeFileSync(path.join(fixture.directory, "public-resources/value.txt"), "public resource");
      writeFileSync(
        path.join(fixture.directory, "electron-builder.yml"),
        JSON.stringify({
          directories: { output: "release" },
          extraResources: [{ from: "public-resources", to: "public-resources" }],
        }),
      );
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import fs from "node:fs";
            import path from "node:path";
            import { createRequire } from "node:module";
            import { createQualifiedPackager } from ${JSON.stringify(new URL("./run-electron-builder.mjs", import.meta.url).href)};
            const require = createRequire(${JSON.stringify(import.meta.url)});
            const { copyFiles, getFileMatchers } = require("app-builder-lib/out/fileMatcher");
            const root = ${JSON.stringify(fixture.directory)};
            const packager = await createQualifiedPackager(
              ${JSON.stringify(fixture.runtimeDist)}, ${JSON.stringify(fixture.runtime)},
              ${JSON.stringify(fixture.args)}, root,
            );
            // This is the validation entry build() calls on the same instance.
            await packager.validateConfig();
            const destination = path.join(root, "out/resources");
            fs.mkdirSync(destination, { recursive: true });
            const options = {
              defaultSrc: root, globalOutDir: path.join(root, "out"),
              macroExpander: value => value,
              customBuildOptions: packager.config[${JSON.stringify(platform === "win32" ? "win" : "mac")}] ?? {},
            };
            await copyFiles(getFileMatchers(packager.config, "extraResources", destination, options), null, false);
            assert.equal(fs.readFileSync(path.join(destination, "public-resources/value.txt"), "utf8"), "public resource");
            assert.equal(fs.existsSync(path.join(destination, "bin/omp.exe")), false);
            assert.equal(fs.readFileSync(path.join(destination, "omp-sdk/node_modules/@oh-my-pi/pi-coding-agent/dist/node/sdk.mjs"), "utf8"), "owned SDK artifact");
            assert.equal(fs.existsSync(path.join(destination, "omp-sdk/source.json")), false);
          `,
        ],
        {
          cwd: fixture.directory,
          encoding: "utf8",
          env: { ...process.env, USE_HARD_LINKS: "true" },
          timeout: 20_000,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    } finally {
      fixture.dispose();
    }
  },
);

describe("prepackaged distribution boundary", () => {
  test("prepackaged output cannot bypass required SDK staging", async () => {
    const fixture = createPackagingFixture();
    try {
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          fixture.runtime,
          [...fixture.args, "--prepackaged", path.join(fixture.directory, "owned-unpacked")],
          fixture.directory,
        ),
      ).rejects.toThrow("--prepackaged bypasses required SDK/runtime staging");
    } finally {
      fixture.dispose();
    }
  });
});

describe("Windows wrapper metadata boundary", () => {
  test("rejects obsolete executable-host plugin output", () => {
    expect(() => windowsBuildOutput("1.2.3", ["--with-bundled-plugins"])).toThrow(
      "SDK-only packaging",
    );
  });
});

test.each(["missing", "wrong platform", "wrong profile"])(
  "rejects a required SDK payload with %s",
  async (failure) => {
    const fixture = createPackagingFixture();
    try {
      const file = path.join(fixture.directory, "sdk-dist/manifest.json");
      if (failure === "missing") rmSync(file);
      else {
        const manifest = JSON.parse(readFileSync(file, "utf8"));
        if (failure === "wrong platform") manifest.platform = "darwin";
        else manifest.profile = "full";
        writeFileSync(file, JSON.stringify(manifest));
      }
      await expect(
        createQualifiedPackager(
          fixture.runtimeDist,
          fixture.runtime,
          fixture.args,
          fixture.directory,
        ),
      ).rejects.toThrow(
        failure === "missing"
          ? "Required SDK payload is missing"
          : "Required SDK payload does not match",
      );
    } finally {
      fixture.dispose();
    }
  },
);

test("broad alternative app patterns still exclude staged SDK source metadata", async () => {
  const fixture = createPackagingFixture();
  try {
    writeFileSync(
      path.join(fixture.directory, "alternative.json"),
      JSON.stringify({ files: ["**/*"] }),
    );
    const result = await createQualifiedPackager(
      fixture.runtimeDist,
      fixture.runtime,
      [...fixture.args, "--config", "alternative.json"],
      fixture.directory,
    );
    const platformPackager = Object.create(WinPackager.prototype);
    platformPackager.info = {
      config: result.config,
      projectDir: fixture.directory,
      buildResourcesDir: path.join(fixture.directory, "build"),
      debugLogger: result.debugLogger,
      framework: { name: "electron" },
    };
    platformPackager.platform = Platform.WINDOWS;
    platformPackager.platformSpecificBuildOptions = result.config.win ?? {};
    const destination = path.join(fixture.directory, "out/resources/app");
    const matchers = getMainFileMatchers(
      fixture.directory,
      destination,
      (value) => value,
      result.config.win ?? {},
      platformPackager,
      path.join(fixture.directory, "out"),
      false,
    );
    const filter = matchers[0].createFilter();
    const sourceMetadata = path.join(fixture.directory, "sdk-dist/source.json");
    expect(filter(sourceMetadata, require("node:fs").statSync(sourceMetadata))).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test("Windows SDK resources survive real extra-file copying and Desktop executable signing", async () => {
  const fixture = createPackagingFixture();
  try {
    const result = await createQualifiedPackager(
      fixture.runtimeDist,
      fixture.runtime,
      fixture.args,
      fixture.directory,
    );
    const appOutDir = path.join(fixture.directory, "out/win-unpacked");
    mkdirSync(appOutDir, { recursive: true });
    writeFileSync(path.join(appOutDir, "OMP Desktop.exe"), "Desktop PE fixture");
    const packager = Object.create(WinPackager.prototype);
    packager.info = {
      config: result.config,
      projectDir: fixture.directory,
      buildResourcesDir: path.join(fixture.directory, "build"),
      debugLogger: result.debugLogger,
      framework: { name: "electron" },
    };
    packager.platform = Platform.WINDOWS;
    packager.platformSpecificBuildOptions = result.config.win;
    packager.appInfo = { productFilename: "OMP Desktop", version: "1.0.0" };
    const edited = [];
    packager.signIf = async () => true;
    packager.signAndEditResources = async (file) => edited.push(path.basename(file));
    const context = {
      packager,
      appOutDir,
      outDir: path.join(fixture.directory, "out"),
      arch: Arch.x64,
      electronPlatformName: "win32",
    };
    const options = packager.createGetFileMatchersOptions(
      context.outDir,
      context.arch,
      result.config.win,
    );
    await copyFiles(
      packager.getExtraFileMatchers(true, appOutDir, options),
      packager.createTransformerForExtraFiles(context),
      false,
    );
    await packager.signApp(context, false);
    expect(edited).toEqual(["OMP Desktop.exe"]);
    expect(
      readFileSync(
        path.join(
          appOutDir,
          "resources/omp-sdk/node_modules/@oh-my-pi/pi-coding-agent/dist/node/sdk.mjs",
        ),
        "utf8",
      ),
    ).toBe("owned SDK artifact");
    expect(existsSync(path.join(appOutDir, "resources/bin/omp.exe"))).toBe(false);
    expect(existsSync(path.join(appOutDir, "resources/omp-sdk/source.json"))).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test("rejects CLI-bound private distribution metadata even without its old packaging flag", async () => {
  const fixture = createPackagingFixture();
  try {
    writeFileSync(
      path.join(fixture.directory, "private.json"),
      JSON.stringify({
        extraMetadata: { ompDesktopDistribution: "private-three-plugins" },
      }),
    );
    await expect(
      createQualifiedPackager(
        fixture.runtimeDist,
        fixture.runtime,
        [...fixture.args, "--config", "private.json"],
        fixture.directory,
      ),
    ).rejects.toThrow("not supported by SDK-only packaging");
  } finally {
    fixture.dispose();
  }
});
