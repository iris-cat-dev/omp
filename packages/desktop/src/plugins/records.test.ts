import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalPluginRecordSchema } from "@omp-desktop/protocol/desktop-local-plugins";
import { createDesktopSettingsStore, DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings.js";
import { createLocalPluginDocument } from "../settings/plugin-records.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function profile(install = true) {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "omp-plugin-records-"));
  directories.push(userDataPath);
  const store = createDesktopSettingsStore({ userDataPath });
  if (install) {
    for (const id of ["directory-one", "directory-two"]) {
      const record = LocalPluginRecordSchema.parse({ id, packageId: id, owner: "desktop", version: "1.0.0", generation: 0, enabled: false, installed: true, source: { type: "local", identity: path.join(userDataPath, id) }, trusted: true, config: { size: "medium" }, declaredCapabilities: [], grantedCapabilities: [], revision: 0, migrationVersion: 1, format: "package", metadata: null });
      await store.installPlugin(record, (await store.getPlugins()).revision);
    }
  }
  return { userDataPath, store };
}

describe("authoritative folder plugin records", () => {
  it("keeps new and restarted profiles empty until an explicit installation", async () => {
    const { userDataPath, store } = await profile(false);
    expect(await store.getPlugins()).toEqual(createLocalPluginDocument());
    await store.patch({ notifications: { playSound: false } });
    expect(await createDesktopSettingsStore({ userDataPath }).getPlugins()).toEqual(createLocalPluginDocument());
  });

  it("preserves old pet preferences without creating installations or exposing them as settings", async () => {
    const { userDataPath } = await profile(false);
    const pet = { enabled: true, size: "small", selectedId: "iris", position: { x: -1240, y: 180 } };
    await writeFile(path.join(userDataPath, "desktop-settings.json"), JSON.stringify({ version: 1, settings: { ...DEFAULT_DESKTOP_SETTINGS, pet }, migrations: { daemonStopOnQuitDefaultApplied: true } }));
    const store = createDesktopSettingsStore({ userDataPath });
    expect((await store.getPlugins()).installations).toEqual([]);
    expect(await store.get()).not.toHaveProperty("pet");
    await store.patch({ notifications: { playSound: false } });
    const persisted = JSON.parse(await readFile(path.join(userDataPath, "desktop-settings.json"), "utf8"));
    expect(persisted.settings.pet).toEqual(pet);
    expect(persisted.plugins.installations).toEqual([]);
  });

  it("retains legacy bundled records while rejecting activation and background selection", async () => {
    const { userDataPath } = await profile(false);
    const legacy = LocalPluginRecordSchema.parse({ id: "desktop-pet", packageId: "desktop-pet", owner: "desktop", version: "0.7.0", generation: 4, enabled: true, installed: true, source: { type: "builtin", identity: "builtin:desktop-pet" }, trusted: true, config: { selectedId: "iris", position: null, size: "small" }, declaredCapabilities: [], grantedCapabilities: [], revision: 2, migrationVersion: 1 });
    await writeFile(path.join(userDataPath, "desktop-settings.json"), JSON.stringify({ version: 1, settings: DEFAULT_DESKTOP_SETTINGS, plugins: { ...createLocalPluginDocument(), installations: [legacy] }, migrations: { daemonStopOnQuitDefaultApplied: true } }));
    const store = createDesktopSettingsStore({ userDataPath });
    await expect(store.patchPlugin({ installationId: legacy.id, expectedRevision: legacy.revision, patch: { enabled: true } })).rejects.toThrow("Legacy bundled");
    await expect(store.advancePluginGeneration(legacy.id)).rejects.toThrow("Legacy bundled");
    await expect(store.selectPluginBackground({ installationId: legacy.id, extensionId: "legacy" }, 0)).rejects.toThrow("Legacy bundled");
    await store.patch({ releaseChannel: "beta" });
    expect((await createDesktopSettingsStore({ userDataPath }).getPlugins()).installations).toEqual([legacy]);
  });

  it("rejects stale revisions and preserves disjoint owner writes", async () => {
    const { store } = await profile();
    await store.patchPlugin({ installationId: "directory-one", expectedRevision: 0, patch: { config: { size: "large" } } });
    await expect(store.patchPlugin({ installationId: "directory-one", expectedRevision: 0, patch: { enabled: true } })).rejects.toThrow("changed");
    await store.patchPlugin({ installationId: "directory-two", expectedRevision: 0, patch: { config: { opacity: 0.45 } } });
    const snapshot = await store.getPlugins();
    expect(snapshot.installations.find(({ id }) => id === "directory-one")!.config.size).toBe("large");
    expect(snapshot.installations.find(({ id }) => id === "directory-two")!.config.opacity).toBe(0.45);
  });

  it("rechecks actor authority inside the transaction after generation replacement", async () => {
    const { store } = await profile();
    let generation = 0;
    store.subscribePlugins((document) => { generation = document.installations.find(({ id }) => id === "directory-one")!.generation; });
    const replacing = store.advancePluginGeneration("directory-one");
    const oldActorPatch = store.patchPlugin({ installationId: "directory-one", expectedRevision: 0, patch: { config: { size: "large" } } }, () => { if (generation !== 0) throw new Error("Old actor revoked"); });
    await replacing;
    await expect(oldActorPatch).rejects.toThrow("revoked");
    expect((await store.getPlugins()).installations.find(({ id }) => id === "directory-one")!.config.size).toBe("medium");
  });

  it("removal retains configuration and reinstall leaves execution disabled", async () => {
    const { store } = await profile();
    await store.patchPlugin({ installationId: "directory-one", expectedRevision: 0, patch: { enabled: true, config: { size: "small" } } });
    await store.setPluginInstalled("directory-one", false, 1);
    let record = (await store.getPlugins()).installations.find(({ id }) => id === "directory-one")!;
    expect(record).toMatchObject({ installed: false, enabled: false, config: { size: "small" } });
    await store.setPluginInstalled(record.id, true, record.revision);
    record = (await store.getPlugins()).installations.find(({ id }) => id === record.id)!;
    expect(record).toMatchObject({ installed: true, enabled: false, config: { size: "small" } });
  });

  it("keeps read-only preferences usable when plugin data is damaged without overwriting the file", async () => {
    const { userDataPath } = await profile(false);
    const file = path.join(userDataPath, "desktop-settings.json");
    const raw = JSON.stringify({ version: 1, settings: { ...DEFAULT_DESKTOP_SETTINGS, releaseChannel: "beta" }, plugins: { ...createLocalPluginDocument(), installations: [{ id: "invalid" }] }, migrations: { daemonStopOnQuitDefaultApplied: true } });
    await writeFile(file, raw);
    const store = createDesktopSettingsStore({ userDataPath });
    expect((await store.get()).releaseChannel).toBe("beta");
    await expect(store.getPlugins()).rejects.toThrow("plugin data");
    await expect(store.patch({ notifications: { playSound: false } })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(raw);
  });
});
