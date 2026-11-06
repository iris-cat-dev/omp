#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveOmpSdkBuildConfig } from "../omp-sdk-build-config.mjs";

// Resolve the packaging stack's existing tar dependency, including non-hoisted installs.
const require = createRequire(import.meta.url);
const packagingRequire = createRequire(require.resolve("app-builder-lib"));
const tar = packagingRequire("tar");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageDir = path.join(rootDir, "packages", "desktop", "sdk-dist");
const packageName = "@oh-my-pi/pi-coding-agent";
const packageRoot = `node_modules/${packageName}`;
const artifactFiles = ["manifest.json", "omp-sdk.tgz", "provenance.json"];
const supportedTargets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const saveJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function requireFile(file) {
  if (!(await lstat(file)).isFile())
    throw new Error(`SDK artifact requires a regular file: ${file}`);
}

async function fingerprint(file) {
  await requireFile(file);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function sourceIdentity(env = process.env) {
  const config = resolveOmpSdkBuildConfig(env);
  const source = await realpath(config.source);
  const sdk = await json(path.join(source, "package.json"));
  if (sdk.name !== packageName || typeof sdk.version !== "string" || !sdk.version)
    throw new Error(`Expected ${packageName} source package at ${source}.`);
  const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: source,
    encoding: "utf8",
    windowsHide: true,
  });
  const sdkCommit = revision.stdout?.trim();
  if (
    revision.error ||
    revision.status !== 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sdkCommit ?? "")
  )
    throw new Error(`Cannot identify the SDK checkout commit at ${source}.`, {
      cause: revision.error,
    });
  return { ...config, source, version: sdk.version, sdkCommit };
}

function requireRelease(buildMode, description) {
  // Older release artifacts did not declare a build mode.
  if (buildMode !== undefined && buildMode !== "release")
    throw new Error(`${description} is not a release build; development SDKs cannot be published.`);
}

async function validateNativeSidecars(directory, addons) {
  for (const filename of addons) {
    const metadata = await json(path.join(directory, `${filename}.json`)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // Keep old release artifacts without sidecars importable.
    if (metadata === null) continue;
    requireRelease(metadata.buildMode, "SDK native sidecar");
    if (metadata.profile !== "release")
      throw new Error(
        "SDK native sidecar is not a release profile; local addons cannot be published.",
      );
  }
}

function validateManifest(manifest, identity, { platform, arch }) {
  requireRelease(manifest.buildMode, "SDK artifact manifest");
  if (!supportedTargets.has(`${platform}-${arch}`))
    throw new Error(`Unsupported SDK artifact target: ${platform}-${arch}.`);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== packageName ||
    manifest.packageRoot !== packageRoot ||
    manifest.version !== identity.version ||
    manifest.buildTarget !== identity.buildTarget ||
    manifest.profile !== identity.profile ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.minimumNodeVersion !== "24.14.0"
  )
    throw new Error(
      `SDK artifact does not match checkout version ${identity.version}, ` +
        `${identity.buildTarget}/${identity.profile}, and ${platform}-${arch}.`,
    );
}

function validateProvenance(provenance, manifest, identity) {
  if (
    provenance.schemaVersion !== 1 ||
    provenance.archive !== "omp-sdk.tgz" ||
    provenance.sdkCommit !== identity.sdkCommit ||
    !/^[a-f0-9]{64}$/u.test(provenance.sha256 ?? "") ||
    !Number.isSafeInteger(provenance.size) ||
    provenance.size <= 0 ||
    ["packageName", "version", "buildTarget", "profile", "platform", "arch"].some(
      (key) => provenance[key] !== manifest[key],
    )
  )
    throw new Error(
      "SDK artifact provenance does not match its manifest and current SDK checkout commit.",
    );
}

