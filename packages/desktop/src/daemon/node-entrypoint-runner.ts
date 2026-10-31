import { existsSync } from "node:fs";
import path from "node:path";
import { readPackagedDesktopDistribution } from "../packaged-distribution.js";
import { pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }

  if (process.env.ELECTRON_RUN_AS_NODE === "1" && process.env.PASEO_DESKTOP_MANAGED === "1") {
    const appRoot = path.join(__dirname, "..", "..");
    const distribution = readPackagedDesktopDistribution(appRoot);
    const sdkResources = path.join(path.dirname(appRoot), "omp-sdk");
    if (existsSync(path.join(sdkResources, "manifest.json"))) {
      process.env.OMP_DESKTOP_SDK_ROOT = path.resolve(
        sdkResources,
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
      );
    } else {
      delete process.env.OMP_DESKTOP_SDK_ROOT;
    }
    process.env.PASEO_DESKTOP_DISTRIBUTION_IDENTITY = distribution.identity;
    if (distribution.bundledPluginsPath) {
      process.env.OMP_DESKTOP_BUNDLED_PLUGINS = distribution.bundledPluginsPath;
    } else {
      delete process.env.OMP_DESKTOP_BUNDLED_PLUGINS;
    }
    if (distribution.bundledOmpPath) {
      process.env.OMP_COMMAND = distribution.bundledOmpPath;
      const pathKey = Object.hasOwn(process.env, "Path") ? "Path" : "PATH";
      const binDir = path.dirname(distribution.bundledOmpPath);
      const previousPath = process.env[pathKey];
      if (previousPath !== binDir && !previousPath?.startsWith(`${binDir}${path.delimiter}`)) {
        process.env[pathKey] = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;
      }
    }
  }

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
