import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServiceContext, PluginServiceSetup } from "@omp-desktop/plugin";
import { createDesktopSettingsStore } from "../settings/desktop-settings.js";
import { LocalPluginRuntime } from "./local-runtime.js";
const directories: string[] = [];
const runtimes: LocalPluginRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose())); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function localRuntime(setup: PluginServiceSetup) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "omp-local-plugin-runtime-")); directories.push(userDataPath);
  const store = createDesktopSettingsStore({ userDataPath });
  const errors = vi.fn();
  const runtime = new LocalPluginRuntime(store, () => ({ invoke: async () => { throw new Error("Unexpected test native operation"); }, subscribe: () => { throw new Error("Unexpected test native subscription"); } }), async () => { throw new Error("No directory plugin in this fixture"); }, errors);
  runtime.register({ id: "desktop-pet", setup, manage: { "pet:list": () => ["iris"] } });
  runtime.register({ id: "wallpaper" }); runtime.register({ id: "agent-speed" });
  runtimes.push(runtime);
  await runtime.initialize(); await runtime.whenIdle();
  const patch = async (enabled: boolean, config?: Record<string, unknown>) => { const record = (await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!; return store.patchPlugin({ installationId: record.id, expectedRevision: record.revision, patch: { enabled, ...(config ? { config } : {}) } }); };
  return { runtime, store, patch, userDataPath, errors };
}
describe("local profile plugin generations", () => {
  it("waits for startup readiness and disables without ever acquiring the feature", async () => {
    const setup = vi.fn(); const { runtime, patch } = await localRuntime(setup);
    await patch(true); await runtime.whenIdle(); expect(setup).not.toHaveBeenCalled();
    await patch(false); runtime.startupReady(); await runtime.whenIdle();
    expect(setup).not.toHaveBeenCalled(); expect(runtime.getSnapshot().installations.find(({ id }) => id === "desktop-pet")).toMatchObject({ enabled: false, status: "disabled" });
  });
  it("reports a missing selected daemon facade instead of returning an invalid Omp API", async () => {
    let context: PluginServiceContext | undefined;
    const { runtime, patch } = await localRuntime((ctx) => { context = ctx; });
    await patch(true); runtime.startupReady(); await runtime.whenIdle();
    expect(() => context!.omp).toThrow("does not have a selected daemon session");
  });
  it("shares one service across concurrent readiness and configuration changes", async () => {
    const cleanup = vi.fn(), setup = vi.fn(() => cleanup); const { runtime, patch } = await localRuntime(setup);
    await patch(true); runtime.startupReady(); runtime.startupReady(); await runtime.whenIdle(); expect(setup).toHaveBeenCalledOnce();
    const generation = runtime.getSnapshot().installations.find(({ id }) => id === "desktop-pet")!.generation;
    await patch(true, { size: "large" }); await runtime.whenIdle();
    expect(setup).toHaveBeenCalledOnce(); expect(runtime.getSnapshot().installations.find(({ id }) => id === "desktop-pet")!.generation).toBe(generation);
    await patch(false); await runtime.whenIdle(); expect(cleanup).toHaveBeenCalledOnce();
    expect(() => runtime.assertAuthorized("desktop-pet", generation, "active")).toThrow();
  });
  it("does not run a waiting factory twice on ordinary configuration broadcasts", async () => {
    const cleanup = vi.fn(), setup = vi.fn((ctx: PluginServiceContext) => { ctx.waiting("Choose a resource"); return cleanup; });
    const { runtime, patch } = await localRuntime(setup); await patch(true); runtime.startupReady(); await runtime.whenIdle();
    await patch(true, { size: "small" }); await runtime.whenIdle(); expect(setup).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().installations.find(({ id }) => id === "desktop-pet")).toMatchObject({ status: "waiting", error: "Choose a resource" });
  });
  it("runs a late returned cleanup after revocation instead of leaking an asynchronous factory", async () => {
    const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<() => void>(), cleanup = vi.fn();
    const setup = vi.fn(async () => { started.resolve(); return pending.promise; });
    const { runtime, patch } = await localRuntime(setup); await patch(true); runtime.startupReady(); await started.promise;
    await patch(false); pending.resolve(cleanup); await runtime.whenIdle(); expect(cleanup).toHaveBeenCalledOnce(); expect(setup).toHaveBeenCalledOnce();
  });
  it("leaves resources and ordinary creation workspaces intact while settings broadcasts and disabled management remain usable", async () => {
    const cleanup = vi.fn(), setup = vi.fn(() => cleanup); const { runtime, store, patch, userDataPath } = await localRuntime(setup);
    const resource = path.join(userDataPath, "pets", "keep.txt"), workspace = path.join(userDataPath, "pet-workspaces", "ordinary-agent.txt");
    await mkdir(path.dirname(resource), { recursive: true }); await mkdir(path.dirname(workspace), { recursive: true }); await writeFile(resource, "artwork"); await writeFile(workspace, "ordinary OMP conversation");
    await patch(true); runtime.startupReady(); await runtime.whenIdle(); await patch(false); await runtime.whenIdle();
    const settingsChanged = vi.fn(); store.subscribe(settingsChanged); await store.patch({ notifications: { playSound: false } }); expect(settingsChanged).toHaveBeenCalledOnce();
    const record = runtime.getSnapshot().installations.find(({ id }) => id === "desktop-pet")!;
    expect(await runtime.invoke(record.id, record.generation, "pet:list", {})).toEqual(["iris"]);
    await store.setPluginInstalled(record.id, false, record.revision); await runtime.whenIdle();
    expect(await readFile(resource, "utf8")).toBe("artwork"); expect(await readFile(workspace, "utf8")).toBe("ordinary OMP conversation"); expect(cleanup).toHaveBeenCalledOnce();
  });
  it("isolates a factory failure and requires explicit reload", async () => {
    const setup = vi.fn(() => { throw new Error("Corrupt selected resource"); }); const { runtime, patch, errors } = await localRuntime(setup);
    await patch(true); runtime.startupReady(); await runtime.whenIdle(); await patch(true, { size: "small" }); await runtime.whenIdle();
    expect(setup).toHaveBeenCalledOnce(); expect(errors).toHaveBeenCalledWith("desktop-pet", "Corrupt selected resource");
    expect(runtime.getSnapshot().installations.find(({ id }) => id === "agent-speed")!.status).toBe("active");
    await expect(runtime.reload("desktop-pet")).rejects.toThrow("Corrupt selected resource"); expect(setup).toHaveBeenCalledTimes(2);
  });
});
