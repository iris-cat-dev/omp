import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";

const SDK_NAME = "@oh-my-pi/pi-coding-agent";
const SDK_NODE_VERSION = "24.14.0";

function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  const result = spawnSync(
    cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    cli ? [cli, ...args] : args,
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      shell: !cli && process.platform === "win32",
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return JSON.parse(result.stdout);
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function requireFile(file) {
  if (!(await stat(file).catch(() => null))?.isFile())
    throw new Error(`OMP Desktop SDK input is missing a required file: ${file}`);
}

function compatible(values, target) {
  return (
    !Array.isArray(values) ||
    (!values.includes(`!${target}`) &&
      (!values.some((value) => !value.startsWith("!")) ||
        values.includes(target) ||
        values.includes("any")))
  );
}

async function resolvePackage(name, owner) {
  // Do not use require.resolve(name + "/package.json"): native packages can hide
  // their metadata behind exports, but must retain their actual package scope.
  const require = createRequire(path.join(owner, "package.json"));
  for (const modules of require.resolve.paths(name) ?? []) {
    const directory = path.join(modules, name);
    const manifest = await json(path.join(directory, "package.json")).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (manifest) return { directory: await realpath(directory), manifest };
  }
  return null;
}
function safeRelativePath(relative) {
  return (
    typeof relative === "string" &&
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/u).some((part) => part === ".." || part === "")
  );
}

function keepRuntimeFile(name, relative, target, buildTarget) {
  if (relative.split("/").includes(".DS_Store") || relative.endsWith(".map")) return false;
  if (name === "onnxruntime-node" && relative.startsWith("bin/")) {
    // dist/binding.js loads bin/napi-v*/${process.platform}/${process.arch}.
    const [, abi, platform, arch] = relative.split("/");
    return /^napi-v\d+$/u.test(abi) && platform === target.platform && arch === target.arch;
  }
  if (name === "koffi" && relative.startsWith("build/koffi/")) {
    // index.js loads build/koffi/<platform>_<arch>, with musl as a Linux fallback.
    const variant = relative.split("/")[2];
    return (
      variant === `${target.platform}_${target.arch}` ||
      (target.platform === "linux" && variant === `musl_${target.arch}`)
    );
  }
  if (name === "@oh-my-pi/pi-natives") {
    // Desktop artifacts are selected explicitly below, never by npm's broad files glob.
    if (relative.startsWith("native/desktop/")) return false;
    if (!relative.startsWith("native/"))
      return (
        relative === "package.json" || /^(?:LICEN[CS]E|NOTICE|THIRD-PARTY-NOTICES)/iu.test(relative)
      );
    if (relative.endsWith(".node"))
      return (
        buildTarget !== "desktop" &&
        path.posix.dirname(relative) === "native" &&
        (path.basename(relative).startsWith(`pi_natives.${target.platform}-${target.arch}.`) ||
          path.basename(relative).startsWith(`pi_natives.${target.platform}-${target.arch}-`))
      );
    return !relative.split("/").some((part) => part.startsWith(".")) && !relative.endsWith(".d.ts");
  }
  return true;
}

function installedRuntimePath(name, relative, buildTarget) {
  return name === SDK_NAME && buildTarget === "desktop"
    ? relative.replace(/^dist\/node-desktop(?=\/|$)/u, "dist/node")
    : relative;
}

function requireBuildTarget(metadata, buildTarget, file) {
  if ((metadata.buildTarget ?? "generic") !== buildTarget)
    throw new Error(
      `SDK build target mismatch in ${file}: expected ${buildTarget}, received ${metadata.buildTarget ?? "generic"}. Rebuild with gen:bundle:${buildTarget === "desktop" ? "desktop" : "node"} before staging.`,
    );
}

