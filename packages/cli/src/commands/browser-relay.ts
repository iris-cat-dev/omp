import { spawn } from "node:child_process";
import { once } from "node:events";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, resolveOmpSdkInstallation, resolvePaseoHome } from "@omp-desktop/server";

interface BrowserRelayOptions {
  port: number;
  sdkRoot?: string;
  token?: string;
  dir?: string;
  group?: boolean;
  verbose?: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }
  return port;
}

/** Run the shipped SDK's Node host, never a global omp executable or Bun. */
export async function runBrowserRelay(
  action: "status" | "serve" | "install",
  options: BrowserRelayOptions,
  command: Command,
): Promise<void> {
  const env = { ...process.env };
  const config = loadConfig(resolvePaseoHome(env), { env });
  const settings = config.agentProviderSettings?.omp;
  const installation = await resolveOmpSdkInstallation(
    options.sdkRoot ? { ...settings, ompSdkPath: options.sdkRoot } : settings,
  );
  const args = [installation.workerEntry, "browser-relay", action, "--port", String(options.port)];
  if (options.token) args.push("--token", options.token);
  if (options.dir) args.push("--dir", options.dir);
  if (options.group === false) args.push("--no-group");
  if (options.verbose) args.push("--verbose");
  if (
    action === "status" &&
    (command.optsWithGlobals().json || command.optsWithGlobals().format === "json")
  ) {
    args.push("--json");
  }
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: {
      ...env,
      ...settings?.env,
      ELECTRON_RUN_AS_NODE: "1",
      OMP_DESKTOP_SDK_ROOT: installation.root,
    },
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);
  try {
    const [exitCode, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    const code = exitCode ?? (signal === "SIGINT" ? 130 : 1);
    if (code !== 0) process.exitCode = code;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTerminate);
  }
}

export function createBrowserRelayCommand(): Command {
  const command = new Command("browser-relay").description(
    "Inspect or run the embedded Browser Relay for your existing Chrome profile",
  );
  for (const action of ["status", "serve", "install"] as const) {
    let description = "Write the companion extension and show setup instructions";
    if (action === "status")
      description = "Inspect relay identity, extension connection, and protocol compatibility";
    else if (action === "serve")
      description = "Serve on loopback; leave any existing relay or other listener unchanged";
    const subcommand = command
      .command(action)
      .description(description)
      .option("-p, --port <port>", "Loopback relay port", parsePort, 9224)
      .option("--sdk-root <path>", "Explicit built Node SDK package root");
    if (action === "status") subcommand.option("--json", "Output relay status as JSON");
    if (action === "serve")
      subcommand
        .option("--token <token>", "Require an extension connection token")
        .option("--no-group", "Do not gather controlled tabs into an omp tab group")
        .option("--verbose", "Log relay traffic summaries to stderr");
    if (action === "install") subcommand.option("--dir <path>", "Extension install directory");
    subcommand.action((options: BrowserRelayOptions, cmd: Command) =>
      runBrowserRelay(action, options, cmd),
    );
  }
  return command;
}