function safePath(relative) {
  return (
    typeof relative === "string" &&
    relative.length > 0 &&
    !/[\\\u0000-\u001f\u007f:<>"|?*]/u.test(relative) &&
    relative
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/u.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  );
}

function archiveEntry(entry) {
  const relative = entry.type === "Directory" ? entry.path.replace(/\/$/u, "") : entry.path;
  if (
    !safePath(relative) ||
    (relative !== "package" && !relative.startsWith("package/")) ||
    !["File", "Directory"].includes(entry.type) ||
    entry.linkpath ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    (entry.type === "Directory" && entry.size !== 0)
  )
    throw new Error(`Unsafe SDK archive entry: ${entry.path} (${entry.type}).`);
  return relative;
}

async function extractArchive(file, destination, manifest) {
  const entries = new Map();
  const names = new Set();
  let invalid;
  await tar.t({
    file,
    strict: true,
    onReadEntry(entry) {
      if (invalid) return;
      try {
        const relative = archiveEntry(entry);
        // Case collisions are unsafe on the producer/consumer's usual filesystems.
        const key =
          manifest.platform === "linux" && process.platform === "linux"
            ? relative
            : relative.toLowerCase();
        if (names.has(key)) throw new Error(`Duplicate SDK archive entry: ${relative}.`);
        names.add(key);
        entries.set(relative, { type: entry.type, size: entry.size });
      } catch (error) {
        invalid = error;
      }
    },
  });
  if (invalid) throw invalid;
  if (!entries.size) throw new Error("SDK archive contains no package files.");
  for (const relative of entries.keys()) {
    for (
      let ancestor = path.posix.dirname(relative);
      ancestor !== ".";
      ancestor = path.posix.dirname(ancestor)
    ) {
      if (entries.get(ancestor)?.type === "File")
        throw new Error(`SDK archive places a file inside another file: ${relative}.`);
    }
  }
  await mkdir(destination);
  await tar.x({
    file,
    cwd: destination,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    chmod: true,
    processUmask: 0,
    filter(_relative, entry) {
      if (invalid) return false;
      try {
        const relative = archiveEntry(entry);
        const expected = entries.get(relative);
        if (expected?.type !== entry.type || expected.size !== entry.size)
          throw new Error(`SDK archive changed during extraction: ${relative}.`);
        return true;
      } catch (error) {
        invalid = error;
        return false;
      }
    },
  });
  if (invalid) throw invalid;
  const sdk = path.join(destination, "package");
  await validatePackage(sdk, manifest);
  return { sdk, entries };
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

function validPackageName(name) {
  return typeof name === "string" && /^(?:@[^/]+\/)?[^/]+$/u.test(name) && safePath(name);
}

async function resolveDependency(name, owner, sdk) {
  if (!validPackageName(name)) throw new Error(`Unsafe SDK dependency name: ${name}.`);
  for (let directory = owner; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    const metadata = await lstat(path.join(candidate, "package.json")).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (metadata?.isFile()) return candidate;
    if (directory === sdk) break;
  }
  throw new Error(`SDK archive omits bundled dependency ${name} required by ${owner}.`);
}

async function validatePackage(sdk, manifest) {
  const installed = await json(path.join(sdk, "package.json"));
  requireRelease(installed.ompNodeSdk?.buildMode, "SDK installed package");
  const modules = await json(path.join(sdk, "dist/node/modules.json"));
  const runtime = await json(path.join(sdk, "dist/node/runtime-dependencies.json"));
  if (
    installed.name !== packageName ||
    installed.version !== manifest.version ||
    installed.ompNodeSdk?.target !== manifest.buildTarget ||
    installed.ompNodeSdk?.profile !== manifest.profile ||
    modules.version !== 1 ||
    modules.buildTarget !== manifest.buildTarget ||
    !modules.modules ||
    Array.isArray(modules.modules) ||
    !Object.keys(modules.modules).length ||
    runtime.version !== 1 ||
    runtime.buildTarget !== manifest.buildTarget ||
    !runtime.packages?.[packageName]
  )
    throw new Error("SDK archive package, module registry, or runtime metadata is incompatible.");
  for (const relative of [
    "sdk.mjs",
    "rpc.mjs",
    "host.mjs",
    "plugins.mjs",
    ...Object.values(modules.modules),
  ]) {
    if (!safePath(relative)) throw new Error(`Unsafe SDK module path: ${relative}.`);
    await requireFile(path.join(sdk, "dist/node", relative));
  }
  for (const child of ["chunks", "modules"]) {
    if (!(await readdir(path.join(sdk, "dist/node", child))).length)
      throw new Error(`SDK archive has an empty ${child} directory.`);
  }
  if (manifest.profile === "core" && !Object.keys(runtime.optionalCapabilities ?? {}).length)
    throw new Error("Core SDK archive omits optional capability metadata.");
  const excluded = new Set(
    manifest.profile === "core" ? Object.values(runtime.optionalCapabilities).flat() : [],
  );
  const seen = new Set();
  const queue = [sdk];
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index];
    if (seen.has(directory)) continue;
    seen.add(directory);
    const pkg = await json(path.join(directory, "package.json"));
    if (
      !validPackageName(pkg.name) ||
      !pkg.version ||
      !compatible(pkg.os, manifest.platform) ||
      !compatible(pkg.cpu, manifest.arch) ||
      excluded.has(pkg.name) ||
      (manifest.buildTarget === "desktop" && pkg.name.startsWith("@oh-my-pi/pi-natives-"))
    )
      throw new Error(`Incompatible SDK archive dependency: ${pkg.name}.`);
    const scope = runtime.packages[pkg.name];
    if (scope) {
      if (!Array.isArray(scope.files))
        throw new Error(`Invalid SDK runtime file scope: ${pkg.name}.`);
      for (const relative of scope.files) {
        if (!safePath(relative)) throw new Error(`Unsafe SDK runtime file: ${relative}.`);
        if (!relative.endsWith(".map") && !relative.split("/").includes(".DS_Store"))
          await requireFile(path.join(directory, relative));
      }
    }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
      queue.push(await resolveDependency(name, directory, sdk));
  }
  const utils = await resolveDependency("@oh-my-pi/pi-utils", sdk, sdk);
  for (const file of ["runtime.mjs", "runtime-image.mjs", "sqlite-driver.mjs"])
    await requireFile(path.join(utils, "dist/node", file));
  const natives = await resolveDependency("@oh-my-pi/pi-natives", sdk, sdk);
  const addons = (await readdir(path.join(natives, "native"))).filter((name) =>
    name.endsWith(".node"),
  );
  const prefix = `pi_natives.${manifest.platform}-${manifest.arch}`;
  if (
    !addons.length ||
    addons.some((name) => !name.startsWith(`${prefix}.`) && !name.startsWith(`${prefix}-`))
  )
    throw new Error(
      `SDK archive does not contain only matching pi-natives addons for ${manifest.platform}-${manifest.arch}.`,
    );
  if (
    manifest.buildTarget === "desktop" &&
    manifest.arch === "x64" &&
    !addons.includes(`${prefix}-baseline.node`)
  )
    throw new Error(
      `Desktop SDK archive is missing the ${manifest.platform}-${manifest.arch} baseline addon. ` +
        "Rebuild with npm run build:omp-sdk; a modern-only addon cannot run on baseline hosts.",
    );
  await validateNativeSidecars(path.join(natives, "native"), addons);
}

