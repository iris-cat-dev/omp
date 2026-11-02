#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, runCommand, unpackNpmPackage } from "./npm-archive.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = process.argv[2];
if (!output) throw new Error("Usage: node prepare-windows-runtime.mjs <temporary-directory>");
if (process.env.MINI_ELECTRON_DIST_PATH) {
  console.log(path.resolve(process.env.MINI_ELECTRON_DIST_PATH));
} else {
  const name = "@iriscat/mini-electron";
  const desktop = readJson(path.join(repository, "packages/desktop/package.json"));
  const version = desktop.devDependencies[name];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? "")) {
    throw new Error(
      "Windows runtime preparation requires a pinned mini-electron installer version.",
    );
  }
  const lock = readJson(path.join(repository, "package-lock.json"));
  const entry = lock.packages[`node_modules/${name}`];
  if (entry?.version !== version)
    throw new Error("mini-electron installer does not match the package lockfile.");
  const installer = unpackNpmPackage(name, version, path.resolve(output), entry);
  // install.js is self-contained. Run only this pinned installer in isolation,
  // never npm install in the repository or the Mac runtime's package directory.
  runCommand(process.execPath, [path.join(installer.root, "install.js")], {
    cwd: installer.root,
    stdio: ["ignore", 2, 2],
    env: {
      ...process.env,
      npm_config_platform: "win32",
      npm_config_arch: "x64",
      MINI_ELECTRON_SKIP_BINARY_DOWNLOAD: "0",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "0",
    },
  });
  const distribution = path.join(installer.root, "dist");
  const metadata = readJson(path.join(distribution, "version.json"));
  if (metadata.platform !== "win32" || metadata.arch !== "x64") {
    throw new Error(
      `mini-electron installer returned the wrong target: ${metadata.platform}-${metadata.arch}`,
    );
  }
  console.log(distribution);
}
