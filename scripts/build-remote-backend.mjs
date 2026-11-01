import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "packages", "desktop", "remote-backend-dist");
const packageDir = path.join(outputDir, "packages");
const stageDir = path.join(rootDir, "packages", "desktop", "sdk-dist");
const config = resolveOmpSdkBuildConfig();
const manifest = JSON.parse(await readFile(path.join(stageDir, "manifest.json"), "utf8"));
const stagedSource = JSON.parse(await readFile(path.join(stageDir, "source.json"), "utf8"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.packageName !== "@oh-my-pi/pi-coding-agent" ||
  manifest.packageRoot !== "node_modules/@oh-my-pi/pi-coding-agent" ||
  manifest.platform !== process.platform ||
  manifest.arch !== process.arch ||
  manifest.buildTarget !== config.buildTarget ||
  manifest.profile !== config.profile ||
  stagedSource.packageRoot !== (await realpath(config.source))
) {
  throw new Error("The staged SDK does not match this build. Run npm run build:omp-sdk first.");
}
const sdk = { ...manifest, archive: path.join(stageDir, "omp-sdk.tgz") };
// Remote deployments use the same SDK and target-native dependency closure as Desktop.
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
  files.push({ absolutePath: sdk.archive, relativePath: "sdk/omp-sdk.tgz" });
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
await cp(sdk.archive, path.join(packageDir, "omp-sdk.tgz"));
dependencies[sdk.packageName] = "file:packages/omp-sdk.tgz";

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
      bundleHash,
      nodeVersion: sdk.minimumNodeVersion,
      supportedTargets: [`${sdk.platform}-${sdk.arch}`],
      sdk: { packageName: sdk.packageName, version: sdk.version },
      files: hashes,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built remote backend ${rootPackage.version} in ${outputDir}`);
