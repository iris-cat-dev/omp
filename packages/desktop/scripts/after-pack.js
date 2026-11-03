const fs = require("fs");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

const PRODUCT_NAME = "OMP Desktop";

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneChildrenExcept(parent, keep) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (!keep.has(entry)) {
      rmSafe(path.join(parent, entry));
    }
  }
}

function pruneNodePty(nodeModules, platform, arch) {
  const prebuilds = path.join(nodeModules, "node-pty", "prebuilds");
  pruneChildrenExcept(prebuilds, new Set([`${platform}-${arch}`]));

  rmSafe(path.join(nodeModules, "node-pty", "third_party"));
}

function pruneSharpLibvips(nodeModules, platform, arch) {
  const prefix = `sharp-libvips-${platform}-${arch}`;
  const imgDir = path.join(nodeModules, "@img");
  if (!fs.existsSync(imgDir)) return;

  for (const entry of fs.readdirSync(imgDir)) {
    if (
      entry.startsWith("sharp-") &&
      entry !== prefix &&
      !entry.startsWith(`sharp-${platform}-${arch}`)
    ) {
      rmSafe(path.join(imgDir, entry));
    }
  }
}
function pruneKeyring(nodeModules, platform, arch) {
  const napiDir = path.join(nodeModules, "@napi-rs");
  if (!fs.existsSync(napiDir)) return;

  const prefix = `keyring-${platform}-${arch}`;
  for (const entry of fs.readdirSync(napiDir)) {
    if (
      entry.startsWith("keyring-") &&
      entry !== prefix &&
      !entry.startsWith(`${prefix}-`) &&
      !(platform === "darwin" && entry === "keyring-darwin-universal")
    ) {
      rmSafe(path.join(napiDir, entry));
    }
  }
}

function pruneKoffi(nodeModules, platform, arch) {
  const nativeDir = path.join(nodeModules, "@koromix");
  if (!fs.existsSync(nativeDir)) return;

  const arches = arch === "universal" ? ["x64", "arm64"] : [arch];
  const keep = new Set(arches.map((targetArch) => `koffi-${platform}-${targetArch}`));
  for (const entry of fs.readdirSync(nativeDir)) {
    if (entry.startsWith("koffi-") && !keep.has(entry)) {
      rmSafe(path.join(nativeDir, entry));
    }
  }
}
exports.pruneKoffi = pruneKoffi;

function assertNativeKoffiBinding(resourcesDir, platform, arch) {
  if (platform !== "win32") return;

  const nodeModules = path.join(resourcesDir, "app", "node_modules");
  const nativePackage = path.join("@koromix", `koffi-${platform}-${arch}`);
  // Koffi 3's entrypoint executes JavaScript under src/ before loading its
  // sibling platform package. Those files are runtime code, not build sources.
  const runtimeFiles = [
    path.join("koffi", "package.json"),
    path.join("koffi", "index.cjs"),
    path.join("koffi", "src", "koffi", "index.cjs"),
    path.join("koffi", "src", "koffi", "src", "static.cjs"),
    path.join(nativePackage, "package.json"),
    path.join(nativePackage, "index.js"),
    path.join(nativePackage, `${platform}_${arch}`, "koffi.node"),
  ];
  for (const relativePath of runtimeFiles) {
    const runtimePath = path.join(nodeModules, relativePath);
    if (!fs.existsSync(runtimePath) || !fs.statSync(runtimePath).isFile()) {
      throw new Error(
        `Packaged Windows Koffi runtime is missing for ${arch}: ${runtimePath}. ` +
          "Install production dependencies with optional packages enabled before packaging.",
      );
    }
  }
}
exports.assertNativeKoffiBinding = assertNativeKoffiBinding;

function keyringBindingPath(resourcesDir, arch) {
  const bindingName = `win32-${arch}-msvc`;
  return path.join(
    resourcesDir,
    "app",
    "node_modules",
    "@napi-rs",
    `keyring-${bindingName}`,
    `keyring.${bindingName}.node`,
  );
}

