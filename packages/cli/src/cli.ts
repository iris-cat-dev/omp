import { Command, Option } from "commander";
import { createAgentCommand } from "./commands/agent/index.js";
import { createDaemonCommand } from "./commands/daemon/index.js";
import { createPermitCommand } from "./commands/permit/index.js";
import { createProviderCommand } from "./commands/provider/index.js";
import { createProjectCommand } from "./commands/project/index.js";
import { createScheduleCommand } from "./commands/schedule/index.js";
import { createScriptCommand } from "./commands/script/index.js";
import { createTerminalCommand } from "./commands/terminal/index.js";
import { createWorktreeCommand } from "./commands/worktree/index.js";
import { createWorkspaceCommand } from "./commands/workspace/index.js";
import { createHeartbeatCommand } from "./commands/heartbeat/index.js";
import { startCommand as daemonStartCommand } from "./commands/daemon/start.js";
import { runStatusCommand as runDaemonStatusCommand } from "./commands/daemon/status.js";
import { runRestartCommand as runDaemonRestartCommand } from "./commands/daemon/restart.js";
import { runDaemonReloadCommand } from "./commands/daemon/reload.js";
import { pairCommand } from "./commands/daemon/pair.js";
import { addLsOptions, runLsCommand } from "./commands/agent/ls.js";
import { addRunOptions, runRunCommand } from "./commands/agent/run.js";
import { addLogsOptions, runLogsCommand } from "./commands/agent/logs.js";
import { addDeleteOptions, runDeleteCommand } from "./commands/agent/delete.js";
import { addStopOptions, runStopCommand } from "./commands/agent/stop.js";
import { addSendOptions, runSendCommand } from "./commands/agent/send.js";
import { addInspectOptions, runInspectCommand } from "./commands/agent/inspect.js";
import { addWaitOptions, runWaitCommand } from "./commands/agent/wait.js";
import { addArchiveOptions, runArchiveCommand } from "./commands/agent/archive.js";
import { addAttachOptions, runAttachCommand } from "./commands/agent/attach.js";
import { addImportOptions, runImportCommand } from "./commands/agent/import.js";
import { withOutput } from "./output/index.js";
import { runCloneCommand } from "./commands/clone.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  addJsonOption,
} from "./utils/command-options.js";
import { resolveCliVersion } from "./version.js";

const VERSION = resolveCliVersion();

function resolveHostnamesOption(hostnames: unknown, allowedHosts: unknown): string | undefined {
  if (typeof hostnames === "string") return hostnames;
  if (typeof allowedHosts === "string") return allowedHosts;
  return undefined;
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("omp-desktop")
    .description("Control local Oh My Pi coding agents")
    .version(VERSION, "-v, --version", "output the version number")
    // Global output options
    .option("-o, --format <format>", "output format: table, json, yaml", "table")
    .option("--json", "output in JSON format (alias for --format json)")
    .option("-q, --quiet", "minimal output (IDs only)")
    .option("--no-headers", "omit table headers")
    .option("--no-color", "disable colored output");

  // Primary agent commands (top-level)
  addJsonAndDaemonHostOptions(addLsOptions(program.command("ls"))).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(addRunOptions(program.command("run"))).action(
    withOutput(runRunCommand),
  );

  addJsonAndDaemonHostOptions(addImportOptions(program.command("import"))).action(
    withOutput(runImportCommand),
  );

  addJsonAndDaemonHostOptions(
    program
      .command("clone")
      .description("Clone a GitHub repo and register it as an OMP Desktop workspace")
      .argument("<repo>", "GitHub repo in owner/repo format or a full git remote URL")
      .requiredOption("--dir <path>", "Parent directory to clone into (for example: ~/workspace)"),
  )
    .addOption(
      new Option("--protocol <protocol>", "Protocol for owner/repo shorthand repositories").choices(
        ["https", "ssh"],
      ),
    )
    .action(withOutput(runCloneCommand));

  addDaemonHostOption(addAttachOptions(program.command("attach"))).action(runAttachCommand);

  addDaemonHostOption(addLogsOptions(program.command("logs"))).action(runLogsCommand);

  addJsonAndDaemonHostOptions(addStopOptions(program.command("stop"))).action(
    withOutput(runStopCommand),
  );

  addJsonAndDaemonHostOptions(addDeleteOptions(program.command("delete"))).action(
    withOutput(runDeleteCommand),
  );

  addJsonAndDaemonHostOptions(addSendOptions(program.command("send"))).action(
    withOutput(runSendCommand),
  );

  addJsonAndDaemonHostOptions(addInspectOptions(program.command("inspect"))).action(
    withOutput(runInspectCommand),
  );

  addJsonAndDaemonHostOptions(addWaitOptions(program.command("wait"))).action(
    withOutput(runWaitCommand),
  );

  addJsonAndDaemonHostOptions(addArchiveOptions(program.command("archive"))).action(
    withOutput(runArchiveCommand),
  );

  // Top-level local daemon shortcuts
  program.addCommand(daemonStartCommand());
  program.addCommand(pairCommand());

  addJsonOption(
    program
      .command("status")
      .description('Show local daemon status (alias for "omp-desktop daemon status")'),
  )
    .option("--home <path>", "OMP Desktop home directory (default: ~/.omp-desktop)")
    .action(withOutput(runDaemonStatusCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("reload")
      .description('Reload daemon config (alias for "omp-desktop daemon reload")'),
  ).action(withOutput(runDaemonReloadCommand));

  addJsonOption(
    program
      .command("restart")
      .description('Restart local daemon (alias for "omp-desktop daemon restart")'),
  )
    .option("--home <path>", "OMP Desktop home directory (default: ~/.omp-desktop)")
    .option("--timeout <seconds>", "Wait timeout before force step (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .option(
      "--listen <listen>",
      "Listen target for restarted daemon (host:port, port, or unix socket)",
    )
    .option("--port <port>", "Port for restarted daemon listen target")
    .option("--relay", "Enable outbound encrypted relay access on restarted daemon")
    .option("--no-relay", "Disable outbound relay access on restarted daemon")
    .option("--relay-use-tls", "Use TLS for the outbound relay connection")
    .option(
      "--no-relay-use-tls",
      "Disable TLS for the outbound relay connection (E2EE remains enabled)",
    )
    .option("--no-mcp", "Disable Agent MCP on restarted daemon")
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [(typeof args)[number], Command];
        return runDaemonRestartCommand(
          {
            ...options,
            hostnames: resolveHostnamesOption(options.hostnames, options.allowedHosts),
          },
          command,
        );
      }),
    );

  // Advanced agent commands (less common operations)
  program.addCommand(createAgentCommand());

  // Daemon commands
  program.addCommand(createDaemonCommand());

  // Chat commands

  // Terminal commands
  program.addCommand(createTerminalCommand());

  // Workspace script commands
  program.addCommand(createScriptCommand());

  // Schedule commands
  program.addCommand(createScheduleCommand());
  program.addCommand(createHeartbeatCommand());

  // Permission commands
  program.addCommand(createPermitCommand());

  // Provider commands
  program.addCommand(createProviderCommand());

  // Workspace commands
  program.addCommand(createProjectCommand());
  program.addCommand(createWorkspaceCommand());
  // COMPAT(worktreeCli): legacy command alias added before workspace was the product unit.
  // Added in v0.2.0; remove after 2027-01-17.
  program.addCommand(createWorktreeCommand(), { hidden: true });

  return program;
}