async function validateSdk(source, buildTarget) {
  if (!path.isAbsolute(source))
    throw new Error(
      "OMP_DESKTOP_SDK_SOURCE must be an absolute SDK package root, not dist/node or an SDK entry file.",
    );
  const directory = await realpath(source);
  const manifest = await json(path.join(directory, "package.json"));
  if (manifest.name !== SDK_NAME || !manifest.version)
    throw new Error(`Expected ${SDK_NAME} package metadata at ${source}`);
  const artifact = `dist/${buildTarget === "desktop" ? "node-desktop" : "node"}`;
  for (const file of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"])
    await requireFile(path.join(directory, artifact, file));
  for (const child of ["chunks", "modules"]) {
    if ((await readdir(path.join(directory, artifact, child))).length === 0)
      throw new Error(`SDK ${child} directory is empty in ${source}/${artifact}`);
  }
  const registry = await json(path.join(directory, artifact, "modules.json"));
  requireBuildTarget(registry, buildTarget, path.join(directory, artifact, "modules.json"));
  if (registry.version !== 1 || !registry.modules || Object.keys(registry.modules).length === 0)
    throw new Error(`Incompatible Node SDK module registry in ${source}`);
  for (const relative of Object.values(registry.modules)) {
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/u).includes("..")
    )
      throw new Error(`Invalid SDK module path in ${source}`);
    await requireFile(path.join(directory, artifact, relative));
  }
  const runtime = await json(path.join(directory, artifact, "runtime-dependencies.json")).catch(
    (error) => {
      throw new Error(
        `SDK runtime dependency metadata is missing or unreadable in ${source}/${artifact}. Rebuild with gen:bundle:${buildTarget === "desktop" ? "desktop" : "node"} before staging.`,
        { cause: error },
      );
    },
  );
  if (runtime.version !== 1 || !runtime.packages?.[SDK_NAME])
    throw new Error(`Incompatible SDK runtime dependency metadata in ${source}`);
  requireBuildTarget(
    runtime,
    buildTarget,
    path.join(directory, artifact, "runtime-dependencies.json"),
  );
  for (const [name, scope] of Object.entries(runtime.packages)) {
    if (
      !/^(@[^/]+\/)?[^/]+$/u.test(name) ||
      !Array.isArray(scope.files) ||
      !scope.files.every(safeRelativePath) ||
      !Array.isArray(scope.dependencies) ||
      !scope.dependencies.every((dependency) => /^(@[^/]+\/)?[^/]+$/u.test(dependency)) ||
      !Array.isArray(scope.optionalDependencies ?? []) ||
      !(scope.optionalDependencies ?? []).every((dependency) =>
        /^(@[^/]+\/)?[^/]+$/u.test(dependency),
      )
    )
      throw new Error(`Invalid SDK runtime package scope: ${name}`);
  }
  if (runtime.optionalCapabilities !== undefined) {
    if (
      !runtime.optionalCapabilities ||
      typeof runtime.optionalCapabilities !== "object" ||
      Array.isArray(runtime.optionalCapabilities) ||
      !Object.entries(runtime.optionalCapabilities).every(
        ([name, dependencies]) =>
          /^[a-z][a-z0-9-]*$/u.test(name) &&
          Array.isArray(dependencies) &&
          dependencies.length > 0 &&
          dependencies.every(
            (dependency) =>
              typeof dependency === "string" && /^(@[^/]+\/)?[^/]+$/u.test(dependency),
          ),
      )
    )
      throw new Error(`Invalid SDK optional capability metadata in ${source}`);
  }
  const utils = await resolvePackage("@oh-my-pi/pi-utils", directory);
  if (!utils)
    throw new Error(
      `The SDK source must have its local production dependencies installed: @oh-my-pi/pi-utils (${source})`,
    );
  for (const file of ["runtime.mjs", "runtime-image.mjs", "sqlite-driver.mjs"])
    await requireFile(path.join(utils.directory, "dist", "node", file));
  const natives = await resolvePackage("@oh-my-pi/pi-natives", directory);
  if (!natives)
    throw new Error(`The SDK source must have @oh-my-pi/pi-natives installed (${source})`);
  const nodeFiles = [];
  async function collect(relative) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === ".DS_Store") continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(child);
      else if (!entry.name.endsWith(".map")) nodeFiles.push(child);
    }
  }
  await collect(artifact);
  return { directory, manifest, nodeFiles, runtime };
}

