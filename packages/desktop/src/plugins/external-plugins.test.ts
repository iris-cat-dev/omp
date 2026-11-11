import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectLocalPluginDirectory, loadExternalLocalPlugin } from "./external-plugins.js";
import { createActivationScope } from "@omp-desktop/plugin/host";
import { IsolatedPluginWorker } from "@omp-desktop/plugin/worker";
import { LocalPluginLogs } from "./logs.js";
import { createDesktopSettingsStore } from "../settings/desktop-settings.js";
import { LocalPluginRecordSchema } from "@omp-desktop/protocol/desktop-local-plugins";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function directoryPlugin(owner: "desktop" | "daemon" = "desktop") {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-local-directory-plugin-")); directories.push(root);
  const directory = path.join(root, "source"); await mkdir(directory);
  await writeFile(path.join(directory, "client.mjs"), "globalThis.__ompInspectionExecuted = true; export default function setup() {};");
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "independent-package", version: "1.2.3", ompDesktop: { apiVersion: 1, id: "directory-demo", owner, entries: { client: "./client.mjs" }, capabilities: ["ui.settings"] } }));
  return { root, directory };
}
describe("local directory plugin discovery", () => {
  it("inspects metadata and compiled entries without executing a factory or requiring a daemon", async () => {
    const { directory } = await directoryPlugin(); const inspected = await inspectLocalPluginDirectory(directory);
    expect(inspected).toMatchObject({ id: "directory-demo", version: "1.2.3", format: "package", directory: await realpath(directory), capabilities: ["ui.settings"], clientEntry: path.join(await realpath(directory), "client.mjs") });
    expect(Reflect.get(globalThis, "__ompInspectionExecuted")).toBeUndefined();
  });
  it("passes the inspected format and canonical service entry to the local worker", async () => {
    const { root, directory } = await directoryPlugin();
    await writeFile(path.join(directory, "service.mjs"), "export default function setup() {}");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "independent-package", version: "1.2.3", ompDesktop: { apiVersion: 1, id: "directory-demo", owner: "desktop", entries: { client: "./client.mjs", service: "./service.mjs" }, capabilities: ["ui.settings"] } }));
    const inspected = await inspectLocalPluginDirectory(directory);
    const record = LocalPluginRecordSchema.parse({ id: "custom-local-worker", packageId: inspected.id, owner: "desktop", version: inspected.version, generation: 4, enabled: true, installed: true, source: { type: "local", identity: inspected.directory }, trusted: true, config: {}, declaredCapabilities: inspected.capabilities, grantedCapabilities: inspected.capabilities, revision: 0, migrationVersion: 1, format: inspected.format, metadata: inspected.metadata });
    const scope = createActivationScope(record.generation);
    const start = vi.spyOn(IsolatedPluginWorker, "start").mockRejectedValue(new Error("Worker launch intercepted"));
    try {
      const definition = await loadExternalLocalPlugin(record, scope, { logs: new LocalPluginLogs(root), hostCall: async () => { throw new Error("Unexpected host call"); }, subscribe: () => () => undefined, fail: vi.fn(), waiting: vi.fn(), clearData: async () => undefined });
      await expect(definition.invoke!("inspect-format", {}, record.generation)).rejects.toThrow("Worker launch intercepted");
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ installation: record, format: "package", signal: scope.signal, serviceEntry: path.join(await realpath(directory), "service.mjs"), mode: "active" }));
    } finally { start.mockRestore(); await scope.dispose(); }
  });
  it("directs daemon-owned packages to their real owner instead of installing them locally", async () => { const { directory } = await directoryPlugin("daemon"); await expect(inspectLocalPluginDirectory(directory)).rejects.toThrow("belongs to a daemon"); });
  it("preserves custom installation IDs and two references to the same source without deleting it", async () => {
    const { root, directory } = await directoryPlugin(), inspected = await inspectLocalPluginDirectory(directory), store = createDesktopSettingsStore({ userDataPath: path.join(root, "profile") });
    for (const id of ["custom-one", "custom-two"]) {
      const current = await store.getPlugins();
      const record = LocalPluginRecordSchema.parse({ id, packageId: inspected.id, owner: "desktop", version: inspected.version, generation: 0, enabled: false, installed: true, source: { type: "local", identity: inspected.directory }, trusted: false, config: {}, declaredCapabilities: inspected.capabilities, grantedCapabilities: [], revision: 0, migrationVersion: 1, format: inspected.format, metadata: inspected.metadata });
      await store.installPlugin(record, current.revision);
    }
    const records = (await store.getPlugins()).installations.filter(({ source }) => source.type === "local");
    expect(records.map(({ id }) => id)).toEqual(["custom-one", "custom-two"]);
    await store.setPluginInstalled(records[0]!.id, false, records[0]!.revision);
    expect(await inspectLocalPluginDirectory(directory)).toMatchObject({ id: inspected.id, version: inspected.version });
    expect((await store.getPlugins()).installations.find(({ id }) => id === records[1]!.id)).toMatchObject({ installed: true, trusted: false, enabled: false });
  });
  it("cannot replace the protected builtin installation identity", async () => {
    const { root, directory } = await directoryPlugin(), inspected = await inspectLocalPluginDirectory(directory), store = createDesktopSettingsStore({ userDataPath: path.join(root, "profile") });
    const current = await store.getPlugins(); const record = LocalPluginRecordSchema.parse({ ...current.installations[0], source: { type: "local", identity: directory }, metadata: inspected.metadata });
    await expect(store.installPlugin(record, current.revision)).rejects.toThrow("cannot replace a builtin");
  });
});
