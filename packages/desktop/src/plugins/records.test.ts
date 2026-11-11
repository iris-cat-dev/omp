import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopSettingsStore, DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings.js";
import { createLocalPluginDocument } from "./records.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function profile() { const userDataPath = await mkdtemp(path.join(os.tmpdir(), "omp-plugin-records-")); directories.push(userDataPath); return { userDataPath, store: createDesktopSettingsStore({ userDataPath }) }; }
const wallpaper = { enabled: true, config: { source: "url" as const, candidateId: null, url: "https://example.test/background.webm?token=literal#frame", opacity: 0.7 } };
describe("authoritative local plugin records", () => {
  it("migrates persisted pet desired state once and removes the old settings writer", async () => {
    const { userDataPath, store } = await profile();
    await writeFile(path.join(userDataPath, "desktop-settings.json"), JSON.stringify({ version: 1, settings: { ...DEFAULT_DESKTOP_SETTINGS, pet: { enabled: true, size: "small", selectedId: "iris", position: { x: -1240, y: 180 } } }, migrations: { daemonStopOnQuitDefaultApplied: true } }));
    const initial = (await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!;
    expect(initial).toMatchObject({ enabled: true, config: { size: "small", position: { x: -1240, y: 180 } } });
    await store.patchPlugin({ installationId: initial.id, expectedRevision: initial.revision, patch: { enabled: false, config: { size: "large" } } });
    const restarted = createDesktopSettingsStore({ userDataPath });
    expect((await restarted.getPlugins()).installations.find(({ id }) => id === initial.id)).toMatchObject({ enabled: false, config: { size: "large" } });
    expect(JSON.parse(await readFile(path.join(userDataPath, "desktop-settings.json"), "utf8")).settings).not.toHaveProperty("pet");
  });
  it("lets explicit new configuration win over delayed renderer wallpaper migration", async () => {
    const { store } = await profile(); await store.patchPlugin({ installationId: "wallpaper", expectedRevision: 0, patch: { enabled: false, config: { opacity: 0.35 } } });
    await store.migrateLegacyPlugins({ wallpaper });
    expect((await store.getPlugins()).installations.find(({ id }) => id === "wallpaper")).toMatchObject({ enabled: false, migrationVersion: 1, config: { source: "none", opacity: 0.35 } });
  });
  it("persists an existing selected background but never overrides a newer explicit provider selection", async () => {
    const first = await profile(); await first.store.migrateLegacyPlugins({ wallpaper });
    expect((await first.store.getPlugins()).backgroundProvider).toEqual({ installationId: "wallpaper", extensionId: "wallpaper" });
    const second = await profile(); await second.store.selectPluginBackground(null, 0); await second.store.migrateLegacyPlugins({ wallpaper });
    expect((await second.store.getPlugins()).backgroundProvider).toBeNull();
  });
  it("rejects stale revisions and preserves disjoint owner writes", async () => {
    const { store } = await profile();
    await store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 0, patch: { config: { size: "large" } } });
    await expect(store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 0, patch: { enabled: true } })).rejects.toThrow("changed");
    await store.patchPlugin({ installationId: "wallpaper", expectedRevision: 0, patch: { config: { opacity: 0.45 } } });
    const snapshot = await store.getPlugins(); expect(snapshot.installations.find(({ id }) => id === "desktop-pet")!.config.size).toBe("large"); expect(snapshot.installations.find(({ id }) => id === "wallpaper")!.config.opacity).toBe(0.45);
  });
  it("rechecks actor authority inside the serial transaction after generation replacement", async () => {
    const { store } = await profile(); await store.getPlugins(); let generation = 0;
    store.subscribePlugins((document) => { generation = document.installations.find(({ id }) => id === "desktop-pet")!.generation; });
    const replacing = store.advancePluginGeneration("desktop-pet");
    const oldActorPatch = store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 0, patch: { config: { size: "large" } } }, () => { if (generation !== 0) throw new Error("Old actor revoked"); });
    await replacing; await expect(oldActorPatch).rejects.toThrow("revoked");
    expect((await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!.config.size).toBe("medium");
  });
  it("removal retains configuration and reinstall keeps desired execution disabled", async () => {
    const { store } = await profile(); await store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 0, patch: { enabled: true, config: { size: "small" } } });
    await store.setPluginInstalled("desktop-pet", false, 1); let record = (await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!;
    expect(record).toMatchObject({ installed: false, enabled: false, config: { size: "small" } });
    await store.setPluginInstalled(record.id, true, record.revision); record = (await store.getPlugins()).installations.find(({ id }) => id === record.id)!; expect(record).toMatchObject({ installed: true, enabled: false, config: { size: "small" } });
  });
  it("keeps core read-only settings available when plugin data is damaged without overwriting the file", async () => {
    const { userDataPath, store } = await profile(); const file = path.join(userDataPath, "desktop-settings.json");
    const document = { version: 1, settings: { ...DEFAULT_DESKTOP_SETTINGS, releaseChannel: "beta" }, plugins: { ...createLocalPluginDocument(), installations: [{ id: "invalid" }] }, migrations: { daemonStopOnQuitDefaultApplied: true } };
    const raw = JSON.stringify(document); await writeFile(file, raw);
    expect((await store.get()).releaseChannel).toBe("beta"); await expect(store.getPlugins()).rejects.toThrow("plugin data"); await expect(store.patch({ notifications: { playSound: false } })).rejects.toThrow(); expect(await readFile(file, "utf8")).toBe(raw);
  });
});
