#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_OMP_HOST,
  sha256RegularFile,
} from "../../server/src/server/bundled-omp-host.ts";

const require = createRequire(import.meta.url);
const {
  coerceTypes,
  createYargs,
  configureBuildCommand,
  normalizeOptions,
} = require("electron-builder/out/builder");
const { AppInfo, Packager, build } = require("app-builder-lib");
const {
  validateConfiguration,
} = require("app-builder-lib/out/util/config/config");
const { expandMacro } = require("app-builder-lib/out/util/macroExpander");
const {
  copyFiles,
  getFileMatchers,
} = require("app-builder-lib/out/fileMatcher");
const { resolveFunction } = require("app-builder-lib/out/util/resolve");
const { Arch, copyFile, statOrNull } = require("builder-util");
const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Native releases advance independently of the npm installer. Qualify the
// distribution's target and protocol, not a frozen runtime release number.
const runtimeExecutables = {
  "win32-x64": "electron.exe",
  "darwin-arm64": "Electron.app/Contents/MacOS/Electron",
};

function configureOptionalSdk(config, projectDir, runtime) {
  const source = process.env.OMP_DESKTOP_SDK_SOURCE;
  if (!source) return;
  if (!path.isAbsolute(source)) {
    throw new Error(
      "OMP_DESKTOP_SDK_SOURCE must be an absolute SDK package root.",
    );
  }
  const buildTarget = process.env.OMP_DESKTOP_SDK_TARGET ?? "generic";
  if (buildTarget !== "generic" && buildTarget !== "desktop") {
    throw new Error(
      `Unsupported OMP_DESKTOP_SDK_TARGET: ${buildTarget}. Use generic or desktop.`,
    );
  }
  const stage = path.join(projectDir, "sdk-dist");
  const manifestFile = path.join(stage, "manifest.json");
  if (
    !existsSync(manifestFile) ||
    !existsSync(path.join(stage, "source.json"))
  ) {
    throw new Error(
      "Optional SDK payload is missing. Run build:remote-backend with OMP_DESKTOP_SDK_SOURCE first.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const stagedSource = JSON.parse(
    readFileSync(path.join(stage, "source.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== "@oh-my-pi/pi-coding-agent" ||
    manifest.packageRoot !== "node_modules/@oh-my-pi/pi-coding-agent" ||
    manifest.platform !== runtime.platform ||
    manifest.arch !== runtime.arch ||
    (manifest.buildTarget ?? "generic") !== buildTarget ||
    stagedSource.packageRoot !== realpathSync(source)
  ) {
    throw new Error(
      `Optional SDK payload does not match ${runtime.platform}-${runtime.arch}, OMP_DESKTOP_SDK_SOURCE and OMP_DESKTOP_SDK_TARGET=${buildTarget}. Rebuild the remote backend on that target; native addons are not rebuilt.`,
    );
  }
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
        `Optional SDK payload is incomplete: ${file}. Run build:remote-backend again.`,
      );
    }
  }
  const installed = JSON.parse(
    readFileSync(
      path.join(stage, manifest.packageRoot, "package.json"),
      "utf8",
    ),
  );
  if ((installed.ompNodeSdk?.target ?? "generic") !== buildTarget) {
    throw new Error(
      `Optional SDK package does not match OMP_DESKTOP_SDK_TARGET=${buildTarget}. Run build:remote-backend again.`,
    );
  }
  // extraResources stays outside ASAR even when a custom config enables it.
  // Never include the SDK, its tarball, or source-path metadata by default.
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

async function verifyPrivateHost(file) {
  if ((await sha256RegularFile(file)) !== BUNDLED_OMP_HOST.sha256) {
    throw new Error(`Private plugin OMP host SHA-256 mismatch: ${file}`);
  }
}

async function runHook(hook, name, context, projectDir) {
  if (typeof hook === "string") {
    hook = hook.startsWith(".")
      ? path.resolve(projectDir, hook)
      : createRequire(path.join(projectDir, "package.json")).resolve(hook);
  }
  hook = await resolveFunction(context.packager.appInfo.type, hook, name);
  if (hook) await hook(context);
}

function deferQualifiedWindowsResources(config, projectDir, privateHostSource) {
  const sealedDestinations = {
    "bin/omp.exe": true,
    "bundled-omp-plugins": true,
    "manager.json": true,
  };
  const sealedResources = [];
  for (const owner of [config, config.win]) {
    if (!Array.isArray(owner?.extraResources)) continue;
    owner.extraResources = owner.extraResources.filter((resource) => {
      if (!Object.hasOwn(sealedDestinations, resource.to)) return true;
      sealedResources.push(resource);
      return false;
    });
  }
  if (sealedResources.length === 0) return;

  // These resources must not also enter the app-file copy/signing pass when an
  // alternative config uses broad files patterns.
  const appDir = path.resolve(projectDir, config.directories?.app ?? ".");
  const exclusions = sealedResources.flatMap(({ from }) => {
    const relative = path
      .relative(appDir, path.resolve(projectDir, from ?? "."))
      .replaceAll("\\", "/");
    return relative.startsWith("../") || path.isAbsolute(relative)
      ? []
      : [`!${relative}{,/**/*}`];
  });
  // getConfig has already normalized files into FileSets. Exclusions belong in
  // the same root matcher as its inclusions, not in a second independent matcher.
  const appFiles = config.files;
  for (const rootFiles of appFiles.filter((files) => files.from == null)) {
    if (rootFiles.filter?.length === 0) continue;
    rootFiles.filter = [...(rootFiles.filter ?? ["**/*"]), ...exclusions];
  }
  if (appFiles.length === 0) {
    appFiles.push({ filter: ["**/*", ...exclusions] });
  }

  const originalAfterPack = config.afterPack;
  config.afterPack = async (context) => {
    if (privateHostSource) await verifyPrivateHost(privateHostSource);
    // afterPack runs after the extra-file transformer. The subsequent Windows
    // signApp pass edits/signs the Desktop EXE, not these nested resources.
    const matchers = getFileMatchers(
      { extraResources: sealedResources },
      "extraResources",
      context.packager.getResourcesDir(context.appOutDir),
      context.packager.createGetFileMatchersOptions(
        context.outDir,
        context.arch,
        {},
      ),
    );
    await Promise.all(
      (matchers ?? []).map(async (matcher) => {
        // copyFiles ignores its hardlink argument for a single-file source.
        // Sealed files must not share an inode with mutable packaging inputs.
        if ((await statOrNull(matcher.from))?.isFile()) {
          await copyFile(matcher.from, matcher.to);
        } else {
          await copyFiles([matcher], null, false);
        }
      }),
    );
    const host = path.join(
      context.packager.getResourcesDir(context.appOutDir),
      "bin",
      "omp.exe",
    );
    if (privateHostSource) await verifyPrivateHost(host);
    await runHook(originalAfterPack, "afterPack", context, projectDir);
    if (privateHostSource) await verifyPrivateHost(host);
  };
  if (privateHostSource) {
    const originalAfterSign = config.afterSign;
    config.afterSign = async (context) => {
      await runHook(originalAfterSign, "afterSign", context, projectDir);
      await verifyPrivateHost(
        path.join(
          context.packager.getResourcesDir(context.appOutDir),
          "bin",
          "omp.exe",
        ),
      );
    };
  }
}

async function qualifyRuntime(runtimeDist, runtime, normalized) {
  for (const [platform, arches] of normalized.targets) {
    for (const arch of arches.keys()) {
      if (
        platform.nodeName !== runtime.platform ||
        Arch[arch] !== runtime.arch
      ) {
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
    throw new Error(
      `Unsupported mini-electron target ${target} at ${runtimeDist}.`,
    );
  }
  const expectedHash = runtime.files?.[executable];
  if (
    runtime.installerProtocol !== 1 ||
    !/^[a-f0-9]{64}$/.test(expectedHash ?? "")
  ) {
    throw new Error(
      `Missing genuine mini-electron executable metadata at ${runtimeDist}/version.json`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(
    path.join(runtimeDist, executable),
  ))
    hash.update(chunk);
  if (hash.digest("hex") !== expectedHash) {
    throw new Error(
      `mini-electron executable SHA256 mismatch at ${runtimeDist}/${executable}`,
    );
  }
  return target;
}

async function configurePrivateDistribution(packager, target) {
  const { config, projectDir, options: normalized } = packager;
  if (target !== "win32-x64")
    throw new Error("Bundled private plugins require Windows x64.");
  if (normalized.publish && normalized.publish !== "never") {
    throw new Error(
      "The private plugin distribution cannot publish to the public update channel.",
    );
  }
  const resources = config.win?.extraResources ?? [];
  const hosts = Array.isArray(resources)
    ? [...(config.extraResources ?? []), ...resources].filter(
        (item) => item.to === "bin/omp.exe",
      )
    : [];
  if (
    process.env.OMP_DESKTOP_BUNDLE_OMP === "0" ||
    !Array.isArray(resources) ||
    hosts.length !== 1 ||
    typeof hosts[0].from !== "string"
  ) {
    throw new Error(
      "The private plugin distribution requires its qualified bundled OMP host.",
    );
  }
  for (const file of [
    "bundled-omp-plugins/manifest.json",
    "bundled-omp-manager.json",
  ]) {
    if (!existsSync(path.join(projectDir, file))) {
      throw new Error(
        `Private plugin payload is missing: ${file}. Run stage:bundled-plugins first.`,
      );
    }
  }
  const hostSource = expandMacro(
    hosts[0].from,
    "x64",
    new AppInfo(packager, null, config.win),
    {
      os: "win",
    },
  );
  const privateHostSource = path.resolve(projectDir, hostSource);
  await verifyPrivateHost(privateHostSource);
  config.extraMetadata = {
    ...config.extraMetadata,
    ompDesktopDistribution: "private-three-plugins",
  };
  packager.metadata.ompDesktopDistribution =
    config.extraMetadata.ompDesktopDistribution;
  config.directories.output = "release-plugins";
  config.win.artifactName =
    "OMP-Desktop-Plugins-Setup-${version}-${arch}.${ext}";
  config.win.extraResources = [
    ...resources,
    { from: "bundled-omp-plugins", to: "bundled-omp-plugins" },
    { from: "bundled-omp-manager.json", to: "manager.json" },
  ];
  normalized.publish = "never";
  return privateHostSource;
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
  const withPlugins = args.includes("--with-bundled-plugins");
  const options = configureBuildCommand(createYargs()).parseSync(
    args.filter((arg) => arg !== "--with-bundled-plugins"),
  );
  if (
    !["x64", "arm64"].includes(runtime.arch) ||
    !runtime.electronApiVersion ||
    typeof runtime.runtimeVersion !== "string" ||
    !runtime.runtimeVersion
  ) {
    throw new Error(
      `Invalid mini-electron runtime metadata at ${runtimeDist}/version.json`,
    );
  }

  // Match the installed runtime even when Node is running under Rosetta.
  if (
    !["x64", "arm64", "ia32", "armv7l", "universal"].some(
      (arch) => options[arch],
    )
  ) {
    options[runtime.arch] = true;
  }
  const normalized = normalizeOptions(options);
  if (withPlugins && normalized.prepackaged != null) {
    throw new Error(
      "--prepackaged bypasses qualified private runtime/resource staging. " +
        "Package from source instead (use --dir to create an unpacked application).",
    );
  }
  const target = await qualifyRuntime(runtimeDist, runtime, normalized);

  projectDir = path.resolve(normalized.projectDir ?? projectDir);
  if (typeof normalized.config === "object") coerceTypes(normalized.config);
  const packager = new QualifiedPackager(
    { ...normalized, projectDir },
    async (qualifiedPackager) => {
      const { config } = qualifiedPackager;
      config.electronDist = runtimeDist;
      config.electronVersion = runtime.electronApiVersion;
      configureOptionalSdk(config, projectDir, runtime);
      if (
        runtime.platform === "win32" &&
        config.win?.signAndEditExecutable === false
      ) {
        throw new Error(
          "Windows packaging requires real executable resource editing and signing.",
        );
      }
      const privateHostSource = withPlugins
        ? await configurePrivateDistribution(qualifiedPackager, target)
        : undefined;
      if (runtime.platform === "win32") {
        deferQualifiedWindowsResources(config, projectDir, privateHostSource);
      }
    },
  );
  await packager.validateConfig();
  return packager;
}

async function main() {
  const packageRoot = path.dirname(
    require.resolve("@iriscat/mini-electron/package.json"),
  );
  const runtimeDist = path.resolve(
    process.env.MINI_ELECTRON_DIST_PATH || path.join(packageRoot, "dist"),
  );
  if (!existsSync(runtimeDist)) {
    throw new Error(
      `mini-electron runtime is missing at ${runtimeDist}; reinstall without MINI_ELECTRON_SKIP_BINARY_DOWNLOAD`,
    );
  }
  const runtime = JSON.parse(
    readFileSync(path.join(runtimeDist, "version.json"), "utf8"),
  );
  const packager = await createQualifiedPackager(
    runtimeDist,
    runtime,
    process.argv.slice(2),
  );
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
