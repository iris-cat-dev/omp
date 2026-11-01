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
    if (!existsSync(path.join(sdkResources, "manifest.json"))) {
      throw new Error(
        "The packaged OMP SDK manifest is missing. Rebuild the Desktop SDK distribution.",
      );
    }
    process.env.OMP_DESKTOP_SDK_ROOT = path.resolve(
      sdkResources,
      "node_modules",
      "@oh-my-pi",
      "pi-coding-agent",
    );
    process.env.PASEO_DESKTOP_DISTRIBUTION_IDENTITY = distribution.identity;
    delete process.env.OMP_DESKTOP_BUNDLED_PLUGINS;
    delete process.env.OMP_COMMAND;
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