async function desktopNativeAddons(pkg, target) {
  const directory = path.join(pkg.directory, "native", "desktop");
  const entries = await readdir(directory).catch(() => []);
  const filenames = entries.filter(
    (name) =>
      name.endsWith(".node") &&
      (name.startsWith(`pi_natives.${target.platform}-${target.arch}.`) ||
        name.startsWith(`pi_natives.${target.platform}-${target.arch}-`)),
  );
  const rebuild =
    "Build the isolated release addon with `bun --cwd=packages/natives run build:desktop`.";
  if (filenames.length === 0)
    throw new Error(`Desktop SDK has no isolated addon in ${directory}. ${rebuild}`);
  const require = createRequire(path.join(pkg.directory, "package.json"));
  for (const filename of filenames) {
    const file = path.join(directory, filename);
    const metadata = await json(`${file}.json`).catch(() => null);
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (
      metadata?.schemaVersion !== 1 ||
      metadata.buildTarget !== "desktop" ||
      metadata.profile !== "release" ||
      metadata.version !== pkg.manifest.version ||
      metadata.platform !== target.platform ||
      metadata.arch !== target.arch ||
      metadata.filename !== filename ||
      metadata.sha256 !== digest
    )
      throw new Error(
        `Desktop native addon metadata is stale or incompatible: ${file}. ${rebuild}`,
      );
    const bindings = require(file);
    if (
      typeof bindings.nativeCapabilities !== "function" ||
      typeof bindings.__piNativesBuildVersion !== "function" ||
      bindings.__piNativesBuildVersion() !== pkg.manifest.version
    )
      throw new Error(
        `Desktop native addon lacks current capability/version exports: ${file}. ${rebuild}`,
      );
    const capabilities = bindings.nativeCapabilities();
    if (
      ["smollm", "liveVoice", "wasmGrammars"].some(
        (name) => capabilities[name] !== false || metadata.capabilities?.[name] !== false,
      ) ||
      typeof bindings.LiveWebRtcPeer !== "undefined" ||
      typeof bindings.AudioCapture !== "function" ||
      typeof bindings.AudioPlayback !== "function" ||
      typeof bindings.TextPredictor !== "function"
    )
      throw new Error(`Desktop native feature set is incompatible: ${file}. ${rebuild}`);
  }
  return filenames.map((filename) => ({
    source: path.join(directory, filename),
    filename,
  }));
}

