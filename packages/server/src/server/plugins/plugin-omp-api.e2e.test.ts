import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("plugin handlers create workspaces and agents through their Omp API", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "omp-api-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "omp-api-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "omp-plugin.json"),
    JSON.stringify({ id: "omp-api" }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.tsx"),
    `import { defineRpc, type PluginContext } from "@omp-desktop/plugin";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string(), agentId: z.string() }),
});

export default function contribute(plugin: PluginContext) {
  plugin.handle(create, async ({ path }, { omp }) => {
    const workspace = await omp.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    const agent = await workspace.agents.create({
      config: { provider: "codex/test" },
      prompt: "Created by a plugin handler",
    });
    return { workspaceId: workspace.id, agentId: agent.id };
  });
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory,undefined,{trusted:true})).resolves.toMatchObject({
      id: "omp-api",
      status: "running",
    });

    const generation=(await client.getPluginCatalog()).find(plugin=>plugin.id==="omp-api")!.generation;
    const created = await client.invokePluginRpc("omp-api", "create", {
      path: workspaceDirectory,
    },generation);

    expect(created).toEqual({
      workspaceId: expect.stringMatching(/^wks_/),
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (typeof created !== "object" || created === null) {
      throw new Error("Plugin returned an invalid creation result");
    }
    await client.removePlugin("omp-api");
    const workspaces = await client.fetchWorkspaces();
    const agents = await client.fetchAgents();
    expect(workspaces.entries.map((workspace) => workspace.id)).toContain(
      Reflect.get(created, "workspaceId"),
    );
    expect(agents.entries.map((entry) => entry.agent.id)).toContain(
      Reflect.get(created, "agentId"),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("daemon config reload enables and disables configured plugins without restarting", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "omp-reload-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "omp-reload-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  const factoryMarker = path.join(pluginDirectory, "factory-started.txt");
  await writeFile(
    path.join(pluginDirectory, "omp-plugin.json"),
    JSON.stringify({ id: "reloadable-plugin" }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.tsx"),
    `import {writeFileSync} from "node:fs";
export default function contribute(plugin: unknown) {
  void plugin;
  writeFileSync(${JSON.stringify(factoryMarker)}, "initialized");
  return () => writeFileSync(${JSON.stringify(factoryMarker)}, "stopped");
}`,
  );

  const plugins = {
    "reloadable-plugin": { source: "directory" as const, path: pluginDirectory, enabled: true },
  };
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, pluginsEnabled: false, plugins }, null, 2)}\n`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    pluginsEnabled: false,
    plugins,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const configPath = path.join(daemon.paseoHome, "config.json");

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect({ ...written, pluginsEnabled: config.pluginsEnabled }).toEqual(config);
  }

  try {
    await client.connect();
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);
    // Paused discovery persists inherited trust before compiling the bundle.
    // Wait for both before modifying the same profile file externally.
    await expect.poll(async () => (await client.getPluginCatalog())[0]).toMatchObject({
      trusted: true,
      clientBundle: expect.any(String),
    });
    const approvedSource = JSON.parse(await readFile(configPath, "utf8")).plugins["reloadable-plugin"];
    expect(approvedSource.approval).toEqual({ trusted: true, version: "legacy", capabilities: [] });
    await expect(readFile(factoryMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await expect
      .poll(async () => (await client.listPlugins()).find(({ id }) => id === "reloadable-plugin"))
      .toMatchObject({ enabled: true, status: "running" });
    await expect(readFile(factoryMarker, "utf8")).resolves.toBe("initialized");
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins["reloadable-plugin"]).toEqual(approvedSource);

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await expect
      .poll(async () => (await client.listPlugins()).find(({ id }) => id === "reloadable-plugin"))
      .toMatchObject({ enabled: true, status: "disabled" });
    await expect.poll(() => readFile(factoryMarker, "utf8")).toBe("stopped");
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins["reloadable-plugin"]).toEqual(approvedSource);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("old preinstalled QQ records remain inactive until explicitly installed from a folder", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "omp-qq-retired-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "omp-qq-retired-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  const marker = path.join(pluginDirectory, "executed.txt");
  await writeFile(path.join(pluginDirectory, "omp-plugin.json"), JSON.stringify({ id: "qqbot" }));
  await writeFile(path.join(pluginDirectory, "index.tsx"), `import {writeFileSync} from "node:fs";
import {defineRpc} from "@omp-desktop/plugin";
import {z} from "zod";
const ping=defineRpc({name:"ping",input:z.object({}),output:z.string()});
export default function contribute(plugin) {
  writeFileSync(${JSON.stringify(marker)}, "executed");
  plugin.handle(ping,()=>"folder-installed");
  return ()=>{};
}`);
  const plugins = { qqbot: { source: "directory" as const, path: pluginDirectory, enabled: true, bundled: true } };
  await mkdir(paseoHome, { recursive: true });
  const configPath = path.join(paseoHome, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, pluginsEnabled: true, plugins }));
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false, pluginsEnabled: true, plugins });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.4.0" });
  try {
    await client.connect();
    await expect(client.listPlugins()).resolves.toEqual([]);
    await expect(client.getPluginCatalog()).resolves.toEqual([]);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.enablePlugin("qqbot")).rejects.toThrow(/installed explicitly from a folder/);
    await expect(client.invokePluginRpc("qqbot", "ping", {}, 0)).rejects.toThrow(/installed explicitly from a folder/);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ ...config, pluginsEnabled: true }));
    await client.reloadDaemonConfig();
    await expect(client.listPlugins()).resolves.toEqual([]);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins).toEqual(plugins);
    await expect(client.installDirectoryPlugin(pluginDirectory, "qqbot", { trusted: true })).resolves.toMatchObject({ id: "qqbot", status: "running", bundled: false });
    const [installed] = await client.getPluginCatalog();
    await expect(client.invokePluginRpc("qqbot", "ping", {}, installed!.generation)).resolves.toBe("folder-installed");
    await expect(readFile(marker, "utf8")).resolves.toBe("executed");
    expect(JSON.parse(await readFile(configPath, "utf8")).plugins.qqbot.bundled).toBeUndefined();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("a folder plugin keeps host trust across upgrades of the same package ID", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "omp-plugin-upgrade-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "omp-plugin-upgrade-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = path.join(paseoHomeRoot, "static");
  roots.push(pluginDirectory, paseoHomeRoot);
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir);
  const manifest = (version: string, capabilities: string[], id = "qqbot") =>
    writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({
      version,
      ompDesktop: { apiVersion: 1, id, owner: "daemon", entries: { service: "./service.mjs" }, capabilities },
    }));
  await writeFile(path.join(pluginDirectory, "service.mjs"), `
import { defineRpc } from "@omp-desktop/plugin/server";
import { z } from "zod";
const version = defineRpc({ name: "version", input: z.object({}), output: z.string() });
export default function setup(ctx) { ctx.handle(version, () => ctx.installation.version); }`);
  const capabilities = ["agents.events"];
  const plugins = {
    qqbot: {
      source: "directory" as const,
      path: pluginDirectory,
      enabled: true,
      approval: { trusted: true as const, version: "0.7.2", capabilities },
    },
  };
  const configPath = path.join(paseoHome, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, pluginsEnabled: true, plugins }));
  await manifest("0.7.3", capabilities);

  async function withDaemon(
    sources: typeof plugins,
    run: (client: DaemonClient) => Promise<void>,
  ): Promise<void> {
    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot, staticDir, cleanup: false, pluginsEnabled: true, plugins: sources,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.4.0" });
    try {
      await client.connect();
      await run(client);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  }

  await withDaemon(plugins, async (client) => {
    const entry = async () => (await client.getPluginCatalog())[0];
    await expect.poll(entry).toMatchObject({
      id: "qqbot", version: "0.7.3", trusted: true, status: "running",
    });
    await expect(client.invokePluginRpc("qqbot", "version", {}, (await entry())!.generation))
      .resolves.toBe("0.7.3");

    await manifest("0.7.4", []);
    await expect(client.reloadPlugin("qqbot")).resolves.toMatchObject({
      version: "0.7.4", trusted: true, status: "running", grantedCapabilities: [],
    });

    const expanded = [...capabilities, "agents.prompt"];
    await manifest("0.7.5", expanded);
    await expect(client.reloadPlugin("qqbot")).resolves.toMatchObject({
      version: "0.7.5", trusted: false, effectiveEnabled: false, status: "disabled",
    });
    const blocked = (await entry())!;
    const expected = { sourcePath: blocked.source.path, packageId: blocked.packageId, generation: blocked.generation };
    await expect(client.invokePluginRpc("qqbot", "version", {}, blocked.generation))
      .rejects.toThrow(/execution trust is required/i);
    await expect(client.approvePlugin("qqbot", { trusted: true, version: "0.7.4", capabilities: expanded }, expected))
      .rejects.toThrow(/current package version/);
    await expect(client.approvePlugin("qqbot", { trusted: true, version: "0.7.5", capabilities: expanded }, expected))
      .resolves.toMatchObject({ trusted: true, status: "running" });
  });

  const saved = JSON.parse(await readFile(configPath, "utf8")).plugins as typeof plugins;
  const moved = path.join(paseoHomeRoot, "other-plugin-source");
  await cp(pluginDirectory, moved, { recursive: true });
  await withDaemon({ qqbot: { ...saved.qqbot, path: moved } }, async (client) => {
    await expect.poll(async () => (await client.getPluginCatalog())[0]).toMatchObject({
      id: "qqbot", packageId: "qqbot", version: "0.7.5", trusted: false, status: "disabled",
    });
  });

  await manifest("0.7.5", saved.qqbot.approval.capabilities, "replacement");
  await withDaemon(saved, async (client) => {
    await expect.poll(async () => (await client.getPluginCatalog())[0]).toMatchObject({
      id: "qqbot", packageId: "replacement", trusted: false, status: "disabled",
    });
    await manifest("0.7.6", capabilities);
    await expect(client.reloadPlugin("qqbot")).resolves.toMatchObject({ trusted: true, status: "running" });
    await client.revokePluginTrust("qqbot");
    await manifest("0.7.7", capabilities);
    await expect(client.reloadPlugin("qqbot")).resolves.toMatchObject({
      enabled: true, version: "0.7.7", trusted: false, effectiveEnabled: false, status: "disabled",
    });
  });
}, 60_000);
