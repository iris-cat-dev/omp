#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  resolvePackage,
  unpackNpmPackage,
} from "../../../scripts/packaging/npm-archive.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(desktopRoot, "../..");
const target = process.env.OMP_DESKTOP_PACKAGE_TARGET;
if (target && target !== "win32-x64")
  throw new Error(`Unsupported native staging target: ${target}`);

function hasFiles(root, files) {
  return files.every((file) => {
    const location = path.join(root, file);
    return existsSync(location) && statSync(location).isFile();
  });
}

function nodeModulesFor(pkg) {
  let directory = path.dirname(pkg.root);
  while (path.basename(directory) !== "node_modules") {
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`Package is not installed in node_modules: ${pkg.root}`);
    directory = parent;
  }
  return directory;
}

function matchSharpClosure(sdk, desktop, seen = new Set()) {
  const key = `${sdk.root}\0${desktop.root}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (sdk.data.name !== desktop.data.name || sdk.data.version !== desktop.data.version) {
    throw new Error(
      `SDK/Desktop Sharp dependency mismatch for ${sdk.data.name}: ${sdk.data.version} != ${desktop.data.version}`,
    );
  }
  const dependencies = new Set([
    ...Object.keys(sdk.data.dependencies || {}),
    ...Object.keys(desktop.data.dependencies || {}),
  ]);
  for (const name of dependencies) {
    if (
      !Object.hasOwn(sdk.data.dependencies || {}, name) ||
      !Object.hasOwn(desktop.data.dependencies || {}, name)
    ) {
      throw new Error(`SDK/Desktop Sharp dependency closure differs for ${sdk.data.name}: ${name}`);
    }
    matchSharpClosure(
      resolvePackage(sdk.metadata, name),
      resolvePackage(desktop.metadata, name),
      seen,
    );
  }
}

if (target === "win32-x64") {
  const lock = readJson(path.join(repository, "package-lock.json"));
  const desktopMetadata = path.join(desktopRoot, "package.json");
  const serverMetadata = path.join(repository, "packages/server/package.json");
  const sharp = resolvePackage(serverMetadata, "sharp");
  const sdkSharp = resolvePackage(
    path.join(desktopRoot, "sdk-dist/node_modules/@oh-my-pi/pi-coding-agent/package.json"),
    "sharp",
  );
  matchSharpClosure(sdkSharp, sharp);
  for (const name of ["@img/sharp-win32-x64", "@img/sharp-libvips-win32-x64"]) {
    if (sdkSharp.data.optionalDependencies?.[name] !== sharp.data.optionalDependencies?.[name]) {
      throw new Error(`SDK/Desktop Sharp native target declarations differ for ${name}`);
    }
  }

  const temporary = mkdtempSync(path.join(os.tmpdir(), "omp-windows-native-"));
  const replacements = [];
  let sequence = 0;
  try {
    function locked(name, version, destination) {
      const key = path.relative(repository, destination).split(path.sep).join("/");
      const entry = lock.packages[key] || lock.packages[`node_modules/${name}`];
      if (entry?.version !== version)
        throw new Error(`Installed parent requires ${name}@${version}, but the lockfile differs.`);
      return entry;
    }

    function optionalPackage(parent, name, files, subpath = "") {
      const version = parent.data.optionalDependencies?.[name];
      if (!version) throw new Error(`${parent.data.name} does not declare ${name}.`);
      let destination = path.join(nodeModulesFor(parent), name);
      let installed;
      try {
        installed = resolvePackage(parent.metadata, name, subpath);
        destination = installed.root;
      } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
      }
      const entry = locked(name, version, destination);
      if (
        installed?.data.version === version &&
        installed.data.os?.includes("win32") &&
        installed.data.cpu?.includes("x64") &&
        hasFiles(installed.root, files)
      )
        return;
      const pkg = unpackNpmPackage(name, version, path.join(temporary, String(sequence++)), entry);
      if (
        !pkg.data.os?.includes("win32") ||
        !pkg.data.cpu?.includes("x64") ||
        !hasFiles(pkg.root, files)
      ) {
        throw new Error(`Windows x64 native package is incomplete: ${name}@${version}`);
      }
      replacements.push({ source: pkg.root, destination });
    }

    optionalPackage(
      resolvePackage(serverMetadata, "@napi-rs/keyring"),
      "@napi-rs/keyring-win32-x64-msvc",
      ["keyring.win32-x64-msvc.node"],
    );
    optionalPackage(resolvePackage(desktopMetadata, "koffi"), "@koromix/koffi-win32-x64", [
      "index.js",
      "win32_x64/koffi.node",
    ]);
    optionalPackage(
      sharp,
      "@img/sharp-win32-x64",
      ["index.cjs", "versions.json", `lib/sharp-win32-x64-${sharp.data.version}.node`],
      "/package",
    );

    // These universal npm archives already contain Windows payloads on a Mac.
    // Restore only a missing target directory, keeping all host-native files intact.
    function universalPayload(name, relative, files) {
      const pkg = resolvePackage(desktopMetadata, name);
      if (hasFiles(path.join(pkg.root, relative), files)) return;
      const entry = locked(name, pkg.data.version, pkg.root);
      const unpacked = unpackNpmPackage(
        name,
        pkg.data.version,
        path.join(temporary, String(sequence++)),
        entry,
      );
      const source = path.join(unpacked.root, relative);
      if (!hasFiles(source, files))
        throw new Error(`Windows x64 payload is missing from ${name}@${pkg.data.version}`);
      replacements.push({ source, destination: path.join(pkg.root, relative) });
    }
    universalPayload("node-pty", "prebuilds/win32-x64", [
      "conpty.node",
      "conpty_console_list.node",
      "conpty/OpenConsole.exe",
      "conpty/conpty.dll",
    ]);
    universalPayload("@vscode/ripgrep-universal", "bin/win32-x64", ["rg.exe"]);

    // Fetch and validate every archive before changing the installed dependency tree.
    for (const { source, destination } of replacements) {
      mkdirSync(path.dirname(destination), { recursive: true });
      const pending = `${destination}.omp-stage-${process.pid}`;
      const backup = `${destination}.omp-backup-${process.pid}`;
      try {
        cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
        if (existsSync(destination)) renameSync(destination, backup);
        try {
          renameSync(pending, destination);
        } catch (error) {
          if (existsSync(backup)) renameSync(backup, destination);
          throw error;
        }
        rmSync(backup, { recursive: true, force: true });
      } finally {
        rmSync(pending, { recursive: true, force: true });
      }
      console.log(`Staged Windows native payload: ${path.relative(repository, destination)}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
