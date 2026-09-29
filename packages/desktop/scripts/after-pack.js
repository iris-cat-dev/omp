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

  if (platform !== "win32") {
    rmSafe(path.join(nodeModules, "node-pty", "third_party"));
  }
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
function pruneEsbuild(nodeModules, platform, arch) {
  pruneChildrenExcept(path.join(nodeModules, "@esbuild"), new Set([`${platform}-${arch}`]));
}

function keyringBindingPath(resourcesDir, arch) {
  const bindingName = `win32-${arch}-msvc`;
  return path.join(
    resourcesDir,
    "app.asar.unpacked",
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

  const nodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (!fs.existsSync(nodeModules)) return;

  const before = dirSizeSync(nodeModules);

  pruneNodePty(nodeModules, platform, arch);
  pruneSharpLibvips(nodeModules, platform, arch);
  pruneEsbuild(nodeModules, platform, arch);

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

function assertBackgroundJobsExtension(resourcesDir) {
  const extensionPath = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "@omp-desktop",
    "server",
    "dist",
    "server",
    "server",
    "agent",
    "providers",
    "omp",
    "background-jobs-extension.js",
  );
  if (!fs.existsSync(extensionPath)) {
    throw new Error(`Packaged OMP background-jobs extension is missing: ${extensionPath}`);
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
  assertBackgroundJobsExtension(resourcesDir);
  assertNativeKeyringBinding(resourcesDir, platform, arch);
  pruneNativeModules(context.appOutDir, platform, arch);

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