function assertNativeKeyringBinding(resourcesDir, platform, arch) {
  if (platform !== "win32") return;

  const bindingPath = keyringBindingPath(resourcesDir, arch);
  if (!fs.existsSync(bindingPath)) {
    throw new Error(
      `Packaged Windows keyring binding is missing for ${arch}: ${bindingPath}. ` +
        "Build Windows artifacts with npm run build:windows.",
    );
  }
}

exports.assertNativeKeyringBinding = assertNativeKeyringBinding;

function pruneNativeModules(appOutDir, platform, arch) {
  const resourcesDir =
    platform === "darwin"
      ? path.join(appOutDir, `${PRODUCT_NAME}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");

  const nodeModules = path.join(resourcesDir, "app", "node_modules");
  if (!fs.existsSync(nodeModules)) return;

  const before = dirSizeSync(nodeModules);

  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);
  pruneKeyring(nodeModules, platform, arch);
  pruneKoffi(nodeModules, platform, arch);

  const after = dirSizeSync(nodeModules);
  const savedMB = ((before - after) / 1024 / 1024).toFixed(1);
  console.log(`Pruned native modules: ${savedMB} MB removed (${fmtMB(before)} → ${fmtMB(after)})`);
}

async function copyRipgrep(resourcesDir, platform, arch) {
  if (arch === "universal") {
    throw new Error("A universal desktop build requires a universal ripgrep binary.");
  }
  const { binPathFor } = await import("@vscode/ripgrep-universal");
  const source = binPathFor({ os: platform, arch });
  const destinationDir = path.join(resourcesDir, "bin");
  const destination = path.join(destinationDir, platform === "win32" ? "rg.exe" : "rg");
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, destination);
  if (platform !== "win32") fs.chmodSync(destination, 0o755);
  console.log(`Bundled ripgrep for ${platform}-${arch}: ${destination}`);
}

function assertOmpExtensions(resourcesDir) {
  const extensionsDir = path.join(
    resourcesDir,
    "app",
    "node_modules",
    "@omp-desktop",
    "server",
    "dist",
    "server",
    "server",
    "agent",
    "providers",
    "omp",
  );
  for (const filename of ["background-jobs-extension.js", "image-settings-extension.js"]) {
    const extensionPath = path.join(extensionsDir, filename);
    if (!fs.existsSync(extensionPath)) {
      throw new Error(`Packaged OMP extension is missing: ${extensionPath}`);
    }
  }
}

function deduplicateSdkSharp(resourcesDir, platform, arch) {
  const resources = fs.realpathSync(resourcesDir);
  const sdk = path.join(resources, "omp-sdk");
  const sdkMetadata = path.join(
    sdk,
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
    "package.json",
  );
  if (!fs.existsSync(sdkMetadata)) {
    throw new Error(
      `Required packaged SDK is missing: ${sdkMetadata}. Run npm run build:omp-sdk before packaging.`,
    );
  }
  const desktop = path.join(resources, "app");
  const inside = (parent, file) => {
    const relative = path.relative(parent, file);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  const confined = (owner, file) => {
    const real = fs.realpathSync(file);
    if (!inside(resources, real) || !inside(owner, real)) {
      throw new Error(`Sharp dependency escapes its packaged runtime: ${file} → ${real}`);
    }
    return real;
  };
  confined(resources, sdk);
  confined(resources, desktop);

  function resolvePackage(from, name, owner, subpath = "") {
    const load = createRequire(from);
    const entry = confined(owner, load.resolve(`${name}${subpath}`));
    let root = path.dirname(entry);
    while (inside(owner, root)) {
      const metadata = path.join(root, "package.json");
      if (fs.existsSync(metadata)) {
        const data = JSON.parse(fs.readFileSync(confined(owner, metadata), "utf8"));
        if (data.name === name) return { root, metadata, data, entry };
      }
      root = path.dirname(root);
    }
    throw new Error(`Cannot locate packaged Sharp dependency ${name} from ${from}`);
  }

  const sdkSharp = resolvePackage(sdkMetadata, "sharp", sdk);
  const desktopSharp = resolvePackage(path.join(desktop, "package.json"), "sharp", desktop);
  const compared = new Set();
  function matchPackages(left, right) {
    const key = `${left.root}\0${right.root}`;
    if (compared.has(key)) return;
    compared.add(key);
    if (
      !left.data.version ||
      left.data.name !== right.data.name ||
      left.data.version !== right.data.version
    ) {
      throw new Error(
        `Cannot share Sharp dependency ${left.data.name}: SDK ${left.data.version}, Desktop ${right.data.version}`,
      );
    }
    const names = new Set([
      ...Object.keys(left.data.dependencies || {}),
      ...Object.keys(right.data.dependencies || {}),
    ]);
    for (const name of names) {
      // SDK staging pins ranges to installed versions; compare the resolved
      // closure below, not equivalent range spellings in source manifests.
      if (
        !Object.hasOwn(left.data.dependencies || {}, name) ||
        !Object.hasOwn(right.data.dependencies || {}, name)
      ) {
        throw new Error(`Sharp dependency closure differs for ${left.data.name}: ${name}`);
      }
      matchPackages(
        resolvePackage(left.metadata, name, sdk),
        resolvePackage(right.metadata, name, desktop),
      );
    }
  }
  matchPackages(sdkSharp, desktopSharp);

  const target = `${platform}-${arch}`;
  function assertNativeTarget(pkg, version) {
    if (
      pkg.data.version !== version ||
      !pkg.data.os?.includes(platform) ||
      !pkg.data.cpu?.includes(arch)
    ) {
      throw new Error(`Sharp package does not match ${target}: ${pkg.metadata}`);
    }
  }
  function resolveNativeReplacements() {
    const nativeName = `@img/sharp-${target}`;
    const libvipsName = `@img/sharp-libvips-${target}`;
    const replacements = [[sdkSharp, desktopSharp]];
    for (const name of [nativeName, libvipsName]) {
      const sdkVersion = sdkSharp.data.optionalDependencies?.[name];
      const desktopVersion = desktopSharp.data.optionalDependencies?.[name];
      // Windows packages carry libvips alongside the addon instead of a separate package.
      if (name === libvipsName && !sdkVersion && !desktopVersion && platform === "win32") continue;
      if (!sdkVersion || sdkVersion !== desktopVersion) {
        throw new Error(`Sharp native target declarations do not match for ${name}`);
      }
      const left = resolvePackage(sdkSharp.metadata, name, sdk, "/package");
      const right = resolvePackage(desktopSharp.metadata, name, desktop, "/package");
      matchPackages(left, right);
      for (const pkg of [left, right]) assertNativeTarget(pkg, sdkVersion);
      replacements.push([left, right]);
    }
    const sdkNative = replacements[1][0];
    const desktopNative = replacements[1][1];
    if (
      sdkNative.data.optionalDependencies?.[libvipsName] !==
        desktopNative.data.optionalDependencies?.[libvipsName] ||
      (replacements[2] &&
        sdkNative.data.optionalDependencies?.[libvipsName] !== replacements[2][0].data.version)
    ) {
      throw new Error(`Sharp addon/libvips closure does not match ${target}`);
    }
    return { replacements, sdkNative };
  }
  const { replacements, sdkNative } = resolveNativeReplacements();

  function nativeFiles(pkg, owner) {
    const files = new Map();
    function visit(directory) {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        confined(owner, file);
        if (fs.statSync(file).isDirectory()) {
          if (name !== "node_modules") visit(file);
        } else if (/\.(node|dylib|dll|so)(\.\d+)*$/.test(name)) {
          files.set(
            path.relative(pkg.root, file),
            createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          );
        }
      }
    }
    visit(pkg.root);
    return files;
  }
  // Validate the actual target payload before deleting any release-copy directory.
  for (const [left, right] of replacements) {
    const sdkFiles = nativeFiles(left, sdk);
    const desktopFiles = nativeFiles(right, desktop);
    if (
      (left !== sdkSharp && sdkFiles.size === 0) ||
      (left === sdkNative && ![...sdkFiles.keys()].some((file) => file.endsWith(".node"))) ||
      sdkFiles.size !== desktopFiles.size ||
      [...sdkFiles].some(([file, digest]) => desktopFiles.get(file) !== digest)
    ) {
      throw new Error(`Sharp native payloads do not match for ${left.data.name}`);
    }
  }
  if (platform === "win32") {
    // Relative directory symlinks require privileges; absolute junctions break
    // when NSIS installs the app elsewhere. Keep the validated SDK copy instead.
    console.log(
      `Kept independent packaged Sharp ${desktopSharp.data.version} runtimes for ${target}.`,
    );
    return;
  }
  for (const [left, right] of replacements) {
    // Nested native packages disappear with their Sharp parent; never traverse the new link to edit Desktop.
    if (replacements.some(([parent]) => parent !== left && inside(parent.root, left.root)))
      continue;
    // Only unlink the App's copied directories: staging/tarballs and their hardlinks stay untouched.
    rmSafe(left.root);
    fs.symlinkSync(path.relative(path.dirname(left.root), right.root), left.root, "dir");
  }
  console.log(
    `Shared packaged Sharp ${desktopSharp.data.version} runtime for ${target} via App-relative links.`,
  );
}
exports.deduplicateSdkSharp = deduplicateSdkSharp;

function stripCoreSdkAddon(resourcesDir, platform, arch) {
  if (platform !== "darwin") return;
  const metadata = path.join(
    resourcesDir,
    "omp-sdk",
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
    "package.json",
  );
  if (!fs.existsSync(metadata)) return;
  if (JSON.parse(fs.readFileSync(metadata, "utf8")).ompNodeSdk?.profile !== "core") return;
  const load = createRequire(metadata);
  const addon = fs.realpathSync(
    path.join(
      path.dirname(load.resolve("@oh-my-pi/pi-natives")),
      `pi_natives.${platform}-${arch}.node`,
    ),
  );
  const relative = path.relative(fs.realpathSync(resourcesDir), addon);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to strip a native addon outside the packaged app: ${addon}`);
  }
  const before = fs.statSync(addon).size;
  const temporary = `${addon}.strip-${process.pid}`;
  try {
    // Break any packager hardlink before modifying the app's release copy.
    fs.copyFileSync(addon, temporary, fs.constants.COPYFILE_EXCL);
    const stripped = spawnSync("/usr/bin/strip", ["-x", temporary], { encoding: "utf8" });
    if (stripped.error || stripped.status !== 0) {
      throw (
        stripped.error || new Error(`Could not strip core SDK native symbols: ${stripped.stderr}`)
      );
    }
    fs.renameSync(temporary, addon);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`Core SDK native addon: ${fmtMB(before)} → ${fmtMB(fs.statSync(addon).size)}`);
}
exports.stripCoreSdkAddon = stripCoreSdkAddon;

function dirSizeSync(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += fs.statSync(path.join(entry.parentPath || entry.path, entry.name)).size;
      } catch {}
    }
  }
  return total;
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = ARCH_MAP[context.arch] || process.arch;

  const resourcesDir =
    platform === "darwin"
      ? path.join(context.appOutDir, `${PRODUCT_NAME}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  await copyRipgrep(resourcesDir, platform, arch);
  assertOmpExtensions(resourcesDir);
  pruneNativeModules(context.appOutDir, platform, arch);
  stripCoreSdkAddon(resourcesDir, platform, arch);
  deduplicateSdkSharp(resourcesDir, platform, arch);
  assertNativeKeyringBinding(resourcesDir, platform, arch);
  assertNativeKoffiBinding(resourcesDir, platform, arch);

  if (platform === "linux" || platform === "win32") {
    if (platform !== process.platform || arch !== process.arch) {
      console.log(
        `Skipping packaged-app smoke: build ${platform}-${arch} differs from host ${process.platform}-${process.arch}.`,
      );
    } else {
      await smokeUnpackedAppIfRequested(context.appOutDir);
    }
  }
};

async function smokeUnpackedAppIfRequested(appOutDir) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath: appOutDir,
  });
}
