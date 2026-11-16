import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalPluginRecordSchema } from "@omp-desktop/protocol/desktop-local-plugins";
import { createDesktopSettingsStore } from "../settings/desktop-settings.js";
import { inspectLocalPluginDirectory, loadExternalLocalPlugin } from "./external-plugins.js";
import { LocalPluginRuntime } from "./local-runtime.js";
import { LocalPluginLogs } from "./logs.js";
import { clearPluginNativeData, getPluginNativeTrayItems, handlePluginNativeDocument, onPluginNativeTrayItemsChanged } from "./native-entry.js";
const require = createRequire(import.meta.url);
const roots: string[] = [], runtimes: LocalPluginRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
interface NativeState { url: string; directory: string; value: string; generation: number }
async function fixture(options: { enabled?: boolean; trusted?: boolean; approved?: boolean; service?: boolean; failSetup?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-native-entry-")); roots.push(root);
  const directory = path.join(root, "package"), userDataPath = path.join(root, "profile"), trace = path.join(root, "trace"), failSave = path.join(root, "fail-save");
  await mkdir(path.join(directory, "node_modules"), { recursive: true });
  await symlink(path.dirname(require.resolve("zod/package.json")), path.join(directory, "node_modules/zod"), "dir");
  await writeFile(path.join(directory, "value.cjs"), "module.exports='first';");
  const externalModule = path.join(root, "shared.cjs");
  await writeFile(externalModule, "module.exports={identity:Math.random()};");
  const sharedModule = require(externalModule);
  await writeFile(path.join(directory, "native.cjs"), `
const fs=require('node:fs');const path=require('node:path');const {z}=require('zod');
require(${JSON.stringify(externalModule)});const value=require('./value.cjs');
const trace=${JSON.stringify(trace)},failSave=${JSON.stringify(failSave)};
fs.appendFileSync(trace,'loaded\\n');
exports.default=async ctx=>{
 const directory=ctx.desktop.dataDirectory;
 if(!fs.existsSync(directory)) fs.mkdirSync(directory);
 const url=ctx.desktop.registerDocument('dashboard','<h1>native document</h1>');
 ctx.desktop.addTrayItem({id:'open',label:'Native fixture',onSelect(){fs.appendFileSync(trace,'clicked\\n');}});
 ctx.own(()=>{fs.appendFileSync(trace,'owned-cleanup\\n');});
 ctx.desktop.beforeStop(async()=>{
  fs.appendFileSync(trace,'prepare:'+ctx.signal.aborted+'\\n');
  if(fs.existsSync(failSave)) throw new Error('save failed');
  await fs.promises.writeFile(path.join(directory,'preferences.json'),JSON.stringify({retained:true}));
 });
 ctx.handle({name:'native.state',input:z.null(),output:z.object({url:z.string(),directory:z.string(),value:z.string(),generation:z.number()})},()=>({url,directory,value,generation:ctx.installation.generation}));
 ctx.handle({name:'native.echo',input:z.number(),output:z.number()},value=>value+1);
 ${options.failSetup ? "throw new Error('native setup failed');" : ""}
 return async()=>{await fs.promises.appendFile(trace,'returned-cleanup\\n');};
};`);
  if (options.service) {
    await writeFile(path.join(directory, "client.mjs"), "export default ()=>{};");
    await writeFile(path.join(directory, "service.mjs"), "import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';export default ctx=>{ctx.handle(defineRpc({name:'worker.value',input:z.null(),output:z.string()}),()=> 'worker');};");
  }
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.0.0", ompDesktop: { apiVersion: 1, id: "native-fixture", owner: "desktop", entries: { native: "./native.cjs", ...(options.service ? { client: "./client.mjs", service: "./service.mjs" } : {}) }, capabilities: ["native.main"] } }));
  const inspected = await inspectLocalPluginDirectory(directory), store = createDesktopSettingsStore({ userDataPath });
  const record = LocalPluginRecordSchema.parse({ id: "native-fixture", packageId: inspected.id, owner: "desktop", version: inspected.version, generation: 0, enabled: options.enabled ?? true, installed: true, source: { type: "local", identity: inspected.directory }, trusted: options.trusted ?? true, config: {}, declaredCapabilities: inspected.capabilities, grantedCapabilities: options.approved === false ? [] : inspected.capabilities, revision: 0, migrationVersion: 1, format: inspected.format, metadata: inspected.metadata });
  await store.installPlugin(record, (await store.getPlugins()).revision);
  const errors = vi.fn();
  const runtime = new LocalPluginRuntime(store, () => ({ invoke: async () => { throw new Error("Unexpected native invocation"); }, subscribe: () => () => undefined }), (current, scope) => loadExternalLocalPlugin(current, scope, {
    logs: new LocalPluginLogs(userDataPath), hostCall: async () => { throw new Error("Unexpected worker host call"); }, subscribe: () => () => undefined,
    fail: (id, generation, error) => runtime.fail(id, generation, error), waiting: (id, generation, reason) => runtime.waiting(id, generation, reason), clearData: (id) => clearPluginNativeData(userDataPath, id),
    native: { userDataPath, launchAtLogin: { get: () => ({ enabled: false, supported: true }), set: (enabled) => ({ enabled, supported: true }) }, assertAuthorized: (current, scope) => runtime.assertServiceAuthorized(current.id, scope.generation), onError: errors },
  }), errors);
  runtimes.push(runtime);
  await runtime.initialize(); await runtime.whenIdle();
  const current = () => runtime.getSnapshot().installations.find(({ id }) => id === record.id)!;
  const state = () => runtime.invoke(record.id, current().generation, "native.state", null) as Promise<NativeState>;
  const ready = async () => { runtime.startupReady(); await runtime.whenIdle(); };
  const patch = async (patch: { enabled?: boolean; config?: Record<string, unknown> }) => { const listed = current(); await store.patchPlugin({ installationId: listed.id, expectedRevision: listed.revision, patch }); await runtime.whenIdle(); };
  return { root, directory, userDataPath, trace, failSave, runtime, store, current, state, ready, patch, errors, externalModule, sharedModule };
}
function documentPath(url: string): string { return decodeURIComponent(new URL(url).pathname); }
describe("approved folder native entries", () => {
  it("does not evaluate native modules before readiness, approval or enablement", async () => {
    for (const options of [{ enabled: false }, { trusted: false }, { approved: false }]) {
      const test = await fixture(options); await test.ready();
      await expect(readFile(test.trace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(test.state()).rejects.toThrow();
    }
    const test = await fixture(); await expect(readFile(test.trace)).rejects.toMatchObject({ code: "ENOENT" });
    await test.ready(); expect((await readFile(test.trace, "utf8")).split("loaded")).toHaveLength(2);
  });
  it("revokes an active native generation when native.main approval is withdrawn", async () => {
    const test = await fixture(); await test.ready(); const first = await test.state(), original = test.current();
    await test.store.patchPlugin({ installationId: original.id, expectedRevision: original.revision, patch: { grantedCapabilities: [] } }); await test.runtime.whenIdle();
    expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined(); expect(getPluginNativeTrayItems()).toEqual([]);
    await expect(test.state()).rejects.toThrow();
    expect(await readFile(test.trace, "utf8")).toContain("returned-cleanup\nowned-cleanup");
    const waiting = test.current(); await test.store.patchPlugin({ installationId: waiting.id, expectedRevision: waiting.revision, patch: { grantedCapabilities: ["native.main"] } }); await test.runtime.whenIdle();
    expect((await test.state()).generation).toBeGreaterThan(first.generation);
  });
  it("restores an enabled native entry after a suspended mutation loses its revision race", async () => {
    const test = await fixture(); await test.ready(); const first = await test.state(), original = test.current();
    await test.runtime.suspend(original.id);
    try {
      await test.store.patchPlugin({ installationId: original.id, expectedRevision: original.revision, patch: { config: { concurrent: "retained" } } });
      await expect(test.store.patchPlugin({ installationId: original.id, expectedRevision: original.revision, patch: { enabled: false } })).rejects.toThrow();
    } finally { await test.runtime.resume(original.id); }
    expect(test.current()).toMatchObject({ enabled: true, status: "active", config: { concurrent: "retained" } });
    const resumed = await test.state(); expect(resumed.url).not.toBe(first.url); expect(resumed.generation).toBeGreaterThan(first.generation);
    expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined(); expect(handlePluginNativeDocument(documentPath(resumed.url))).toBeDefined();
    expect(JSON.parse(await readFile(path.join(resumed.directory, "preferences.json"), "utf8"))).toEqual({ retained: true });
  });
  it("awaits native cleanup when an active installation is removed while retaining saved preferences", async () => {
    const test = await fixture(); await test.ready(); const first = await test.state(), original = test.current();
    await test.store.setPluginInstalled(original.id, false, original.revision); await test.runtime.whenIdle();
    expect(test.current().status).toBe("removed"); expect(getPluginNativeTrayItems()).toEqual([]);
    expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined();
    expect(await readFile(test.trace, "utf8")).toContain("prepare:false\nreturned-cleanup\nowned-cleanup");
    expect(JSON.parse(await readFile(path.join(first.directory, "preferences.json"), "utf8"))).toEqual({ retained: true });
  });
  it("dispatches validated native RPC alongside the isolated worker and client", async () => {
    const test = await fixture({ service: true }); await test.ready();
    expect(test.current().clientBundle).toBeTruthy();
    expect(await test.runtime.invoke(test.current().id, test.current().generation, "native.echo", 3)).toBe(4);
    await expect(test.runtime.invoke(test.current().id, test.current().generation, "native.echo", "bad")).rejects.toThrow();
    expect(await test.runtime.invoke(test.current().id, test.current().generation, "worker.value", null)).toBe("worker");
  });
  it("awaits cleanup, revokes documents and stale tray callbacks, and reloads only package-owned modules", async () => {
    const changed = vi.fn(), unsubscribe = onPluginNativeTrayItemsChanged(changed);
    try {
      const test = await fixture(); await test.ready(); const first = await test.state();
      expect(await handlePluginNativeDocument(documentPath(first.url))!.text()).toContain("native document");
      const oldTray = getPluginNativeTrayItems()[0]!; oldTray.click();
      await writeFile(path.join(test.directory, "value.cjs"), "module.exports='second';");
      await test.runtime.reload(test.current().id);
      const second = await test.state(); expect(second.value).toBe("second"); expect(second.url).not.toBe(first.url);
      expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined();
      expect(require(test.externalModule)).toBe(test.sharedModule);
      const trace = await readFile(test.trace, "utf8"); expect(trace).toContain("prepare:false\nreturned-cleanup\nowned-cleanup\nloaded");
      oldTray.click(); expect(await readFile(test.trace, "utf8")).toBe(trace);
      await test.patch({ enabled: false });
      expect(handlePluginNativeDocument(documentPath(second.url))).toBeUndefined(); expect(getPluginNativeTrayItems()).toEqual([]);
      expect(JSON.parse(await readFile(path.join(second.directory, "preferences.json"), "utf8"))).toEqual({ retained: true });
      expect(changed).toHaveBeenCalled();
      await test.patch({ enabled: true }); expect((await test.state()).directory).toBe(second.directory);
    } finally { unsubscribe(); }
  });
  it("preserves a current native generation when preparation fails and permits save retry and quit retry", async () => {
    const test = await fixture(); await test.ready(); const first = await test.state();
    await writeFile(test.failSave, "fail");
    await expect(test.runtime.prepareToStop(test.current().id)).rejects.toThrow("save failed");
    await expect(test.runtime.reload(test.current().id)).rejects.toThrow("save failed");
    await expect(test.runtime.dispose()).rejects.toThrow("save failed");
    expect((await test.state()).url).toBe(first.url); expect(handlePluginNativeDocument(documentPath(first.url))).toBeDefined(); expect(getPluginNativeTrayItems()).toHaveLength(1);
    await test.patch({ config: { savedWhileRetrying: true } }); expect(test.current().config.savedWhileRetrying).toBe(true);
    await rm(test.failSave); await test.runtime.dispose();
    expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined(); expect(getPluginNativeTrayItems()).toEqual([]);
    expect(await readFile(test.trace, "utf8")).toContain("returned-cleanup\nowned-cleanup");
  });
  it("cleans resources after setup failure and removes only its own native data", async () => {
    const failed = await fixture({ failSetup: true }); await failed.ready();
    expect(failed.current().status).toBe("failed"); expect(failed.errors).toHaveBeenCalledWith("native-fixture", "native setup failed"); expect(getPluginNativeTrayItems()).toEqual([]);
    expect(await readFile(failed.trace, "utf8")).toContain("owned-cleanup");
    const test = await fixture(); await test.ready(); const first = await test.state();
    const marker = path.join(path.dirname(first.directory), "migration-decision.json"), other = path.join(test.userDataPath, "desktop-plugins/data/other/native"), legacy = path.join(test.userDataPath, "local-monitor");
    await writeFile(marker, "decided"); await mkdir(other, { recursive: true }); await mkdir(legacy); await writeFile(path.join(other, "keep"), "other"); await writeFile(path.join(legacy, "keep"), "legacy");
    await test.runtime.suspend(test.current().id); await test.runtime.clearData(test.current().id);
    await expect(readFile(path.join(first.directory, "preferences.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(marker, "utf8")).toBe("decided"); expect(await readFile(path.join(other, "keep"), "utf8")).toBe("other"); expect(await readFile(path.join(legacy, "keep"), "utf8")).toBe("legacy");
    const record = test.current(); await test.store.setPluginInstalled(record.id, false, record.revision); await test.runtime.whenIdle();
    expect(handlePluginNativeDocument(documentPath(first.url))).toBeUndefined();
  });
  it("rejects native data symlinks to another installation before module evaluation and deletion", async () => {
    const test = await fixture();
    const dataRoot = path.join(test.userDataPath, "desktop-plugins/data"), other = path.join(dataRoot, "other/native");
    await mkdir(other, { recursive: true }); await writeFile(path.join(other, "keep"), "retained");
    await mkdir(path.join(dataRoot, "native-fixture"), { recursive: true }); await symlink(other, path.join(dataRoot, "native-fixture/native"), "dir");
    await test.ready(); expect(test.current().status).toBe("failed"); await expect(readFile(test.trace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(clearPluginNativeData(test.userDataPath, "native-fixture")).rejects.toThrow(/escapes/); expect(await readFile(path.join(other, "keep"), "utf8")).toBe("retained");
  });
});
