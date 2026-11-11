import { Command } from "commander";
import type { PluginListItem, PluginLogEntry } from "@omp-desktop/protocol/messages";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, addJsonOption } from "../../utils/command-options.js";
import { scaffoldPluginDirectory, type PluginScaffold } from "./scaffold.js";
import { withPluginLogsClient, withPluginManagementClient } from "./shared.js";

interface PluginOptions extends CommandOptions {
  host?: string;
  id?: string;
  trust?: boolean;
  disabled?: boolean;
}

const pluginSchema: OutputSchema<PluginListItem> = {
  idField: "id",
  columns: [
    { header: "PLUGIN", field: "id", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ENABLED", field: (plugin) => (plugin.enabled ? "yes" : "no"), width: 8 },
    { header: "DIRECTORY", field: "path", width: 40 },
    { header: "ERROR", field: (plugin) => plugin.error ?? "", width: 40 },
  ],
};

const scaffoldSchema: OutputSchema<PluginScaffold> = {
  idField: "id",
  columns: [
    { header: "PLUGIN", field: "id", width: 20 },
    { header: "DIRECTORY", field: "directory", width: 60 },
  ],
};

const pluginLogsSchema: OutputSchema<PluginLogEntry> = {
  idField: (entry) => String(entry.sequence),
  columns: [
    { header: "TIME", field: "timestamp", width: 24 },
    { header: "STREAM", field: "stream", width: 8 },
    { header: "MESSAGE", field: "message", width: 80 },
  ],
};

export async function runPluginInitCommand(
  directory: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginScaffold>> {
  return {
    type: "single",
    data: await scaffoldPluginDirectory(directory, options.id),
    schema: scaffoldSchema,
  };
}

export async function runPluginListCommand(
  options: PluginOptions,
  _command: Command,
): Promise<ListResult<PluginListItem>> {
  const data = await withPluginManagementClient(options.host, (client) => client.listPlugins());
  return { type: "list", data, schema: pluginSchema };
}

export async function runPluginLogsCommand(
  pluginId: string,
  options: PluginOptions,
  _command: Command,
): Promise<ListResult<PluginLogEntry>> {
  const data = await withPluginLogsClient(options.host, (client) => client.getPluginLogs(pluginId));
  return { type: "list", data, schema: pluginLogsSchema };
}

async function install(
  directory: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginListItem>> {
  if(options.trust!==true)throw new Error("Plugin code runs with your user privileges; pass --trust to approve this source/version and declared capabilities");
  const data = await withPluginManagementClient(options.host, (client) =>
    client.installDirectoryPlugin(directory, options.id, {trusted:true,enabled:options.disabled!==true}),
  );
  return { type: "single", data, schema: pluginSchema };
}

async function act(
  action: "reload" | "enable" | "disable",
  pluginId: string,
  options: PluginOptions,
): Promise<SingleResult<PluginListItem>> {
  const data = await withPluginManagementClient(options.host, (client) =>
    client[`${action}Plugin`](pluginId),
  );
  return { type: "single", data, schema: pluginSchema };
}

async function remove(
  pluginId: string,
  options: PluginOptions,
  _command: Command,
): Promise<SingleResult<PluginListItem>> {
  const data = await withPluginManagementClient(options.host, async (client) => {
    const current = (await client.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (!current) throw new Error(`Plugin is not configured: ${pluginId}`);
    await client.removePlugin(pluginId);
    return { ...current, enabled: false, status: "disabled" as const };
  });
  return { type: "single", data, schema: pluginSchema };
}

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage trusted local plugins");
  addJsonOption(
    plugin
      .command("init")
      .description("Create a typecheckable local plugin")
      .argument("<directory>")
      .option("--id <id>", "Manifest plugin ID (defaults to the directory name)"),
  ).action(withOutput(runPluginInitCommand));
  addJsonAndDaemonHostOptions(plugin.command("ls").description("List configured plugins")).action(
    withOutput(runPluginListCommand),
  );
  addJsonAndDaemonHostOptions(
    plugin.command("logs").description("Show recent plugin output").argument("<id>"),
  ).action(withOutput(runPluginLogsCommand));
  addJsonAndDaemonHostOptions(
    plugin
      .command("install")
      .description("Install a local plugin directory")
      .argument("<directory>", "Host filesystem directory")
      .option("--id <id>", "Runtime installation ID (defaults to manifest/package id)")
      .requiredOption("--trust", "Trust executable code from this source/version and approve declared capabilities")
      .option("--disabled", "Install without activating this installation"),
  ).action(withOutput(install));
  for (const action of ["reload", "enable", "disable"] as const) {
    addJsonAndDaemonHostOptions(
      plugin.command(action).description(`${action} a local plugin`).argument("<id>"),
    ).action(
      withOutput((id: string, options: PluginOptions, _command: Command) =>
        act(action, id, options),
      ),
    );
  }
  addJsonAndDaemonHostOptions(
    plugin.command("remove").description("Remove plugin configuration").argument("<id>"),
  ).action(withOutput(remove));
  addJsonAndDaemonHostOptions(plugin.command("inspect").description("Inspect metadata without executing plugin code").argument("<directory>")).action(withOutput(async(directory:string,options:PluginOptions,_command:Command)=>{
    const data=await withPluginManagementClient(options.host,client=>client.inspectDirectoryPlugin(directory));
    return {type:"single" as const,data,schema:{idField:"id" as const,columns:[{header:"PLUGIN",field:"id" as const},{header:"VERSION",field:"version" as const}]}};
  }));
  addJsonAndDaemonHostOptions(plugin.command("approve").description("Approve the installed source/version and capabilities").argument("<id>").requiredOption("--trust","Approve executable plugin code")).action(withOutput(async(id:string,options:PluginOptions,_command:Command)=>{
    const data=await withPluginManagementClient(options.host,async client=>{const entry=(await client.getPluginCatalog()).find(entry=>entry.id===id);if(!entry)throw new Error(`Plugin is not configured: ${id}`);return client.approvePlugin(id,{trusted:true,version:entry.version,capabilities:entry.declaredCapabilities},{sourcePath:entry.source.path,packageId:entry.packageId,generation:entry.generation});});
    return {type:"single" as const,data:{...data,path:data.source.path},schema:pluginSchema};
  }));
  addJsonAndDaemonHostOptions(plugin.command("revoke-trust").description("Revoke execution trust while retaining desired enabled state").argument("<id>")).action(withOutput(async(id:string,options:PluginOptions,_command:Command)=>{
    const data=await withPluginManagementClient(options.host,client=>client.revokePluginTrust(id));return {type:"single" as const,data:{...data,path:data.source.path},schema:pluginSchema};
  }));
  addJsonAndDaemonHostOptions(plugin.command("allow").description("Explicitly allow daemon Desktop plugins to execute (does not affect native/local plugins)")).action(withOutput(async(options:PluginOptions,_command:Command): Promise<ListResult<PluginListItem>>=>{
    const data=await withPluginManagementClient(options.host,async client=>{await client.patchDaemonConfig({pluginsEnabled:true});return client.listPlugins();});return {type:"list" as const,data,schema:pluginSchema};
  }));
  return plugin;
}
