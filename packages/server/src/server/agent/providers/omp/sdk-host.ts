import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveOmpCodexCatalogPreloadPath } from "./cli-runtime.js";
import { resolveOmpSdkInstallation } from "./sdk-installation.js";
import {
  OMP_SDK_LAUNCH_ENV,
  OmpSdkHostLaunchSchema,
  type OmpSdkHostLaunch,
} from "./sdk-host-protocol.js";

const hostModule = z.object({
  startNodeRpcHost: z.custom<(options: OmpSdkHostLaunch) => Promise<never>>(
    (value) => typeof value === "function",
    "The selected SDK does not export startNodeRpcHost; rebuild its Node artifacts",
  ),
});
const daemonHostModule = z.object({
  stopNodeRpcDaemon: z.custom<
    (input: { cwd: string; name: string; id?: string }) => Promise<void>
  >(
    (value) => typeof value === "function",
    "The selected SDK does not export stopNodeRpcDaemon; rebuild its Node artifacts",
  ),
});
const pluginHostModule = z.object({
  runNodePluginCommand: z.custom<(args: readonly string[]) => Promise<void>>(
    (value) => typeof value === "function",
    "The selected SDK does not export runNodePluginCommand; rebuild its Node artifacts",
  ),
});

/** One child owns either an SDK agent session or a one-shot native management command. */
export async function runOmpSdkHost(): Promise<void> {
  const installation = await resolveOmpSdkInstallation();
  if (process.argv[2] === "--version" && process.argv.length === 3) {
    process.stdout.write(`omp/${installation.version}\n`);
    return;
  }
  if (process.argv[2] === "--stop-daemon" && process.argv.length === 4) {
    const sdk = daemonHostModule.parse(
      createRequire(import.meta.url)(installation.rpcEntry),
    );
    await sdk.stopNodeRpcDaemon({
      cwd: process.cwd(),
      name: process.argv[3]!,
      id: process.env.OMP_DESKTOP_STOP_DAEMON_ID,
    });
    return;
  }
  if (process.argv[2] === "plugin") {
    const entry = path.join(installation.root, "dist", "node", "plugins.mjs");
    const sdk = pluginHostModule.parse(createRequire(import.meta.url)(entry));
    await sdk.runNodePluginCommand(process.argv.slice(2));
    return;
  }
  if (process.argv.length !== 2)
    throw new Error(
      "The SDK host accepts its private launch configuration through the environment",
    );
  const launch = OmpSdkHostLaunchSchema.parse(
    JSON.parse(process.env[OMP_SDK_LAUNCH_ENV] ?? "null"),
  );
  if (!path.isAbsolute(launch.cwd))
    throw new Error("OMP SDK cwd must be absolute");
  process.chdir(launch.cwd);
  // Catalog policy must wrap fetch and database access before SDK initialization.
  const load = createRequire(import.meta.url);
  load(resolveOmpCodexCatalogPreloadPath());
  const sdk = hostModule.parse(load(installation.rpcEntry));
  await sdk.startNodeRpcHost(launch);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  void runOmpSdkHost().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      () => process.exit(1),
    );
  });
}