async function validateProducerSource(sdk, entries, identity, stageDirectory) {
  const artifact = identity.buildTarget === "desktop" ? "node-desktop" : "node";
  const sourceRuntime = await json(
    path.join(identity.source, "dist", artifact, "runtime-dependencies.json"),
  );
  const installedPath = (relative) =>
    identity.buildTarget === "desktop"
      ? relative.replace(/^dist\/node-desktop(?=\/|$)/u, "dist/node")
      : relative;
  const expectedRuntime = {
    ...sourceRuntime,
    buildTarget: identity.buildTarget,
    packages: {
      ...sourceRuntime.packages,
      [packageName]: {
        ...sourceRuntime.packages[packageName],
        files: sourceRuntime.packages[packageName].files.map(installedPath),
      },
    },
  };
  if (
    !isDeepStrictEqual(
      expectedRuntime,
      await json(path.join(sdk, "dist/node/runtime-dependencies.json")),
    )
  )
    throw new Error("Staged SDK runtime metadata no longer matches the source build.");
  for (const relative of entries.keys()) {
    if (entries.get(relative).type !== "File") continue;
    const staged = path.join(stageDirectory, packageRoot, relative.slice("package/".length));
    const extracted = path.join(sdk, relative.slice("package/".length));
    const bytes = await fingerprint(extracted);
    if (!isDeepStrictEqual(bytes, await fingerprint(staged)))
      throw new Error(`Staged SDK archive no longer matches its installed closure: ${relative}.`);
    if (
      relative === "package/package.json" ||
      relative.startsWith("package/node_modules/") ||
      relative === "package/dist/node/runtime-dependencies.json"
    )
      continue;
    const localRelative = relative
      .slice("package/".length)
      .replace(/^dist\/node(?=\/|$)/u, `dist/${artifact}`);
    if (!isDeepStrictEqual(bytes, await fingerprint(path.join(identity.source, localRelative))))
      throw new Error(`Staged SDK runtime no longer matches source: ${relative}.`);
  }
  // Native loading is deliberately left to native staging; compare release bytes, never require .node.
  const sourceRequire = createRequire(path.join(identity.source, "package.json"));
  let sourceNatives;
  for (const modules of sourceRequire.resolve.paths("@oh-my-pi/pi-natives") ?? []) {
    const candidate = path.join(modules, "@oh-my-pi/pi-natives");
    if ((await lstat(path.join(candidate, "package.json")).catch(() => null))?.isFile()) {
      sourceNatives = await realpath(candidate);
      break;
    }
  }
  if (!sourceNatives) throw new Error("SDK source is missing its pi-natives package.");
  const natives = await resolveDependency("@oh-my-pi/pi-natives", sdk, sdk);
  for (const filename of (await readdir(path.join(natives, "native"))).filter((name) =>
    name.endsWith(".node"),
  )) {
    const source = path.join(
      sourceNatives,
      "native",
      ...(identity.buildTarget === "desktop" ? ["desktop"] : []),
      filename,
    );
    if (
      !isDeepStrictEqual(
        await fingerprint(source),
        await fingerprint(path.join(natives, "native", filename)),
      )
    )
      throw new Error(`Staged SDK native addon no longer matches source: ${filename}.`);
  }
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function prepareOutput(outputDir, protectedDirs) {
  const absolute = path.resolve(outputDir);
  if (absolute === path.parse(absolute).root)
    throw new Error("SDK artifact output cannot be a filesystem root.");
  await mkdir(path.dirname(absolute), { recursive: true });
  const output = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  for (const protectedDir of protectedDirs) {
    if (overlaps(output, protectedDir) || overlaps(protectedDir, output))
      throw new Error(`SDK artifact output overlaps an input checkout or artifact: ${output}.`);
  }
  const existing = await lstat(output).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !existing.isDirectory())
    throw new Error(`SDK artifact output is not a directory: ${output}.`);
  const temporary = await mkdtemp(path.join(path.dirname(output), ".omp-sdk-artifact-"));
  return { output, temporary, replacement: path.join(temporary, "replacement") };
}

