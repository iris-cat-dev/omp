import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stageOmpSdk } from "./stage-omp-sdk.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "packages", "desktop", "remote-backend-dist");
const packageDir = path.join(outputDir, "packages");
const sdkSource = process.env.OMP_DESKTOP_SDK_SOURCE;
const includeRemoteSdk = process.env.OMP_DESKTOP_REMOTE_SDK === "1";
if (includeRemoteSdk && !sdkSource) {
  throw new Error("OMP_DESKTOP_REMOTE_SDK=1 requires OMP_DESKTOP_SDK_SOURCE.");
}
const sdk = sdkSource
  ? await stageOmpSdk(sdkSource, path.join(rootDir, "packages", "desktop", "sdk-dist"))
  : undefined;
// Local SDK resources do not duplicate their tarball in the remote deployment payload.
const remoteSdk = includeRemoteSdk ? sdk : undefined;
const toolVersions = await readFile(path.join(rootDir, ".tool-versions"), "utf8");
const nodeVersion = /^nodejs\s+(\S+)$/mu.exec(toolVersions)?.[1];
if (!nodeVersion) throw new Error("The pinned Node.js version is missing from .tool-versions");
const workspacePackages = [
  ["@omp-desktop/highlight", "highlight"],
  ["@omp-desktop/protocol", "protocol"],
  ["@omp-desktop/relay", "relay"],
  ["@omp-desktop/client", "client"],
  ["@omp-desktop/server", "server"],
  ["@omp-desktop/cli", "cli"],
];

function run(command, args, options = {}) {
  // npm is a .cmd shim on Windows; invoke the CLI with Node without a shell.
  const npmCli = command === "npm" ? process.env.npm_execpath : undefined;
  const result = spawnSync(npmCli ? process.execPath : command, npmCli ? [npmCli, ...args] : args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function collectSourceFiles(directory, relativeRoot, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === "coverage" ||
      entry.name === ".DS_Store"
    ) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(absolutePath, relativePath, files);
    } else if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
}

async function calculateBundleHash() {
  const files = [
    {
      absolutePath: path.join(rootDir, ".tool-versions"),
      relativePath: ".tool-versions",
    },
    {
      absolutePath: path.join(rootDir, "package-lock.json"),
      relativePath: "package-lock.json",
    },
  ];
  for (const [, directoryName] of workspacePackages) {
    await collectSourceFiles(
      path.join(rootDir, "packages", directoryName),
      `packages/${directoryName}`,
      files,
    );
  }
  await collectSourceFiles(path.join(rootDir, "skills"), "skills", files);
  if (remoteSdk) {
    files.push({ absolutePath: remoteSdk.archive, relativePath: "optional-sdk/omp-sdk.tgz" });
  }
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(file.relativePath).update("\0");
    hash.update(await readFile(file.absolutePath)).update("\n");
  }
  return hash.digest("hex");
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });

const dependencies = {};
for (const [packageName, directoryName] of workspacePackages) {
  const before = new Set(await readdir(packageDir));
  run(
    "npm",
    [
      "pack",
      path.join(rootDir, "packages", directoryName),
      "--ignore-scripts",
      "--pack-destination",
      packageDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const generated = (await readdir(packageDir)).filter((entry) => !before.has(entry));
  if (generated.length !== 1) {
    throw new Error(`Expected npm pack to create one archive for ${packageName}`);
  }
  const archiveName = `${directoryName}.tgz`;
  await rename(path.join(packageDir, generated[0]), path.join(packageDir, archiveName));
  dependencies[packageName] = `file:packages/${archiveName}`;
}
if (remoteSdk) {
  await cp(remoteSdk.archive, path.join(packageDir, "omp-sdk.tgz"));
  dependencies[remoteSdk.packageName] = "file:packages/omp-sdk.tgz";
}

const deploymentPackage = {
  name: "omp-desktop-remote-backend",
  version: "0.0.0",
  private: true,
  dependencies,
};
await writeFile(
  path.join(outputDir, "package.json"),
  `${JSON.stringify(deploymentPackage, null, 2)}\n`,
);
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev"], {
  cwd: outputDir,
  stdio: ["ignore", "pipe", "pipe"],
});

const files = ["package.json", "package-lock.json"];
for (const entry of await readdir(packageDir)) files.push(`packages/${entry}`);
const hashes = {};
for (const relativePath of files.sort()) {
  hashes[relativePath] = await sha256(path.join(outputDir, relativePath));
}
const bundleHash = await calculateBundleHash();

const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
await writeFile(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      backendVersion: rootPackage.version,
      nodeVersion: remoteSdk ? remoteSdk.minimumNodeVersion : nodeVersion,
      bundleHash,
      supportedTargets: remoteSdk
        ? [`${remoteSdk.platform}-${remoteSdk.arch}`]
        : ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
      ...(remoteSdk
        ? { sdk: { packageName: remoteSdk.packageName, version: remoteSdk.version } }
        : {}),
      files: hashes,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built remote backend ${rootPackage.version} in ${outputDir}`);
