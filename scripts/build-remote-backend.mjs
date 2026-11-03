import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveOmpSdkBuildConfig } from "./omp-sdk-build-config.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "packages", "desktop", "remote-backend-dist");
const sdkName = "@oh-my-pi/pi-coding-agent";
const releaseConfigFile = path.join(rootDir, "omp-sdk", "sdk", "node-release.json");
const workspacePackages = [
  ["@omp-desktop/highlight", "highlight"],
  ["@omp-desktop/protocol", "protocol"],
  ["@omp-desktop/relay", "relay"],
  ["@omp-desktop/client", "client"],
  ["@omp-desktop/server", "server"],
  ["@omp-desktop/cli", "cli"],
];

function runNpm(args, cwd) {
  const cli = process.env.npm_execpath;
  const result = spawnSync(
    cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    cli ? [cli, ...args] : args,
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      shell: !cli && process.platform === "win32",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadSdk(url, destination, asset) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`SDK Release download failed (${response.status}): ${url}`);
  }
  const hash = createHash("sha256");
  const integrity = createHash("sha512");
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        integrity.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx" }),
  );
  if (
    size !== asset.size ||
    hash.digest("hex") !== asset.sha256 ||
    `sha512-${integrity.digest("base64")}` !== asset.integrity
  ) {
    throw new Error(`SDK Release checksum or size mismatch: ${url}`);
  }
}

function validateRelease(config, index, version) {
  const supported = new Set(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);
  if (
    config.schemaVersion !== 1 ||
    config.repository !== "iris-cat-dev/omp-sdk" ||
    !/^[A-Za-z0-9._-]+$/u.test(config.tag ?? "") ||
    !["desktop", "generic"].includes(config.buildTarget) ||
    !["core", "full"].includes(config.profile) ||
    !Array.isArray(config.targets) ||
    config.targets.length !== supported.size ||
    new Set(config.targets).size !== supported.size ||
    config.targets.some((target) => !supported.has(target)) ||
    index.schemaVersion !== 1 ||
    index.packageName !== sdkName ||
    index.version !== version ||
    index.buildTarget !== config.buildTarget ||
    index.profile !== config.profile ||
    !/^\d+\.\d+\.\d+$/u.test(index.minimumNodeVersion ?? "")
  ) {
    throw new Error("The SDK Release does not match the configured version, profile or targets.");
  }
  for (const target of config.targets) {
    const asset = index.targets?.[target];
    if (
      asset?.asset !== `omp-sdk-${config.buildTarget}-${config.profile}-${target}.tgz` ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256 ?? "") ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(asset.integrity ?? "")
    ) {
      throw new Error(`SDK Release lacks a valid ${target} asset.`);
    }
  }
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

async function calculateBundleHash(releaseConfig, releaseIndex) {
  const files = [
    { absolutePath: path.join(rootDir, ".tool-versions"), relativePath: ".tool-versions" },
    { absolutePath: path.join(rootDir, "package-lock.json"), relativePath: "package-lock.json" },
  ];
  for (const [, directoryName] of workspacePackages) {
    await collectSourceFiles(
      path.join(rootDir, "packages", directoryName),
      `packages/${directoryName}`,
      files,
    );
  }
  await collectSourceFiles(path.join(rootDir, "skills"), "skills", files);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ releaseConfig, releaseIndex })).update("\n");
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath).update("\0");
    hash.update(await readFile(file.absolutePath)).update("\n");
  }
  return hash.digest("hex");
}

const releaseConfig = JSON.parse(await readFile(releaseConfigFile, "utf8"));
const releaseBase = `https://github.com/${releaseConfig.repository}/releases/download/${releaseConfig.tag}`;
const indexResponse = await fetch(`${releaseBase}/omp-sdk-release.json`);
if (!indexResponse.ok) {
  throw new Error(
    `SDK Release ${releaseConfig.tag} is unavailable (${indexResponse.status}). Publish its complete target assets before building Desktop.`,
  );
}
const releaseIndex = await indexResponse.json();
const sourcePackage = JSON.parse(
  await readFile(path.join(resolveOmpSdkBuildConfig().source, "package.json"), "utf8"),
);
validateRelease(releaseConfig, releaseIndex, sourcePackage.version);