async function replaceOutput(state) {
  const { output, temporary, replacement } = state;
  const backup = path.join(temporary, "previous");
  let previous = false;
  try {
    await rename(output, backup);
    previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(replacement, output);
  } catch (error) {
    if (previous) {
      try {
        await rename(backup, output);
      } catch (rollbackError) {
        state.keepTemporary = true;
        throw new AggregateError(
          [error, rollbackError],
          `SDK replacement failed; previous destination preserved at ${backup}.`,
        );
      }
    }
    throw error;
  }
}

/** Export the current native stage's exact npm archive, without restaging or repacking. */
export async function createSdkArtifact(outputDir, { stageDirectory = stageDir } = {}) {
  const identity = await sourceIdentity();
  const manifest = await json(path.join(stageDirectory, "manifest.json"));
  validateManifest(manifest, identity, { platform: process.platform, arch: process.arch });
  const stagedSource = await json(path.join(stageDirectory, "source.json"));
  if (stagedSource.packageRoot !== identity.source)
    throw new Error(
      "Staged SDK does not match OMP_DESKTOP_SDK_SOURCE; rebuild it before exporting.",
    );
  await validatePackage(path.join(stageDirectory, packageRoot), manifest);
  const state = await prepareOutput(outputDir, [await realpath(stageDirectory), identity.source]);
  try {
    await mkdir(state.replacement);
    const archive = path.join(state.replacement, "omp-sdk.tgz");
    await requireFile(path.join(stageDirectory, "omp-sdk.tgz"));
    await copyFile(path.join(stageDirectory, "omp-sdk.tgz"), archive);
    const bytes = await fingerprint(archive);
    const { sdk, entries } = await extractArchive(
      archive,
      path.join(state.temporary, "extracted"),
      manifest,
    );
    await validateProducerSource(sdk, entries, identity, stageDirectory);
    const provenance = {
      schemaVersion: 1,
      archive: "omp-sdk.tgz",
      sdkCommit: identity.sdkCommit,
      packageName,
      version: manifest.version,
      buildTarget: manifest.buildTarget,
      profile: manifest.profile,
      platform: manifest.platform,
      arch: manifest.arch,
      ...bytes,
    };
    await saveJson(path.join(state.replacement, "manifest.json"), manifest);
    await saveJson(path.join(state.replacement, "provenance.json"), provenance);
    if ((await sourceIdentity()).sdkCommit !== identity.sdkCommit)
      throw new Error("SDK checkout commit changed while exporting its artifact.");
    await replaceOutput(state);
    return {
      ...manifest,
      provenance,
      directory: state.output,
      archive: path.join(state.output, "omp-sdk.tgz"),
    };
  } finally {
    if (!state.keepTemporary) await rm(state.temporary, { recursive: true, force: true });
  }
}

