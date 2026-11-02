import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";
import { stageNodeSdk } from "../omp-sdk/scripts/stage-node-sdk.mjs";

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
const sdk = await stageNodeSdk(sdkRoot, path.join(rootDir, "packages", "desktop", "sdk-dist"), {
  buildTarget,
  profile,
});
console.log(
  `Built OMP SDK ${sdk.version} (${sdk.buildTarget}, ${sdk.platform}-${sdk.arch}) at ${sdk.directory}`,
);
