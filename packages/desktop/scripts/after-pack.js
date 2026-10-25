const fs = require("fs");
const path = require("path");

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

function prepareBundledOmp(resourcesDir, platform, arch) {
  const executablePath = path.join(resourcesDir, "bin", platform === "win32" ? "omp.exe" : "omp");
  if (process.env.OMP_DESKTOP_BUNDLE_OMP === "0") {
    rmSafe(executablePath);
    console.log(`Building without bundled OMP for ${platform}-${arch}.`);
    return;
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Bundled OMP executable is missing for ${platform}-${arch}: ${executablePath}`);
  }
  if (platform !== "win32") fs.chmodSync(executablePath, 0o755);
  console.log(`Prepared bundled OMP for ${platform}-${arch}: ${executablePath}`);
}
exports.prepareBundledOmp = prepareBundledOmp;

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
  prepareBundledOmp(resourcesDir, platform, arch);
  assertOmpExtensions(resourcesDir);
  pruneNativeModules(context.appOutDir, platform, arch);
  assertNativeKeyringBinding(resourcesDir, platform, arch);
  assertNativeKoffiBinding(resourcesDir, platform, arch);

  if (platform === "linux" || platform === "win32") {
    if (arch !== process.arch) {
      console.log(
        `Skipping packaged-app smoke: build arch ${arch} differs from host ${process.arch}.`,
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
