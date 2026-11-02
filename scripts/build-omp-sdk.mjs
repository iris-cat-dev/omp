import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";
import { stageNodeSdk } from "../omp-sdk/scripts/stage-node-sdk.mjs";
import { importSdkArtifact } from "./packaging/sdk-artifact.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { source, buildTarget, profile } = resolveOmpSdkBuildConfig();
if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("Building the OMP Node SDK requires Node.js 24 or newer.");
}
let sdkRoot;
try {
  sdkRoot = await realpath(source);
} catch (error) {
  throw new Error(
    `SDK checkout is missing at ${source}. Run git submodule update --init --recursive.`,
    { cause: error },
  );
}
const sdkRepo = path.resolve(sdkRoot, "..", "..");
const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
if (manifest.name !== "@oh-my-pi/pi-coding-agent") {
  throw new Error(`Expected the OMP SDK source package at ${sdkRoot}.`);
}

function run(args) {
  const result = spawnSync("bun", args, { cwd: sdkRepo, stdio: "inherit" });
  if (result.error) {
    throw new Error("The SDK build requires Bun on PATH; install Bun before building.", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`SDK build failed: bun ${args.join(" ")} (exit ${result.status}).`);
  }
}

const outputDir = path.join(rootDir, "packages", "desktop", "sdk-dist");
const target = process.env.OMP_DESKTOP_PACKAGE_TARGET ?? `${process.platform}-${process.arch}`;
const [platform, arch] = target.split("-");
let sdk;
if (process.env.OMP_DESKTOP_SDK_ARTIFACT) {
  sdk = await importSdkArtifact(process.env.OMP_DESKTOP_SDK_ARTIFACT, outputDir, {
    platform,
    arch,
  });
} else {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `Packaging ${target} on ${process.platform}-${process.arch} requires OMP_DESKTOP_SDK_ARTIFACT from Package release.`,
    );
  }
  // The SDK uses its own lockfile and workspace graph, not Desktop's npm workspace.
  run(["install", "--frozen-lockfile"]);
  run([
    `--cwd=${path.join(sdkRepo, "packages", "natives")}`,
    "run",
    buildTarget === "desktop" ? "build:desktop" : "build:bindings",
  ]);
  run([
    `--cwd=${sdkRoot}`,
    "run",
    buildTarget === "desktop" ? "gen:bundle:desktop" : "gen:bundle:node",
  ]);
  sdk = await stageNodeSdk(sdkRoot, outputDir, { buildTarget, profile });
}
console.log(
  `Prepared OMP SDK ${sdk.version} (${sdk.buildTarget}, ${sdk.platform}-${sdk.arch}) at ${sdk.directory}`,
);