/** Stage the built SDK without modifying its source checkout or dependencies. */
export async function stageOmpSdk(
  source,
  outputDir,
  target = { platform: process.platform, arch: process.arch },
) {
  const config = resolveOmpSdkBuildConfig();
  source ??= config.source;
  const { profile, buildTarget } = config;
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `The local SDK native dependency closure is ${process.platform}-${process.arch}, not ${target.platform}-${target.arch}. Stage on the target OS and architecture; native addons are not rebuilt.`,
    );
  }
  const sdk = await validateSdk(source, buildTarget);
  if (
    profile === "core" &&
    (!sdk.runtime.optionalCapabilities ||
      Object.keys(sdk.runtime.optionalCapabilities).length === 0)
  )
    throw new Error(
      `The core SDK profile requires optional capability metadata. Rebuild the SDK with gen:bundle:${buildTarget === "desktop" ? "desktop" : "node"} before staging.`,
    );
  const excludedPackages = new Set(
    profile === "core" ? Object.values(sdk.runtime.optionalCapabilities).flat() : [],
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omp-desktop-sdk-"));
  const project = path.join(temporary, "project");
  const snapshots = new Map();
  const nodes = new Map();
  const queue = [];
  let snapshotIndex = 0;
  try {
    await mkdir(project, { recursive: true });
    const archives = path.join(temporary, "archives");
    await mkdir(archives);
    async function snapshot(pkg) {
      if (snapshots.has(pkg.directory)) return snapshots.get(pkg.directory);
      const scope = sdk.runtime.packages[pkg.manifest.name];
      const files = scope
        ? scope.files.map((relative) => ({ path: relative }))
        : npm(["pack", pkg.directory, "--dry-run", "--ignore-scripts", "--json"], temporary)[0]
            .files;
      const destination = path.join(temporary, "sources", String(snapshotIndex++));
      await mkdir(destination, { recursive: true });
      for (const { path: relative } of files) {
        if (!safeRelativePath(relative)) throw new Error(`Unsafe npm package path: ${relative}`);
        if (!keepRuntimeFile(pkg.manifest.name, relative, target, buildTarget)) continue;
        const file = path.join(
          destination,
          installedRuntimePath(pkg.manifest.name, relative, buildTarget),
        );
        await mkdir(path.dirname(file), { recursive: true });
        await cp(path.join(pkg.directory, relative), file, {
          dereference: true,
        });
      }
      if (pkg.manifest.name === "@oh-my-pi/pi-natives" && buildTarget === "desktop") {
        for (const addon of await desktopNativeAddons(pkg, target)) {
          const file = path.join(destination, "native", addon.filename);
          await mkdir(path.dirname(file), { recursive: true });
          await cp(addon.source, file);
        }
      }
      snapshots.set(pkg.directory, destination);
      return destination;
    }
    async function place(pkg, owner, name = pkg.manifest.name) {
      // Hoist compatible instances; preserve nested scopes for conflicting versions.
      let shadowed = false;
      for (let ancestor = owner; ancestor; ancestor = ancestor.parent) {
        const existing = nodes.get(path.join(ancestor.destination, "node_modules", name));
        if (existing) {
          if (existing.directory === pkg.directory) return existing;
          shadowed = true;
          break;
        }
      }
      const top = path.join(project, "node_modules", name);
      const existing = nodes.get(top);
      if (!shadowed && existing?.directory === pkg.directory) return existing;
      const destination = existing ? path.join(owner.destination, "node_modules", name) : top;
      const node = { ...pkg, destination, parent: existing ? owner : null };
      nodes.set(destination, node);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(await snapshot(pkg), destination, {
        recursive: true,
        dereference: true,
      });
      queue.push(node);
      return node;
    }
    const root = await place(sdk, null);
    for (let index = 0; index < queue.length; index++) {
      const node = queue[index];
      const manifest = { ...node.manifest };
      if (manifest.name === SDK_NAME) {
        delete manifest.bin;
        // Read by the loaded SDK, independent of the launcher's environment.
        manifest.ompNodeSdk = {
          ...manifest.ompNodeSdk,
          profile,
          target: buildTarget,
        };
      }
      if (!compatible(manifest.os, target.platform) || !compatible(manifest.cpu, target.arch))
        throw new Error(
          `SDK dependency ${manifest.name} does not support ${target.platform}-${target.arch}`,
        );
      const dependencies = {};
      const optionalDependencies = {};
      const bundled = [];
      const runtimeScope = sdk.runtime.packages[manifest.name];
      const requests = runtimeScope
        ? Object.fromEntries(
            [...runtimeScope.dependencies, ...(runtimeScope.optionalDependencies ?? [])].map(
              (name) => [name, "*"],
            ),
          )
        : {
            ...manifest.peerDependencies,
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
          };
      for (const name of Object.keys(requests)) {
        // Only the SDK builder may classify an edge as an optional capability.
        // Unknown imports and ordinary optional native peers retain their graph.
        if (excludedPackages.has(name)) continue;
        // The native loader prefers platform leaves to its local addon. Shipping
        // a full leaf here would silently defeat Desktop's isolated feature set.
        if (
          buildTarget === "desktop" &&
          manifest.name === "@oh-my-pi/pi-natives" &&
          name.startsWith("@oh-my-pi/pi-natives-")
        )
          continue;
        const optional =
          (runtimeScope?.optionalDependencies ?? []).includes(name) ||
          Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
          (!Object.hasOwn(manifest.dependencies ?? {}, name) &&
            manifest.peerDependenciesMeta?.[name]?.optional === true);
        const dependency = await resolvePackage(name, node.directory);
        if (
          !dependency ||
          !compatible(dependency.manifest.os, target.platform) ||
          !compatible(dependency.manifest.cpu, target.arch)
        ) {
          if (optional) continue;
          throw new Error(
            `SDK dependency ${name} required by ${manifest.name} is missing or incompatible. Install the source checkout's production dependencies for ${target.platform}-${target.arch} first.`,
          );
        }
        const installed = await place(dependency, node, name);
        (optional ? optionalDependencies : dependencies)[name] =
          installed.manifest.name === name
            ? installed.manifest.version
            : `npm:${installed.manifest.name}@${installed.manifest.version}`;
        bundled.push(name);
      }
      manifest.dependencies = dependencies;
      manifest.optionalDependencies = optionalDependencies;
      manifest.bundledDependencies = bundled;
      delete manifest.bundleDependencies;
      delete manifest.devDependencies;
      if (runtimeScope) {
        // Every shipped path is described by build metadata; npm's source-package
        // files globs must not reintroduce missing source or standalone CLI paths.
        manifest.files = runtimeScope.files.map((relative) =>
          installedRuntimePath(manifest.name, relative, buildTarget),
        );
        delete manifest.scripts;
        delete manifest.types;
        delete manifest.typings;
      }
      // Peers have been resolved to real local dependencies; leaving range or
      // catalog declarations here would trigger registry resolution at deployment.
      delete manifest.peerDependencies;
      delete manifest.peerDependenciesMeta;
      await writeFile(
        path.join(node.destination, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    const stagedRuntime = {
      ...sdk.runtime,
      buildTarget,
      packages: {
        ...sdk.runtime.packages,
        [SDK_NAME]: {
          ...sdk.runtime.packages[SDK_NAME],
          files: sdk.runtime.packages[SDK_NAME].files.map((relative) =>
            installedRuntimePath(SDK_NAME, relative, buildTarget),
          ),
        },
      },
    };
    await writeFile(
      path.join(root.destination, "dist", "node", "runtime-dependencies.json"),
      `${JSON.stringify(stagedRuntime, null, 2)}\n`,
    );
    await writeFile(
      path.join(project, "package.json"),
      `${JSON.stringify({ name: "omp-desktop-sdk", private: true, version: "0.0.0", dependencies: { [SDK_NAME]: sdk.manifest.version } }, null, 2)}\n`,
    );
    // npm bundles installed package scopes, not aliases to dist files. Runtime
    // metadata retains every worker/module chunk and unbundled resource asset.
    // Hoisted dependencies must be inside the SDK package before packing it.
    for (const node of nodes.values()) {
      if (node === root || node.parent) continue;
      const destination = path.join(
        root.destination,
        "node_modules",
        path.relative(path.join(project, "node_modules"), node.destination),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(node.destination, destination);
    }
    const packed = npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", archives],
      root.destination,
    )[0];
    const packedPaths = new Set(packed.files.map((file) => file.path));
    for (const relative of [
      "package.json",
      ...sdk.nodeFiles.map((relative) => installedRuntimePath(SDK_NAME, relative, buildTarget)),
      "node_modules/@oh-my-pi/pi-utils/dist/node/runtime.mjs",
      "node_modules/@oh-my-pi/pi-utils/dist/node/runtime-image.mjs",
      "node_modules/@oh-my-pi/pi-utils/dist/node/sqlite-driver.mjs",
      "node_modules/@oh-my-pi/pi-natives/package.json",
    ]) {
      if (!packedPaths.has(relative))
        throw new Error(
          `SDK npm package excludes required runtime content: ${relative}. Fix the source package's files configuration.`,
        );
    }
    if (!packed.files.some((file) => file.path.endsWith(".node")))
      throw new Error(
        "SDK package contains no native addons; install/build the source checkout's native dependencies before staging.",
      );
    const nativePrefix = `node_modules/@oh-my-pi/pi-natives/native/pi_natives.${target.platform}-${target.arch}`;
    if (
      !packed.files.some(
        (file) => file.path.startsWith(nativePrefix) && file.path.endsWith(".node"),
      )
    )
      throw new Error(
        `SDK package is missing the pi-natives addon for ${target.platform}-${target.arch}. Install/build that target in the source checkout before staging.`,
      );
    const manifest = {
      schemaVersion: 1,
      packageName: SDK_NAME,
      version: sdk.manifest.version,
      minimumNodeVersion: SDK_NODE_VERSION,
      platform: target.platform,
      arch: target.arch,
      buildTarget,
      profile,
      packageRoot: `node_modules/${SDK_NAME}`,
    };
    await writeFile(path.join(project, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      path.join(project, "source.json"),
      `${JSON.stringify({ packageRoot: sdk.directory })}\n`,
    );
    await cp(path.join(archives, packed.filename), path.join(project, "omp-sdk.tgz"));
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(path.dirname(outputDir), { recursive: true });
    await cp(project, outputDir, { recursive: true, dereference: true });
    return {
      ...manifest,
      archive: path.join(outputDir, "omp-sdk.tgz"),
      directory: path.join(outputDir, "node_modules", SDK_NAME),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
