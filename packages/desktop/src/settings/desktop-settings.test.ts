import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WallpaperLibrary,
  WallpaperValidatedFile,
} from "@omp-desktop/protocol/desktop-wallpaper";
import type { DesktopPetSettings } from "@omp-desktop/plugin-desktop-pet/types";

import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
  createDesktopSettingsStore,
} from "./desktop-settings";

async function createTempUserDataDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-settings-"));
}

function settingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, "desktop-settings.json");
}

async function createMediaFile(
  userDataPath: string,
  relativePath: string,
): Promise<WallpaperValidatedFile> {
  const filePath = path.join(userDataPath, "media", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `source:${relativePath}`);
  const canonicalPath = await realpath(filePath);
  return {
    path: canonicalPath,
    directory: path.dirname(canonicalPath),
    name: path.basename(canonicalPath),
    kind: relativePath.endsWith(".mp4") ? "video" : "image",
  };
}

describe("desktop-settings", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  it("serializes a plugin field patch with unrelated settings without duplicating desired state", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });
    const pet = (await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!;
    await Promise.all([
      store.patchPlugin({ installationId: pet.id, expectedRevision: pet.revision, patch: { enabled: true, config: { selectedId: "custom-cat", position: { x: -1240, y: 420 }, size: "large" } } }),
      store.patch({ notifications: { playSound: false } }),
    ]);
    const restarted = createDesktopSettingsStore({ userDataPath });
    const record = (await restarted.getPlugins()).installations.find(({ id }) => id === pet.id)!;
    expect(record.enabled).toBe(true);
    expect(record.config).toEqual({ selectedId: "custom-cat", size: "large", position: { x: -1240, y: 420 } });
    expect((await restarted.get()).notifications.playSound).toBe(false);
    expect(JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")).settings).not.toHaveProperty("pet");
  });

  it("notifies only committed writes and leaves cached preferences unchanged after failure", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });
    await store.get();
    const notifications: DesktopSettings[] = [];
    const unsubscribe = store.subscribe((settings) => notifications.push(settings));
    const file = settingsFilePath(userDataPath);
    await rename(file, `${file}.saved`);
    await mkdir(file);
    await expect(store.patch({ notifications: { playSound: false } })).rejects.toThrow();
    expect(notifications).toEqual([]);
    expect((await store.get()).notifications.playSound).toBe(true);
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    const committed = await store.patch({ notifications: { playSound: false } });
    expect(notifications).toEqual([committed]);
    expect(JSON.parse(await readFile(file, "utf8")).settings.notifications.playSound).toBe(false);
    unsubscribe();
    await store.patch({ notifications: { playSound: true } });
    expect(notifications).toHaveLength(1);
    expect(await readdir(userDataPath)).toEqual(["desktop-settings.json"]);
  });

  it("rejects invalid plugin fields and isolates returned configuration from persisted state", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });
    await store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 0, patch: { config: { selectedId: "custom", position: { x: -100, y: 50 } } } });
    await expect(store.patchPlugin({ installationId: "desktop-pet", expectedRevision: 1, patch: { config: { size: "huge", selectedId: "", position: { x: Infinity, y: 0 } } } })).rejects.toThrow();
    const record = (await store.getPlugins()).installations.find(({ id }) => id === "desktop-pet")!;
    const config = record.config as unknown as DesktopPetSettings; // The builtin schema validates this in-process snapshot.
    config.position!.x = 999;
    config.selectedId = "mutated";
    const persisted = (await store.getPlugins()).installations.find(({ id }) => id === record.id)!;
    expect(persisted.config).toMatchObject({ selectedId: "custom", position: { x: -100, y: 50 } });
    await store.patchPlugin({ installationId: record.id, expectedRevision: persisted.revision, patch: { config: { position: null } } });
    expect((await createDesktopSettingsStore({ userDataPath }).getPlugins()).installations.find(({ id }) => id === record.id)!.config.position).toBeNull();
  });

  it("persists default settings for new users", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: DesktopSettings;
    };

    expect(settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(persisted.settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("handles concurrent first-launch reads without racing the settings write", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await Promise.all(Array.from({ length: 20 }, () => store.get()));
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      settings: DesktopSettings;
    };
    const files = await readdir(userDataPath);

    expect(settings).toEqual(Array.from({ length: 20 }, () => DEFAULT_DESKTOP_SETTINGS));
    expect(persisted.settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(files).toEqual(["desktop-settings.json"]);
  });

  it("coerces invalid persisted values back to safe defaults", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "nightly",
          daemon: {
            manageBuiltInDaemon: "sometimes",
            keepRunningAfterQuit: false,
          },
        },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();

    expect(settings).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });

  it("patches nested settings and leaves no temp files behind", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    await store.get();
    const next = await store.patch({
      releaseChannel: "beta",
      daemon: { keepRunningAfterQuit: false },
    });
    const files = await readdir(userDataPath);

    expect(next).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
    });
    expect(files).toEqual(["desktop-settings.json"]);
  });

  it("persists a selected browser and rejects unknown targets", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const selected = await store.patch({ browser: { target: "firefox" } });
    const rejected = await store.patch({ browser: { target: "arbitrary-executable" } });
    const restored = await createDesktopSettingsStore({ userDataPath }).get();

    expect(selected.browser.target).toBe("firefox");
    expect(rejected.browser.target).toBe("firefox");
    expect(restored.browser.target).toBe("firefox");
  });

  it("roundtrips exact custom arguments and preserves them while switching browser targets", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });
    const custom = {
      executable: path.join(userDataPath, "My Browser 中文", "browser.exe"),
      args: ["", "--profile", 'profile "one" & 中文', "{url}", "", "--last='two words'"],
    };

    await store.patch({ browser: { target: "custom", custom } });
    const restored = createDesktopSettingsStore({ userDataPath });
    expect((await restored.get()).browser).toEqual({ target: "custom", custom });
    await restored.patch({ browser: { target: "firefox" } });
    expect((await restored.get()).browser).toEqual({ target: "firefox", custom });
    await restored.patch({ browser: { target: "system" } });
    expect((await restored.get()).browser).toEqual({ target: "system", custom });
    await restored.patch({ browser: { target: "custom" } });
    expect((await createDesktopSettingsStore({ userDataPath }).get()).browser).toEqual({
      target: "custom",
      custom,
    });
  });

  it("allows selecting an unconfigured custom target without saving an invalid new config", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await createDesktopSettingsStore({ userDataPath }).patch({ browser: { target: "custom" } });

    expect((await createDesktopSettingsStore({ userDataPath }).get()).browser).toEqual({
      target: "custom",
      custom: { executable: "", args: ["{url}"] },
    });
  });

  it("isolates nested browser defaults, patch inputs, and returned argument arrays", async () => {
    const firstDirectory = await createTempUserDataDir();
    const secondDirectory = await createTempUserDataDir();
    directories.add(firstDirectory);
    directories.add(secondDirectory);
    const first = createDesktopSettingsStore({ userDataPath: firstDirectory });
    const second = createDesktopSettingsStore({ userDataPath: secondDirectory });
    const defaults = await first.get();
    defaults.browser.custom.executable = "mutated";
    defaults.browser.custom.args.push("mutated");
    expect((await first.get()).browser).toEqual(DEFAULT_DESKTOP_SETTINGS.browser);
    expect((await second.get()).browser).toEqual({
      target: "system",
      custom: { executable: "", args: ["{url}"] },
    });
    const custom = { executable: process.execPath, args: ["", "{url}"] };
    const saved = await first.patch({ browser: { target: "custom", custom } });
    custom.args.push("mutated input");
    saved.browser.custom.args[0] = "mutated output";
    expect((await first.get()).browser.custom.args).toEqual(["", "{url}"]);
    expect(
      (await createDesktopSettingsStore({ userDataPath: firstDirectory }).get()).browser.custom
        .args,
    ).toEqual(["", "{url}"]);
    expect(DEFAULT_DESKTOP_SETTINGS.browser.custom).toEqual({ executable: "", args: ["{url}"] });
  });

  it.each([
    null,
    undefined,
    {},
    { executable: "", args: ["{url}"] },
    { executable: "relative/browser.exe", args: ["{url}"] },
    { executable: `${process.execPath}\0`, args: ["{url}"] },
    { executable: process.execPath, args: [] },
    { executable: process.execPath, args: ["{url}", "{url}"] },
    { executable: process.execPath, args: ["prefix{url}"] },
    { executable: process.execPath, args: ["{url}", "suffix{url}"] },
    { executable: process.execPath, args: ["{url}", "bad\0value"] },
    { executable: process.execPath, args: ["{url}", 42] },
    { executable: process.execPath, args: "{url}" },
  ])("atomically rejects explicitly invalid custom configuration: %j", async (custom) => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });
    const previous = await store.get();
    const raw = await readFile(settingsFilePath(userDataPath), "utf8");
    const notifications: DesktopSettings[] = [];
    store.subscribe((settings) => notifications.push(settings));

    await expect(
      store.patch({
        releaseChannel: "beta",
        browser: { target: "custom", custom },
        notifications: { playSound: false },
      }),
    ).rejects.toThrow(/custom browser/i);
    expect(await store.get()).toEqual(previous);
    expect(await readFile(settingsFilePath(userDataPath), "utf8")).toBe(raw);
    expect(notifications).toEqual([]);
    await store.patch({ browser: { target: "firefox" } });
    expect((await store.get()).browser.target).toBe("firefox");
  });

  it.each([
    { target: "firefox" },
    { target: "firefox", custom: { executable: "relative", args: ["{url}"] } },
    { target: "custom", custom: { executable: process.execPath, args: ["--url={url}"] } },
  ])("normalizes older or malformed saved browser configuration: %j", async (browser) => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({ version: 1, settings: { browser } }),
    );

    expect((await createDesktopSettingsStore({ userDataPath }).get()).browser).toEqual({
      target: browser.target,
      custom: { executable: "", args: ["{url}"] },
    });
  });

  it("defaults notification sounds on for existing settings documents", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: {
            manageBuiltInDaemon: true,
            keepRunningAfterQuit: false,
          },
        },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
        },
      }),
    );

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.notifications.playSound).toBe(true);
  });

  it("keeps an explicit notification sound choice across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);

    await createDesktopSettingsStore({ userDataPath }).patch({
      notifications: { playSound: false },
    });

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.notifications.playSound).toBe(false);
  });

  it("keeps a remembered window-close choice across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);

    await createDesktopSettingsStore({ userDataPath }).patch({
      window: { closeBehavior: "background" },
    });

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.window.closeBehavior).toBe("background");
  });

  it("does not let stale legacy renderer settings override an explicit desktop patch", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    const patched = await store.patch({
      daemon: {
        manageBuiltInDaemon: false,
      },
    });
    const migrated = await store.migrateLegacyRendererSettings({
      manageBuiltInDaemon: true,
      releaseChannel: "beta",
    });
    const persisted = JSON.parse(await readFile(settingsFilePath(userDataPath), "utf8")) as {
      migrations: { legacyRendererSettingsImported: boolean };
      settings: DesktopSettings;
    };

    expect(patched.daemon.manageBuiltInDaemon).toBe(false);
    expect(migrated.daemon.manageBuiltInDaemon).toBe(false);
    expect(migrated.releaseChannel).toBe("stable");
    expect(persisted.migrations.legacyRendererSettingsImported).toBe(true);
    expect(persisted.settings.daemon.manageBuiltInDaemon).toBe(false);
  });

  it("does not rewrite existing settings while reading them", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const raw = JSON.stringify({
      version: 1,
      settings: {
        releaseChannel: "stable",
        daemon: {
          manageBuiltInDaemon: false,
          keepRunningAfterQuit: true,
        },
      },
      migrations: {
        legacyRendererSettingsImported: false,
      },
    });
    await writeFile(settingsFilePath(userDataPath), raw);
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();
    const persisted = await readFile(settingsFilePath(userDataPath), "utf8");

    expect(settings.daemon.manageBuiltInDaemon).toBe(false);
    expect(persisted).toBe(raw);
  });

  it("resets the pre-existing keep-running default so the daemon stops with the app", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
        },
        migrations: { legacyRendererSettingsImported: true },
      }),
    );
    const store = createDesktopSettingsStore({ userDataPath });

    const settings = await store.get();

    expect(settings.daemon.keepRunningAfterQuit).toBe(false);
  });

  it("keeps an explicit keep-running choice across restarts", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    await writeFile(
      settingsFilePath(userDataPath),
      JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "stable",
          daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
        },
        migrations: { legacyRendererSettingsImported: true },
      }),
    );
    await createDesktopSettingsStore({ userDataPath }).patch({
      daemon: { keepRunningAfterQuit: true },
    });

    const settings = await createDesktopSettingsStore({ userDataPath }).get();

    expect(settings.daemon.keepRunningAfterQuit).toBe(true);
  });

  it("migrates desktop-owned values from legacy renderer settings once", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const store = createDesktopSettingsStore({ userDataPath });

    await store.patch({
      daemon: {
        keepRunningAfterQuit: false,
      },
    });

    const migrated = await store.migrateLegacyRendererSettings({
      releaseChannel: "beta",
      manageBuiltInDaemon: false,
      theme: "dark",
    });
    const ignoredSecondMigration = await store.migrateLegacyRendererSettings({
      releaseChannel: "stable",
      manageBuiltInDaemon: true,
    });

    expect(migrated).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      releaseChannel: "beta",
      daemon: {
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: false,
      },
    });
    expect(ignoredSecondMigration).toEqual(migrated);
  });

  it("serializes wallpaper additions, removal and ordinary patches against the latest document", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const [first, second, third] = await Promise.all([
      createMediaFile(userDataPath, "first.png"),
      createMediaFile(userDataPath, "second.mp4"),
      createMediaFile(userDataPath, "third.png"),
    ]);
    const store = createDesktopSettingsStore({ userDataPath });
    const initial = await store.addWallpaperCandidates([first]);
    const firstId = initial.added[0]!.candidateId;
    const [, removal, addition] = await Promise.all([
      store.addWallpaperCandidates([second]),
      store.removeWallpaperCandidates([firstId]),
      store.addWallpaperCandidates([third]),
      store.patch({ notifications: { playSound: false } }),
    ]);
    expect(removal.removedCandidateIds).toEqual([firstId]);
    expect(addition.library.items.map((item) => item.path)).toEqual([second.path, third.path]);
    const restarted = createDesktopSettingsStore({ userDataPath });
    expect(await restarted.getWallpaperLibrary()).toEqual(addition.library);
    expect((await restarted.get()).notifications.playSound).toBe(false);
    expect(addition.library.revision).toBe(initial.library.revision + 3);
    for (const file of [first, second, third]) {
      expect(await readFile(file.path, "utf8")).toBe(`source:${file.name}`);
    }
    expect((await readdir(userDataPath)).sort()).toEqual(["desktop-settings.json", "media"]);
  });

  it("deduplicates canonical paths without merging names and gives re-added files new identities", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const first = await createMediaFile(userDataPath, "one/same.png");
    const other = await createMediaFile(userDataPath, "two/same.png");
    const store = createDesktopSettingsStore({ userDataPath });
    const added = await store.addWallpaperCandidates([first, other, { ...first }]);
    expect(added.added.map((item) => item.path)).toEqual([first.path, other.path]);
    expect(added.duplicates).toEqual([added.added[0]]);
    const duplicate = await store.addWallpaperCandidates([{ ...first, name: "ignored.png" }]);
    expect(duplicate.added).toEqual([]);
    expect(duplicate.duplicates).toEqual([added.added[0]]);
    expect(duplicate.library).toEqual(added.library);
    const oldId = added.added[0]!.candidateId;
    await store.removeWallpaperCandidates([oldId, oldId, "unknown"]);
    const readded = await store.addWallpaperCandidates([first]);
    expect(readded.added[0]!.candidateId).not.toBe(oldId);
    expect(readded.library.items.map((item) => item.path)).toEqual([other.path, first.path]);
    const staleRemoval = await store.removeWallpaperCandidates([oldId]);
    expect(staleRemoval.removedCandidateIds).toEqual([]);
    expect(staleRemoval.library).toEqual(readded.library);
  });

  it("isolates all returned and subscribed library snapshots from the authority and each other", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = await createMediaFile(userDataPath, "picture.png");
    const observed: WallpaperLibrary[] = [];
    const store = createDesktopSettingsStore({
      userDataPath,
      onWallpaperLibraryCommitted(library) {
        if (library.items[0]) library.items[0].name = "core mutation";
        library.items.length = 0;
      },
    });
    store.subscribeWallpaperLibrary((library) => {
      library.items[0]!.path = "listener mutation";
      library.items.length = 0;
    });
    store.subscribeWallpaperLibrary((library) => observed.push(library));
    const result = await store.addWallpaperCandidates([file]);
    const expected = await store.getWallpaperLibrary();
    expect(observed).toEqual([expected]);
    result.library.items[0]!.name = "response mutation";
    result.added[0]!.path = "added mutation";
    expect((await store.getWallpaperLibrary()).items[0]).toMatchObject(file);
    const duplicate = await store.addWallpaperCandidates([file]);
    duplicate.duplicates[0]!.name = "duplicate mutation";
    duplicate.library.items.length = 0;
    observed[0]!.items.length = 0;
    expected.items[0]!.name = "get mutation";
    expect((await store.getWallpaperLibrary()).items[0]).toMatchObject(file);
    expect(
      (await createDesktopSettingsStore({ userDataPath }).getWallpaperLibrary()).items[0],
    ).toMatchObject(file);
  });

  it("keeps cache, disk and publication unchanged when an atomic rename cannot commit", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const first = await createMediaFile(userDataPath, "first.png");
    const second = await createMediaFile(userDataPath, "second.png");
    const core: WallpaperLibrary[] = [];
    const notifications: WallpaperLibrary[] = [];
    const store = createDesktopSettingsStore({
      userDataPath,
      onWallpaperLibraryCommitted: (library) => {
        core.push(library);
      },
    });
    const initial = await store.addWallpaperCandidates([first]);
    store.subscribeWallpaperLibrary((library) => notifications.push(library));
    const coreCount = core.length;
    const file = settingsFilePath(userDataPath);
    const original = await readFile(file, "utf8");
    await rename(file, `${file}.saved`);
    await mkdir(file);
    await expect(store.addWallpaperCandidates([second])).rejects.toThrow();
    await expect(
      store.removeWallpaperCandidates([initial.added[0]!.candidateId]),
    ).rejects.toThrow();
    await expect(store.importLegacyWallpaper(second, null)).rejects.toThrow();
    expect(await store.getWallpaperLibrary()).toEqual(initial.library);
    expect(core).toHaveLength(coreCount);
    expect(notifications).toEqual([]);
    expect(await readFile(`${file}.saved`, "utf8")).toBe(original);
    expect((await readdir(userDataPath)).sort()).toEqual([
      "desktop-settings.json",
      "desktop-settings.json.saved",
      "media",
    ]);
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    const imported = await store.importLegacyWallpaper(second, null);
    expect(imported.candidateId).toBe(imported.library.items[1]!.candidateId);
    expect(imported.library.items.map((item) => item.path)).toEqual([first.path, second.path]);
    expect(notifications).toEqual([imported.library]);
    expect(
      await createDesktopSettingsStore({ userDataPath }).importLegacyWallpaper(null, "empty"),
    ).toEqual(imported);
  });

  it("runs core membership publication before isolated listeners without misreporting committed results", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = await createMediaFile(userDataPath, "picture.png");
    const order: string[] = [];
    let membership: string[] = [];
    const store = createDesktopSettingsStore({
      userDataPath,
      onWallpaperLibraryCommitted(library) {
        membership = library.items.map((item) => item.candidateId);
        order.push(`core:${library.revision}`);
      },
    });
    store.subscribeWallpaperLibrary((library) => {
      expect(membership).toHaveLength(library.items.length);
      for (const [index, candidate] of library.items.entries()) {
        expect(membership[index]).toBe(candidate.candidateId);
      }
      order.push(`broken:${library.revision}`);
      throw new Error("Destroyed consumer");
    });
    const healthy: WallpaperLibrary[] = [];
    const unsubscribe = store.subscribeWallpaperLibrary((library) => {
      order.push(`healthy:${library.revision}`);
      healthy.push(library);
    });
    const added = await store.addWallpaperCandidates([file]);
    expect(order).toEqual(["core:0", "core:1", "broken:1", "healthy:1"]);
    const settingsNotifications: DesktopSettings[] = [];
    store.subscribe(() => {
      throw new Error("Destroyed settings consumer");
    });
    store.subscribe((settings) => settingsNotifications.push(settings));
    await store.patch({ notifications: { playSound: false } });
    await store.migrateLegacyRendererSettings({ releaseChannel: "beta" });
    expect(settingsNotifications).toHaveLength(2);
    expect(order).toHaveLength(4);
    const removed = await store.removeWallpaperCandidates([added.added[0]!.candidateId]);
    expect(membership).toEqual([]);
    expect(order.slice(4)).toEqual(["core:2", "broken:2", "healthy:2"]);
    expect(healthy).toEqual([added.library, removed.library]);
    unsubscribe();
    await store.addWallpaperCandidates([file]);
    expect(healthy).toHaveLength(2);
    const loaded: WallpaperLibrary[] = [];
    const restarted = createDesktopSettingsStore({
      userDataPath,
      onWallpaperLibraryCommitted: (library) => {
        loaded.push(library);
      },
    });
    await restarted.get();
    expect(loaded).toEqual([await restarted.getWallpaperLibrary()]);
  });

  it("initializes missing wallpaper fields without rewriting reads and preserves them through settings migration", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const raw = JSON.stringify({
      version: 1,
      settings: { notifications: { playSound: false } },
      migrations: { legacyRendererSettingsImported: false },
    });
    await writeFile(settingsFilePath(userDataPath), raw);
    const store = createDesktopSettingsStore({ userDataPath });
    expect((await store.getWallpaperLibrary()).items).toEqual([]);
    expect(await readFile(settingsFilePath(userDataPath), "utf8")).toBe(raw);
    const media = await createMediaFile(userDataPath, "missing-after-add.png");
    const imported = await store.importLegacyWallpaper(media, null);
    await rm(media.path);
    await store.patch({ notifications: { playSound: true } });
    await store.migrateLegacyRendererSettings({ releaseChannel: "beta" });
    const restarted = createDesktopSettingsStore({ userDataPath });
    expect(await restarted.getWallpaperLibrary()).toEqual(imported.library);
    expect(await restarted.importLegacyWallpaper(null, "absent")).toEqual(imported);
    expect((await restarted.get()).releaseChannel).toBe("beta");
  });

  it("returns the first persisted migration binding after renderer crash, removal and same-path re-add", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = await createMediaFile(userDataPath, "picture.png");
    const store = createDesktopSettingsStore({ userDataPath });
    const [imported, concurrentRetry] = await Promise.all([
      store.importLegacyWallpaper(file, null),
      store.importLegacyWallpaper(null, "different later input"),
      store.patch({ releaseChannel: "beta" }),
    ]);
    expect(concurrentRetry).toEqual(imported);
    const restarted = createDesktopSettingsStore({ userDataPath });
    const retry = await restarted.importLegacyWallpaper(file, null);
    expect(retry).toEqual(imported);
    await restarted.removeWallpaperCandidates([imported.candidateId!]);
    const readded = await restarted.addWallpaperCandidates([file]);
    const afterReadd = await createDesktopSettingsStore({ userDataPath }).importLegacyWallpaper(
      file,
      null,
    );
    expect(afterReadd.candidateId).toBe(imported.candidateId);
    expect(afterReadd.candidateId).not.toBe(readded.added[0]!.candidateId);
    expect(afterReadd.library).toEqual(readded.library);
    expect((await restarted.get()).releaseChannel).toBe("beta");
  });

  it.each([null, "not-found", "unsupported"])(
    "permanently seals empty or invalid legacy input with its original reason %s",
    async (reason) => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      const file = await createMediaFile(userDataPath, "later.png");
      const store = createDesktopSettingsStore({ userDataPath });
      const notifications: WallpaperLibrary[] = [];
      await store.getWallpaperLibrary();
      store.subscribeWallpaperLibrary((library) => notifications.push(library));
      const sealed = await store.importLegacyWallpaper(null, reason);
      expect(sealed.candidateId).toBeNull();
      expect(sealed.reason).toBe(reason);
      expect(notifications).toEqual([]);
      await store.addWallpaperCandidates([file]);
      const restarted = createDesktopSettingsStore({ userDataPath });
      const retry = await restarted.importLegacyWallpaper(file, null);
      expect(retry.candidateId).toBeNull();
      expect(retry.reason).toBe(reason);
      expect(retry.library.items).toHaveLength(1);
    },
  );

  it("binds an already-present legacy file without moving it or publishing a false library change", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = await createMediaFile(userDataPath, "present.png");
    const other = await createMediaFile(userDataPath, "other.png");
    const store = createDesktopSettingsStore({ userDataPath });
    const initial = await store.addWallpaperCandidates([other, file]);
    const notifications: WallpaperLibrary[] = [];
    store.subscribeWallpaperLibrary((library) => notifications.push(library));
    const imported = await store.importLegacyWallpaper(file, null);
    expect(imported.candidateId).toBe(initial.added[1]!.candidateId);
    expect(imported.library).toEqual(initial.library);
    expect(notifications).toEqual([]);
    expect(
      await createDesktopSettingsStore({ userDataPath }).importLegacyWallpaper(other, null),
    ).toEqual(imported);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object document", "null"],
    ["null library", JSON.stringify({ wallpaperLibrary: null })],
    ["bad revision", JSON.stringify({ wallpaperLibrary: { version: 1, revision: -1, items: [] } })],
    [
      "bad item",
      JSON.stringify({
        wallpaperLibrary: { version: 1, revision: 1, items: [{ candidateId: "invalid" }] },
      }),
    ],
    ["malformed migrations", JSON.stringify({ migrations: [] })],
    ["invalid binding", JSON.stringify({ migrations: { wallpaperImported: false } })],
    [
      "invalid binding identity",
      JSON.stringify({
        migrations: { wallpaperImported: { candidateId: "invalid", reason: null } },
      }),
    ],
  ])("rejects %s without replacing it during reads or any migration", async (_label, raw) => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = settingsFilePath(userDataPath);
    await writeFile(file, raw);
    const core: WallpaperLibrary[] = [];
    const store = createDesktopSettingsStore({
      userDataPath,
      onWallpaperLibraryCommitted: (library) => {
        core.push(library);
      },
    });
    await expect(store.getWallpaperLibrary()).rejects.toThrow();
    await expect(store.migrateLegacyRendererSettings({ releaseChannel: "beta" })).rejects.toThrow();
    await expect(store.importLegacyWallpaper(null, null)).rejects.toThrow();
    await expect(store.addWallpaperCandidates([])).rejects.toThrow();
    await expect(store.removeWallpaperCandidates([])).rejects.toThrow();
    await expect(store.patch({ notifications: { playSound: false } })).rejects.toThrow();
    expect(core).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readdir(userDataPath)).toEqual(["desktop-settings.json"]);
  });

  it.each(["identity", "path"])(
    "rejects duplicate candidate %s without overwriting the library",
    async (field) => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      const first = await createMediaFile(userDataPath, "first.png");
      const second = await createMediaFile(userDataPath, "second.png");
      const store = createDesktopSettingsStore({ userDataPath });
      await store.addWallpaperCandidates([first, second]);
      const file = settingsFilePath(userDataPath);
      const document = JSON.parse(await readFile(file, "utf8"));
      const key = field === "identity" ? "candidateId" : "path";
      document.wallpaperLibrary.items[1][key] = document.wallpaperLibrary.items[0][key];
      const raw = JSON.stringify(document);
      await writeFile(file, raw);
      const restarted = createDesktopSettingsStore({ userDataPath });
      await expect(restarted.getWallpaperLibrary()).rejects.toThrow();
      await expect(restarted.migrateLegacyRendererSettings({})).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(raw);
    },
  );

  it.each(["library", "migration binding"])(
    "keeps read-only desktop preferences available when wallpaper %s is damaged",
    async (damagedPart) => {
      const userDataPath = await createTempUserDataDir();
      directories.add(userDataPath);
      const file = settingsFilePath(userDataPath);
      const raw = JSON.stringify({
        version: 1,
        settings: {
          releaseChannel: "beta",
          notifications: { playSound: false },
          daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
        },
        migrations: {
          daemonStopOnQuitDefaultApplied: true,
          ...(damagedPart === "migration binding" ? { wallpaperImported: false } : {}),
        },
        ...(damagedPart === "library"
          ? { wallpaperLibrary: { version: 1, revision: -1, items: [] } }
          : {}),
      });
      await writeFile(file, raw);
      const store = createDesktopSettingsStore({ userDataPath });
      expect(await store.get()).toMatchObject({
        releaseChannel: "beta",
        notifications: { playSound: false },
        daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
      });
      await expect(store.getWallpaperLibrary()).rejects.toThrow();
      await expect(store.patch({ notifications: { playSound: true } })).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(raw);
    },
  );

  it("propagates non-ENOENT reads rather than treating an unreadable document as first launch", async () => {
    const userDataPath = await createTempUserDataDir();
    directories.add(userDataPath);
    const file = settingsFilePath(userDataPath);
    await mkdir(file);
    await writeFile(path.join(file, "sentinel"), "unchanged");
    const store = createDesktopSettingsStore({ userDataPath });
    await expect(store.get()).rejects.toThrow();
    await expect(store.migrateLegacyRendererSettings({ releaseChannel: "beta" })).rejects.toThrow();
    await expect(store.importLegacyWallpaper(null, null)).rejects.toThrow();
    expect(await readFile(path.join(file, "sentinel"), "utf8")).toBe("unchanged");
    expect(await readdir(userDataPath)).toEqual(["desktop-settings.json"]);
  });
});
