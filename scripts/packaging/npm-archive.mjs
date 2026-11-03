import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function resolvePackage(from, name, subpath = "") {
  const entry = createRequire(from).resolve(`${name}${subpath}`);
  let root = path.dirname(realpathSync(entry));
  for (;;) {
    try {
      const metadata = path.join(root, "package.json");
      const data = readJson(metadata);
      if (data.name === name) return { root, metadata, data };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(root);
    if (parent === root) throw new Error(`Cannot locate package ${name} from ${from}`);
    root = parent;
  }
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
  return result.stdout;
}

// Fetch registry archives without lifecycle scripts or target-host native rebuilds.
export function unpackNpmPackage(name, version, directory, lockEntry) {
  mkdirSync(directory, { recursive: true });
  const args = [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    directory,
    `${name}@${version}`,
  ];
  const npmCli = process.env.npm_execpath;
  const output = runCommand(
    npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    npmCli ? [npmCli, ...args] : args,
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      shell: !npmCli && process.platform === "win32",
    },
  );
  const records = JSON.parse(output);
  if (records.length !== 1 || records[0].name !== name || records[0].version !== version) {
    throw new Error(`npm pack did not return ${name}@${version}.`);
  }
  const filename = records[0].filename;
  if (path.basename(filename) !== filename)
    throw new Error(`Unsafe npm archive filename: ${filename}`);
  const archive = path.join(directory, filename);
  if (lockEntry?.integrity) {
    const bytes = readFileSync(archive);
    const matches = lockEntry.integrity.split(/\s+/).some((record) => {
      const [algorithm, digest] = record.split("-", 2);
      return (
        ["sha512", "sha384", "sha256", "sha1"].includes(algorithm) &&
        createHash(algorithm).update(bytes).digest("base64") === digest
      );
    });
    if (!matches)
      throw new Error(`npm archive integrity does not match the lockfile: ${name}@${version}`);
  }
  const root = path.join(directory, "package");
  mkdirSync(root);
  runCommand(process.platform === "win32" ? "tar.exe" : "tar", [
    "-xzf",
    archive,
    "-C",
    root,
    "--strip-components=1",
  ]);
  const data = readJson(path.join(root, "package.json"));
  if (data.name !== name || data.version !== version)
    throw new Error(`Archive package identity mismatch: ${name}@${version}`);
  return { root, metadata: path.join(root, "package.json"), data };
}
