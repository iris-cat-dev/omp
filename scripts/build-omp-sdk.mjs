import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";
import { stageNodeSdk, resolvePackage } from "../omp-sdk/scripts/stage-node-sdk.mjs";
import {
  fingerprintPaths,
  cachedOutputMatches,
  cacheOutput,
  readCache,
  writeCache,
} from "../omp-sdk/scripts/sdk-build-cache.mjs";
import { importSdkArtifact } from "./packaging/sdk-artifact.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkName = "@oh-my-pi/pi-coding-agent";
const key = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function command(command, args, { rawOutput = false, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${result.stderr ? `\n${result.stderr}` : ""}`,
      {
        cause: result.error,
      },
    );
  }
  return rawOutput ? result.stdout : result.stdout?.trim();
}

function sourceFiles(repo) {
  // Include uncommitted edits and new files, but not ignored generated output or dependencies.
  const files = command("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
    rawOutput: true,
  });
  return [...new Set(files.split("\0").filter(Boolean))].sort();
}

function nativeInput(relative) {
  return (
    relative.startsWith("crates/") ||
    relative.startsWith(".cargo/") ||
    /^(?:Cargo\.(?:toml|lock)|rust-toolchain\.toml)$/u.test(relative) ||
    relative === "packages/natives/package.json" ||
    relative.startsWith("packages/natives/scripts/") ||
    /^scripts\/(?:host-detect|stamp-native-version)\.ts$/u.test(relative)
  );
}

function nativeOnlyInput(relative) {
  return (
    relative.startsWith("crates/") ||
    relative.startsWith(".cargo/") ||
    /^(?:Cargo\.(?:toml|lock)|rust-toolchain\.toml)$/u.test(relative)
  );
}

function externalToSource(repo, file) {
  const relative = path.relative(repo, file);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("node_modules")
  );
}

/** Build or reuse an exact-content SDK. Development and release never share native outputs. */
export async function buildOmpSdk({
  env = process.env,
  outputDir = path.join(rootDir, "packages", "desktop", "sdk-dist"),
  cacheDir = path.join(rootDir, ".dev", "omp-sdk-build-cache"),
} = {}) {
  const started = performance.now();
  const { source, buildTarget, profile, buildMode } = resolveOmpSdkBuildConfig(env);
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Building the OMP Node SDK requires Node.js 24 or newer.");
  }
  let sdkRoot;
  try {
    sdkRoot = await realpath(source);
  } catch (error) {
    throw new Error(
      `SDK checkout is missing at ${source}. Run git submodule update --init --recursive.`,
      { cause: error },
    );
  }
  const sdkRepo = path.resolve(sdkRoot, "..", "..");
  const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
  if (manifest.name !== sdkName)
    throw new Error(`Expected the OMP SDK source package at ${sdkRoot}.`);
  const target = env.OMP_DESKTOP_PACKAGE_TARGET ?? `${process.platform}-${process.arch}`;
  const [platform, arch] = target.split("-");
  const artifact = env.OMP_DESKTOP_SDK_ARTIFACT;
  if (!artifact && target !== `${process.platform}-${process.arch}`) {
    throw new Error(
      `Packaging ${target} on ${process.platform}-${process.arch} requires OMP_DESKTOP_SDK_ARTIFACT from Package release.`,
    );
  }
  const identity = { sdkRoot, target, buildTarget, profile, buildMode, node: process.version };
  const cacheRoot = path.join(cacheDir, key({ sdkRoot, target, buildTarget }));
  const state = path.join(cacheRoot, `stage-${buildMode}-${profile}.json`);
  const dependenciesFile = path.join(cacheRoot, `dependencies-${buildMode}-${profile}.json`);
  const bundleInputs = path.join(sdkRepo, "target", "node-sdk-build-inputs", `${buildTarget}.json`);
  const bundleOutputs = [
    path.join(sdkRoot, "dist", buildTarget === "desktop" ? "node-desktop" : "node"),
    path.join(sdkRepo, "packages", "utils", "dist", "node"),
    bundleInputs,
  ];
  const nativeDirectory = path.join(sdkRepo, "packages", "natives", "native");
  const nativeFilename = `pi_natives.${platform}-${arch}${arch === "x64" ? "-baseline" : ""}.node`;
  const nativeAddon = path.join(
    nativeDirectory,
    "desktop",
    ...(buildMode === "development" ? ["local"] : []),
    nativeFilename,
  );
  const nativeOutputs =
    buildTarget === "desktop" ? [nativeAddon, `${nativeAddon}.json`] : [nativeDirectory];
  const pipeline = await fingerprintPaths([
    fileURLToPath(import.meta.url),
    path.join(rootDir, "scripts", "omp-sdk-build-config.mjs"),
    path.join(rootDir, "scripts", "packaging", "sdk-artifact.mjs"),
    path.join(rootDir, "package-lock.json"),
  ]);
  const buildEnvironment = Object.fromEntries(
    Object.entries(env)
      .filter(([name]) =>
        /^(?:RUST|CARGO|NAPI|OMP_NATIVE|PCRE2|CMAKE|PKG_CONFIG|BINDGEN|LIBCLANG|OPENSSL|BUN|NODE_OPTIONS$|NODE_ENV$|CI$|CC(?:_|$)|CXX(?:_|$)|AR(?:_|$)|CFLAGS|CXXFLAGS|LDFLAGS|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|PATH$|LIB$|INCLUDE$|CL$|LINK$)/iu.test(
          name,
        ),
      )
      .map(([name, value]) => [
        name,
        name.toUpperCase() === "PATH"
          ? [...new Set(value.split(path.delimiter).filter(Boolean))].join(path.delimiter)
          : value,
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  let tools;
  if (artifact) {
    tools = {
      commit: command("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: sdkRepo }),
    };
  } else {
    tools = {
      bun: command("bun", ["--version"], { env }),
      cargo: command("cargo", ["--version"], { cwd: sdkRepo, env }),
      rustc: command("rustc", ["-vV"], { cwd: sdkRepo, env }),
      npm: env.npm_execpath
        ? command(process.execPath, [env.npm_execpath, "--version"], { env })
        : command(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
            env,
            shell: process.platform === "win32",
          }),
    };
  }
  const dotenvNames = [
    ...new Set([
      ".env",
      ".env.local",
      ...["development", "production", "test", env.NODE_ENV]
        .filter(Boolean)
        .flatMap((mode) => [`.env.${mode}`, `.env.${mode}.local`]),
    ]),
  ];
  const dotenvDirectories = [
    ...new Set([
      sdkRepo,
      sdkRoot,
      path.join(sdkRepo, "packages", "natives"),
      path.join(sdkRepo, "packages", "collab-web"),
    ]),
  ];
  // Bun loads ignored environment files in its build working directories.
  const dotenvKey = await fingerprintPaths(
    dotenvDirectories.flatMap((directory) => dotenvNames.map((name) => path.join(directory, name))),
  );
  const context = { identity, pipeline, tools, buildEnvironment, dotenvKey };
  let files = sourceFiles(sdkRepo);
  let sourceKey = await fingerprintPaths(files.map((file) => path.join(sdkRepo, file)));

  async function bundleDependencyKey() {
    const metadata = await readCache(bundleInputs);
    const files =
      metadata?.version === 1 &&
      metadata.buildTarget === buildTarget &&
      Array.isArray(metadata.files)
        ? metadata.files.filter(
            (file) =>
              typeof file === "string" && path.isAbsolute(file) && externalToSource(sdkRepo, file),
          )
        : [];
    return key({ available: metadata?.version === 1, files: await fingerprintPaths(files) });
  }
  async function dependencyKey() {
    const dependencies = await readCache(dependenciesFile);
    if (!Array.isArray(dependencies)) return null;
    const directories = new Set();
    const resolutions = [];
    for (const dependency of dependencies) {
      if (typeof dependency.name !== "string" || typeof dependency.owner !== "string") return null;
      const resolved = await resolvePackage(dependency.name, dependency.owner);
      const directory = resolved?.directory ?? null;
      resolutions.push([dependency.name, dependency.owner, directory]);
      if (directory && externalToSource(sdkRepo, directory)) directories.add(directory);
    }
    return key({ resolutions, contents: await fingerprintPaths([...directories]) });
  }
  async function completeKey() {
    return key({
      context,
      sourceKey,
      artifact: artifact ? await fingerprintPaths([artifact]) : null,
      dependencies: artifact ? null : await dependencyKey(),
      bundledDependencies: artifact ? null : await bundleDependencyKey(),
      generated: artifact
        ? null
        : await fingerprintPaths([...nativeOutputs, ...bundleOutputs], { exclude: [] }),
    });
  }
  let inputKey = await completeKey();
  const reused = await cachedOutputMatches(state, inputKey, [outputDir]);
  if (reused) {
    console.log(`Reusing complete OMP SDK (${buildMode}, ${buildTarget}/${profile}, ${target}).`);
  } else if (artifact) {
    await importSdkArtifact(artifact, outputDir, { platform, arch, env });
    await cacheOutput(state, inputKey, [outputDir]);
  } else {
    function run(args) {
      command("bun", args, { cwd: sdkRepo, env, stdio: "inherit" });
    }
    // Installation is cheap when unchanged and also refreshes generated export-viewer resources.
    run(["install", "--frozen-lockfile"]);
    files = sourceFiles(sdkRepo);
    sourceKey = await fingerprintPaths(files.map((file) => path.join(sdkRepo, file)));
    const buildSourceKey = sourceKey;
    const nativeKey = key({
      context,
      files: await fingerprintPaths(
        files.filter(nativeInput).map((file) => path.join(sdkRepo, file)),
      ),
    });
    const nativeState = path.join(cacheRoot, `native-${buildMode}.json`);
    if (await cachedOutputMatches(nativeState, nativeKey, nativeOutputs)) {
      console.log(
        `Reusing unchanged native addon (${buildMode === "development" ? "local" : "release"}).`,
      );
    } else {
      run([
        `--cwd=${path.join(sdkRepo, "packages", "natives")}`,
        "run",
        buildTarget === "desktop" ? "build:desktop" : "build:bindings",
        ...(buildTarget === "desktop" && buildMode === "development" ? ["--development"] : []),
        ...(buildTarget === "desktop" && arch === "x64" ? ["--baseline"] : []),
      ]);
      await cacheOutput(nativeState, nativeKey, nativeOutputs);
    }
    const bundleSourceKey = await fingerprintPaths(
      files.filter((file) => !nativeOnlyInput(file)).map((file) => path.join(sdkRepo, file)),
    );
    const getBundleKey = async () =>
      key({
        pipeline,
        source: bundleSourceKey,
        dependencies: await bundleDependencyKey(),
        bun: tools.bun,
        node: process.version,
        buildTarget,
        buildEnvironment,
        dotenvKey,
      });
    const bundleState = path.join(cacheRoot, "bundle.json");
    if (await cachedOutputMatches(bundleState, await getBundleKey(), bundleOutputs)) {
      console.log(`Reusing unchanged ${buildTarget} Node SDK bundle.`);
    } else {
      run([
        `--cwd=${sdkRoot}`,
        "run",
        buildTarget === "desktop" ? "gen:bundle:desktop" : "gen:bundle:node",
      ]);
      await cacheOutput(bundleState, await getBundleKey(), bundleOutputs);
    }
    const staged = await stageNodeSdk(sdkRoot, outputDir, {
      buildTarget,
      profile,
      buildMode,
      cacheDir: path.join(cacheRoot, "package-files"),
    });
    await writeCache(dependenciesFile, staged.dependencyInputs);
    // Do not bless outputs with a new key if inputs changed during compilation.
    files = sourceFiles(sdkRepo);
    const finishedSourceKey = await fingerprintPaths(files.map((file) => path.join(sdkRepo, file)));
    if (finishedSourceKey === buildSourceKey) {
      inputKey = await completeKey();
      await cacheOutput(state, inputKey, [outputDir]);
    } else {
      console.warn("SDK inputs changed during the build; the complete SDK was not cached.");
    }
  }
  const staged = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
  const archive = path.join(outputDir, "omp-sdk.tgz");
  const result = {
    ...staged,
    directory: path.join(outputDir, staged.packageRoot),
    archive: (
      await stat(archive).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    )?.isFile()
      ? archive
      : null,
    reused,
  };
  console.log(
    `Prepared OMP SDK ${staged.version} (${buildTarget}/${profile}, ${target}, ${buildMode}) at ${result.directory} in ${((performance.now() - started) / 1000).toFixed(2)}s`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildOmpSdk();
}