/** Import the complete target-native npm archive without install scripts or native loading. */
export async function importSdkArtifact(
  artifactDir,
  outputDir,
  { platform = process.platform, arch = process.arch, env = process.env } = {},
) {
  if (!path.isAbsolute(artifactDir))
    throw new Error("OMP_DESKTOP_SDK_ARTIFACT must be an absolute extracted artifact directory.");
  const input = await realpath(artifactDir);
  const names = await readdir(input);
  if (names.length !== artifactFiles.length || artifactFiles.some((name) => !names.includes(name)))
    throw new Error(`SDK artifact must contain exactly ${artifactFiles.join(", ")}.`);
  for (const name of artifactFiles) await requireFile(path.join(input, name));
  const identity = await sourceIdentity(env);
  const manifest = await json(path.join(input, "manifest.json"));
  const provenance = await json(path.join(input, "provenance.json"));
  validateManifest(manifest, identity, { platform, arch });
  validateProvenance(provenance, manifest, identity);
  const state = await prepareOutput(outputDir, [input, identity.source]);
  try {
    await mkdir(state.replacement);
    const archive = path.join(state.replacement, "omp-sdk.tgz");
    await copyFile(path.join(input, "omp-sdk.tgz"), archive);
    const bytes = await fingerprint(archive);
    if (bytes.sha256 !== provenance.sha256 || bytes.size !== provenance.size)
      throw new Error("SDK artifact archive checksum or size mismatch.");
    const { sdk } = await extractArchive(
      archive,
      path.join(state.temporary, "extracted"),
      manifest,
    );
    const directory = path.join(state.replacement, packageRoot);
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(sdk, directory);
    await saveJson(path.join(state.replacement, "package.json"), {
      name: "omp-node-sdk",
      private: true,
      version: "0.0.0",
      dependencies: { [packageName]: manifest.version },
    });
    await saveJson(path.join(state.replacement, "manifest.json"), manifest);
    await saveJson(path.join(state.replacement, "provenance.json"), provenance);
    await saveJson(path.join(state.replacement, "source.json"), { packageRoot: identity.source });
    const current = await sourceIdentity(env);
    if (current.sdkCommit !== identity.sdkCommit || current.version !== identity.version)
      throw new Error("SDK checkout changed while importing its artifact.");
    await replaceOutput(state);
    return {
      ...manifest,
      archive: path.join(state.output, "omp-sdk.tgz"),
      directory: path.join(state.output, packageRoot),
    };
  } finally {
    if (!state.keepTemporary) await rm(state.temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outputDir, ...extra] = process.argv.slice(2);
  if (command !== "create" || !outputDir || extra.length)
    throw new Error("Usage: node scripts/packaging/sdk-artifact.mjs create <outputDir>");
  const artifact = await createSdkArtifact(outputDir);
  console.log(
    `Created OMP SDK ${artifact.version} (${artifact.buildTarget}/${artifact.profile}, ${artifact.platform}-${artifact.arch}) artifact at ${artifact.directory}`,
  );
}
