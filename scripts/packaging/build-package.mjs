#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const target =
  args[0] && !args[0].startsWith("-")
    ? args.shift()
    : { darwin: "mac", win32: "windows" }[process.platform];

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run build:package -- [mac|windows] [electron-builder options]

With no target, package for the current OS.
mac:     macOS arm64, requires a Mac; produces DMG and ZIP.
windows: Windows x64; macOS cross-builds require OMP_DESKTOP_SDK_ARTIFACT. Produces NSIS, ZIP and update metadata.
Output:  packages/desktop/release/
Local builds default to --publish never.`);
  process.exit(0);
}

if (target !== "mac" && target !== "windows") {
  throw new Error("Choose a supported packaging target: mac or windows.");
}
if (target === "mac" && process.platform !== "darwin") {
  throw new Error(
    "macOS packages must be built on macOS (Apple signing and DMG tools are required).",
  );
}
if (target === "windows") {
  if (process.platform !== "darwin" && (process.platform !== "win32" || process.arch !== "x64")) {
    throw new Error(
      "Windows packaging requires macOS with a Windows x64 SDK artifact or native Windows x64.",
    );
  }
  if (process.platform === "darwin" && !process.env.OMP_DESKTOP_SDK_ARTIFACT) {
    throw new Error(
      "macOS Windows cross-builds require an extracted native Windows x64 SDK artifact at absolute OMP_DESKTOP_SDK_ARTIFACT.",
    );
  }
  const artifact = process.env.OMP_DESKTOP_SDK_ARTIFACT;
  if (artifact && (!path.isAbsolute(artifact) || !statSync(artifact).isDirectory())) {
    throw new Error("OMP_DESKTOP_SDK_ARTIFACT must be an absolute extracted artifact directory.");
  }
}

const nativeWindows = target === "windows" && process.platform === "win32";
const scriptPath = fileURLToPath(
  new URL(
    target === "mac"
      ? "./build-mac.sh"
      : nativeWindows
        ? "./build-windows.ps1"
        : "./build-windows.sh",
    import.meta.url,
  ),
);
const result = spawnSync(
  nativeWindows ? "powershell.exe" : "bash",
  [
    ...(nativeWindows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] : []),
    scriptPath,
    ...args,
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
