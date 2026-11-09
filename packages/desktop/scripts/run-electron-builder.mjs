#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveOmpSdkBuildConfig } from "../../../scripts/omp-sdk-build-config.mjs";

const require = createRequire(import.meta.url);
const {
  coerceTypes,
  createYargs,
  configureBuildCommand,
  normalizeOptions,
} = require("electron-builder/out/builder");
const { Packager, build } = require("app-builder-lib");
const { validateConfiguration } = require("app-builder-lib/out/util/config/config");
const { Arch } = require("builder-util");
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Native releases advance independently of the npm installer. Qualify the
// distribution's target and protocol, not a frozen runtime release number.
const runtimeExecutables = {
  "win32-x64": "electron.exe",
  "darwin-arm64": "Electron.app/Contents/MacOS/Electron",
};

function validateSdkStage(projectDir, runtime) {
  const { source, buildTarget, profile } = resolveOmpSdkBuildConfig();
  const stage = path.join(projectDir, "sdk-dist");
  const manifestFile = path.join(stage, "manifest.json");
  if (!existsSync(manifestFile) || !existsSync(path.join(stage, "source.json"))) {
    throw new Error(
      "Required SDK payload is missing. Run npm run build:omp-sdk on the target OS and architecture before packaging.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  requireRelease(manifest.buildMode, "Required SDK manifest");
  const stagedSource = JSON.parse(readFileSync(path.join(stage, "source.json"), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== "@oh-my-pi/pi-coding-agent" ||
    manifest.packageRoot !== "node_modules/@oh-my-pi/pi-coding-agent" ||
    manifest.platform !== runtime.platform ||
    manifest.arch !== runtime.arch ||
    (manifest.buildTarget ?? "generic") !== buildTarget ||
    (manifest.profile ?? "full") !== profile ||
    !existsSync(source) ||
    stagedSource.packageRoot !== realpathSync(source)
  ) {
    throw new Error(
      `Required SDK payload does not match ${runtime.platform}-${runtime.arch}, OMP_DESKTOP_SDK_SOURCE, OMP_DESKTOP_SDK_TARGET=${buildTarget} and OMP_DESKTOP_SDK_PROFILE=${profile}. Run npm run build:omp-sdk on that target; native dependencies must be target-native and are not rebuilt by packaging.`,
    );
  }
  validateSdkPackage(stage, manifest, buildTarget, profile);
  return manifestFile;
}

function validateSdkPackage(stage, manifest, buildTarget, profile) {
  for (const file of [
    "package.json",
    "dist/node/sdk.mjs",
    "dist/node/rpc.mjs",
    "dist/node/host.mjs",
    "dist/node/plugins.mjs",
    "dist/node/modules.json",
  ]) {
    if (!existsSync(path.join(stage, manifest.packageRoot, file))) {
      throw new Error(
        `Required SDK payload is incomplete: ${file}. Run npm run build:omp-sdk again.`,
      );
    }
  }
  const installed = JSON.parse(
    readFileSync(path.join(stage, manifest.packageRoot, "package.json"), "utf8"),
  );
  requireRelease(installed.ompNodeSdk?.buildMode, "Required SDK package");
  if (
    (installed.ompNodeSdk?.target ?? "generic") !== buildTarget ||
    (installed.ompNodeSdk?.profile ?? "full") !== profile
  ) {
    throw new Error(
      `Required SDK package does not match OMP_DESKTOP_SDK_TARGET=${buildTarget} and OMP_DESKTOP_SDK_PROFILE=${profile}. Run npm run build:omp-sdk again.`,
    );
  }
  // Staging hoists the native dependency unless the SDK needs a nested copy.
  const nativeDirectories = [
    path.join(stage, manifest.packageRoot, "node_modules/@oh-my-pi/pi-natives/native"),
    path.join(stage, "node_modules/@oh-my-pi/pi-natives/native"),
  ];
  for (const directory of nativeDirectories) {
    if (!existsSync(directory)) continue;
    for (const filename of readdirSync(directory).filter((name) => name.endsWith(".node.json"))) {
      const metadata = JSON.parse(readFileSync(path.join(directory, filename), "utf8"));
      requireRelease(metadata.buildMode, "Required SDK native sidecar");
      if (metadata.profile !== "release") {
        throw new Error(
          "Required SDK native sidecar is not a release profile; local addons cannot be packaged.",
        );
      }
    }
  }
}

function requireRelease(buildMode, description) {
  // Missing buildMode identifies a legacy release stage.
  if (buildMode !== undefined && buildMode !== "release") {
    throw new Error(
      `${description} is not a release build; development SDKs cannot be packaged. Run npm run build:omp-sdk again.`,
    );
  }
}

function configureSdk(config, projectDir, runtime) {
  const stage = path.join(projectDir, "sdk-dist");
  const manifestFile = validateSdkStage(projectDir, runtime);
  // extraResources stays outside ASAR even when a custom config enables it.
  const appDir = path.resolve(projectDir, config.directories?.app ?? ".");
  const relativeStage = path.relative(appDir, stage).replaceAll("\\", "/");
  if (!relativeStage.startsWith("../") && !path.isAbsolute(relativeStage)) {
    const exclusion = `!${relativeStage}{,/**/*}`;
    for (const matcher of config.files.filter((entry) => entry.from == null)) {
      if (matcher.filter?.length === 0) continue;
      matcher.filter = [...(matcher.filter ?? ["**/*"]), exclusion];
    }
    if (config.files.length === 0) config.files.push({ filter: ["**/*", exclusion] });
  }
  // Package only the runtime closure and manifest, never source-path metadata or tarballs.
  config.extraResources = [
    ...(config.extraResources ?? []),
    // electron-builder deliberately filters a matcher's root node_modules directory.
    {
      from: path.join(stage, "node_modules"),
      to: "omp-sdk/node_modules",
      filter: ["**/*"],
    },
    { from: manifestFile, to: "omp-sdk/manifest.json" },
  ];
}

async function qualifyRuntime(runtimeDist, runtime, normalized) {
  for (const [platform, arches] of normalized.targets) {
    for (const arch of arches.keys()) {
      if (platform.nodeName !== runtime.platform || Arch[arch] !== runtime.arch) {
        throw new Error(
          `Cannot package ${platform.nodeName}-${Arch[arch]} with the ` +
            `${runtime.platform}-${runtime.arch} runtime at ${runtimeDist}. ` +
            "Set MINI_ELECTRON_DIST_PATH to a distribution matching the target. " +
            "Published mini-electron targets: darwin-arm64 and win32-x64.",
        );
      }
    }
  }
  const target = `${runtime.platform}-${runtime.arch}`;
  const executable = runtimeExecutables[target];
  if (!executable) {
    throw new Error(`Unsupported mini-electron target ${target} at ${runtimeDist}.`);
  }
  const expectedHash = runtime.files?.[executable];
  if (runtime.installerProtocol !== 1 || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) {
    throw new Error(
      `Missing genuine mini-electron executable metadata at ${runtimeDist}/version.json`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(runtimeDist, executable)))
    hash.update(chunk);
  if (hash.digest("hex") !== expectedHash) {
    throw new Error(`mini-electron executable SHA256 mismatch at ${runtimeDist}/${executable}`);
  }
  if (runtime.platform === "win32") {
    if (runtime.features?.nativeClipboardFiles !== 1) {
      throw new Error(
        "Windows packaging requires nativeClipboardFiles=1 in the verified mini-electron " +
          "version.json. Select the rebuilt clipboard-file runtime with MINI_ELECTRON_DIST_PATH; " +
          "runtime 0.1.32 and earlier do not implement authorized DOM File paste.",
      );
    }
    if (runtime.features?.asyncContextPropagation !== 1) {
      throw new Error(
        "Windows packaging requires asyncContextPropagation=1 in the verified mini-electron " +
          "version.json. Select a runtime that passed the native AsyncLocalStorage/Promise-hook " +
          "main-thread and Worker smoke; a runtime version bump alone is not sufficient.",
      );
    }
    if (runtime.features?.asyncStoragePersistence !== 1) {
      throw new Error(
        "Windows packaging requires asyncStoragePersistence=1 in the verified mini-electron " +
          "version.json. Select the rebuilt storage runtime with MINI_ELECTRON_DIST_PATH; " +
          "synchronous broker file writes can stall short input and viewport updates.",
      );
    }
  }
  return target;
}

class QualifiedPackager extends Packager {
  #qualified = false;
  #qualify;

  constructor(options, qualify) {
    super(options);
    this.#qualify = qualify;
  }

  async validateConfig() {
    // build() validates again: retain this qualified configuration instead of
    // loading and concatenating the on-disk resource arrays a second time.
    if (this.#qualified) return;
    await super.validateConfig();
    await this.#qualify(this);
    await validateConfiguration(this.config, this.debugLogger);
    this.#qualified = true;
  }
}

export async function createQualifiedPackager(
  runtimeDist,
  runtime,
  args,
  projectDir = desktopRoot,
) {
  if (args.includes("--with-bundled-plugins")) {
    throw new Error(
      "--with-bundled-plugins requires an obsolete OMP executable host and is not supported by SDK-only packaging.",
    );
  }
  const options = configureBuildCommand(createYargs()).parseSync(args);
  if (
    !["x64", "arm64"].includes(runtime.arch) ||
    !runtime.electronApiVersion ||
    typeof runtime.runtimeVersion !== "string" ||
    !runtime.runtimeVersion
  ) {
    throw new Error(`Invalid mini-electron runtime metadata at ${runtimeDist}/version.json`);
  }

  // Match the installed runtime even when Node is running under Rosetta.
  if (!["x64", "arm64", "ia32", "armv7l", "universal"].some((arch) => options[arch])) {
    options[runtime.arch] = true;
  }
  const normalized = normalizeOptions(options);
  if (normalized.prepackaged != null) {
    throw new Error(
      "--prepackaged bypasses required SDK/runtime staging. Package from source instead (use --dir for an unpacked application).",
    );
  }
  await qualifyRuntime(runtimeDist, runtime, normalized);

  projectDir = path.resolve(normalized.projectDir ?? projectDir);
  if (typeof normalized.config === "object") coerceTypes(normalized.config);
  const packager = new QualifiedPackager(
    { ...normalized, projectDir },
    async (qualifiedPackager) => {
      const { config } = qualifiedPackager;
      config.electronDist = runtimeDist;
      config.electronVersion = runtime.electronApiVersion;
      if (qualifiedPackager.metadata.ompDesktopDistribution === "private-three-plugins") {
        throw new Error(
          "The private-three-plugins distribution requires an obsolete OMP executable host and is not supported by SDK-only packaging.",
        );
      }
      configureSdk(config, projectDir, runtime);
      if (runtime.platform === "win32" && config.win?.signAndEditExecutable === false) {
        throw new Error("Windows packaging requires real executable resource editing and signing.");
      }
    },
  );
  await packager.validateConfig();
  return packager;
}

async function main() {
  const packageRoot = path.dirname(require.resolve("@iriscat/mini-electron/package.json"));
  const runtimeDist = path.resolve(
    process.env.MINI_ELECTRON_DIST_PATH || path.join(packageRoot, "dist"),
  );
  if (!existsSync(runtimeDist)) {
    throw new Error(
      `mini-electron runtime is missing at ${runtimeDist}; reinstall without MINI_ELECTRON_SKIP_BINARY_DOWNLOAD`,
    );
  }
  const runtime = JSON.parse(readFileSync(path.join(runtimeDist, "version.json"), "utf8"));
  const packager = await createQualifiedPackager(runtimeDist, runtime, process.argv.slice(2));
  console.log(
    `Packaging with mini-electron ${runtime.runtimeVersion} ${runtime.platform}-${runtime.arch}: ${runtimeDist}`,
  );
  await build(packager.options, packager);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