// Commit with rename on the output's filesystem, not the system TEMP drive.
const temporary = await mkdtemp(path.join(path.dirname(outputDir), ".omp-remote-backend-"));
try {
  const built = path.join(temporary, "output");
  const packageDir = path.join(built, "packages");
  await mkdir(packageDir, { recursive: true });
  const dependencies = {};
  const commonFiles = {};
  for (const [packageName, directoryName] of workspacePackages) {
    const packed = JSON.parse(
      runNpm(
        ["pack", path.join(rootDir, "packages", directoryName), "--ignore-scripts", "--json", "--pack-destination", packageDir],
        rootDir,
      ),
    );
    if (packed.length !== 1) throw new Error(`Expected one npm archive for ${packageName}`);
    const archiveName = `${directoryName}.tgz`;
    await rename(path.join(packageDir, packed[0].filename), path.join(packageDir, archiveName));
    dependencies[packageName] = `file:packages/${archiveName}`;
    commonFiles[`packages/${archiveName}`] = await sha256(path.join(packageDir, archiveName));
  }
  dependencies[sdkName] = "file:packages/omp-sdk.tgz";
  const deploymentPackage = {
    name: "omp-desktop-remote-backend",
    version: "0.0.0",
    private: true,
    dependencies,
  };
  const packageContents = `${JSON.stringify(deploymentPackage, null, 2)}\n`;
  const sourceHash = await calculateBundleHash(releaseConfig, releaseIndex);
  const targets = {};
  for (const target of releaseConfig.targets) {
    const [platform, arch] = target.split("-");
    const asset = releaseIndex.targets[target];
    const url = `${releaseBase}/${asset.asset}`;
    const work = path.join(temporary, target);
    const archives = path.join(work, "packages");
    await mkdir(archives, { recursive: true });
    for (const relativePath of Object.keys(commonFiles)) {
      await link(path.join(built, relativePath), path.join(work, relativePath));
    }
    console.log(`Preparing remote SDK ${releaseIndex.version} for ${target}`);
    await downloadSdk(url, path.join(archives, "omp-sdk.tgz"), asset);
    await writeFile(path.join(work, "package.json"), packageContents);
    runNpm(
      ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--include=optional", `--os=${platform}`, `--cpu=${arch}`, ...(platform === "linux" ? ["--libc=glibc"] : [])],
      work,
    );
    const targetDirectory = path.join(built, "targets", target);
    await mkdir(targetDirectory, { recursive: true });
    const targetFiles = {};
    for (const name of ["package.json", "package-lock.json"]) {
      await rename(path.join(work, name), path.join(targetDirectory, name));
      targetFiles[name] = await sha256(path.join(targetDirectory, name));
    }
    const sdk = { url, sha256: asset.sha256, size: asset.size };
    const bundleHash = createHash("sha256")
      .update(JSON.stringify({ sourceHash, target, sdk, files: targetFiles, commonFiles }))
      .digest("hex");
    targets[target] = { bundleHash, sdk, files: targetFiles };
  }
  const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  await writeFile(
    path.join(built, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      backendVersion: rootPackage.version,
      nodeVersion: releaseIndex.minimumNodeVersion,
      sdk: {
        packageName: sdkName,
        version: releaseIndex.version,
        repository: releaseConfig.repository,
        releaseTag: releaseConfig.tag,
        buildTarget: releaseIndex.buildTarget,
        profile: releaseIndex.profile,
      },
      files: commonFiles,
      targets,
    }, null, 2)}\n`,
  );
  await rm(outputDir, { recursive: true, force: true });
  await rename(built, outputDir);
  console.log(`Built remote backend ${rootPackage.version} for ${Object.keys(targets).join(", ")} in ${outputDir}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
