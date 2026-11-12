const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const ADDON_PACKAGES = new Set(["plugin-desktop-pet", "plugin-wallpaper", "plugin-agent-speed", "plugin-qqbot"]);
const RETIRED_PLUGIN_MODULES = new Set(["builtin-descriptors.js", "image-converter.js", "records.js"]);
const FIXTURE_ID = "folder-smoke";

function legacyDaemonSource(daemonHome) {
  return { source: "directory", path: path.join(daemonHome, "legacy-bundled-qqbot"), enabled: true, bundled: true, installed: true, approval: { trusted: true, version: "0.7.0", capabilities: [] } };
}

function resourceDirectory(appPath) {
  return process.platform === "darwin" ? path.join(appPath, "Contents", "Resources") : path.join(appPath, "resources");
}

function assertNoPackagedAddons(appPath) {
  const resources = resourceDirectory(appPath);
  const forbidden = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const parent = path.basename(directory);
      const addon = ADDON_PACKAGES.has(entry.name) || (parent === "@omp-desktop" && entry.name.startsWith("plugin-"));
      const petAsset = entry.name === "pets" && (parent === "assets" || parent === "dist");
      const retiredModule = parent === "plugins" && RETIRED_PLUGIN_MODULES.has(entry.name);
      if (addon || petAsset || retiredModule || entry.name === "hatch-pet" || entry.name === "pet-creation") forbidden.push(path.relative(resources, file));
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(resources);
  assert.deepEqual(forbidden, [], "The real package must not contain specific addons, pet assets or the pet skill");
  assert.ok(fs.existsSync(path.join(resources, "app", "node_modules", "@omp-desktop", "plugin", "package.json")), "The real generic plugin SDK must remain packaged");
}

function seedLegacyPluginProfile(userData, daemonHome) {
  const installations = ["desktop-pet", "wallpaper", "agent-speed"].map((id) => ({
    id, packageId: id, owner: "desktop", version: "0.7.0", generation: 7, enabled: true, installed: true,
    source: { type: "builtin", identity: `builtin:${id}` }, trusted: true,
    config: id === "desktop-pet" ? { size: "large", selectedId: "iris", position: { x: 12, y: 34 } } : id === "wallpaper" ? { source: "url", candidateId: null, url: "http://127.0.0.1:1/legacy-must-not-load.png", opacity: 0.7 } : {},
    declaredCapabilities: [], grantedCapabilities: [], revision: 0, migrationVersion: 1, format: "builtin", metadata: null,
  }));
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "desktop-settings.json"), JSON.stringify({
    version: 1, settings: { pet: { enabled: true, selectedId: "iris", size: "large", position: null } },
    plugins: { revision: 4, backgroundProvider: { installationId: "wallpaper", extensionId: "wallpaper" }, backgroundSelectionEdited: false, installations },
    migrations: { daemonStopOnQuitDefaultApplied: true },
  }));
  const source = legacyDaemonSource(daemonHome);
  fs.mkdirSync(source.path, { recursive: true });
  fs.writeFileSync(path.join(source.path, "package.json"), JSON.stringify({ name: "legacy-qqbot", version: "0.7.0", ompDesktop: { apiVersion: 1, id: "qqbot", owner: "daemon", entries: { service: "./service.mjs" }, capabilities: [] } }));
  const marker = path.join(daemonHome, "legacy-qqbot-must-not-execute");
  fs.writeFileSync(path.join(source.path, "service.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "legacy module executed"); export default function setup() { writeFileSync(${JSON.stringify(marker)}, "legacy service executed"); }`);
  const configFile = path.join(daemonHome, "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, pluginsEnabled: true, plugins: { ...config.plugins, qqbot: source } }));
  return installations;
}

async function waitFor(label, predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function openPluginSettings(page) {
  await waitFor("real settings navigation control", () => page.evaluate(() => !!document.querySelector('[data-testid="sidebar-settings"]')));
  await click(page, '[data-testid="sidebar-settings"]');
  await waitFor("real settings sidebar", () => page.evaluate(() => !!document.querySelector('[data-testid="settings-sidebar"]')));
  const selected = await page.evaluate(() => {
    const buttons = document.querySelector('[data-testid="settings-sidebar"]').querySelectorAll('[role="button"], button');
    const button = Array.from(buttons).find((button) => !button.getAttribute("data-testid")?.startsWith("settings-host-section-") && /^(Plugins|插件)$/.test(button.textContent?.trim() ?? ""));
    if (!button) return false;
    button.click();
    return true;
  });
  assert.equal(selected, true, "The application Plugins settings control must exist");
  await waitFor("real plugin settings screen", () => page.evaluate(() => !!document.querySelector('[data-testid="plugins-manager"]')));
}

async function click(page, selector) {
  const clicked = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element || element.getAttribute("aria-disabled") === "true" || element.disabled) return false;
    element.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `Actual UI control must be available: ${selector}`);
}

function createFixture(directory) {
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: FIXTURE_ID, version: "1.0.0", ompDesktop: { apiVersion: 1, id: FIXTURE_ID, owner: "desktop", entries: { client: "./client.mjs", service: "./service.mjs" }, capabilities: ["ui.settings", "files.scoped"] },
  }));
  fs.writeFileSync(path.join(directory, "service.mjs"), `
import { defineRpc } from "@omp-desktop/plugin/server";
import { z } from "zod";
const readout = defineRpc({ name: "smoke.readout", input: z.object({}), output: z.object({ installationId: z.string(), generation: z.number(), calls: z.number() }) });
export default async function setup(ctx) {
  let calls = 0;
  await ctx.native.invoke("files.writeText", { path: "activated.json", text: JSON.stringify({ installationId: ctx.installation.id, generation: ctx.installation.generation, role: ctx.role }) });
  ctx.handle(readout, () => ({ installationId: ctx.installation.id, generation: ctx.installation.generation, calls: ++calls }));
}
`);
  fs.writeFileSync(path.join(directory, "client.mjs"), `
import React from "react";
import { defineRpc } from "@omp-desktop/plugin";
import { z } from "zod";
const readout = defineRpc({ name: "smoke.readout", input: z.object({}), output: z.object({ installationId: z.string(), generation: z.number(), calls: z.number() }) });
export default function setup(ctx) {
  function Settings() {
    const [result, setResult] = React.useState(null);
    const [error, setError] = React.useState("");
    return React.createElement("div", { "data-testid": "folder-smoke-contribution" },
      React.createElement("span", { "data-testid": "folder-smoke-mode" }, "Folder client " + ctx.mode),
      React.createElement("button", { "data-testid": "folder-smoke-rpc", onClick: async () => { try { setResult(await ctx.rpc(readout, {})); } catch (failure) { setError(String(failure)); } } }, "Run real folder RPC"),
      React.createElement("output", { "data-testid": "folder-smoke-result" }, result ? JSON.stringify(result) : error));
  }
  ctx.addSettingsPage({ id: "readout", title: "Folder smoke readout", Component: Settings });
}
`);
}

async function smokeFolderPlugin({ page, appPath, env, legacyRecords = [], checkDaemonPlugins }) {
  const initial = await page.evaluate(() => window.paseoDesktop.plugins.getSnapshot());
  assert.deepEqual(initial.installations, [], "No addon may appear before a folder installation, including legacy records");
  assert.equal(initial.backgroundProvider, null);
  if (checkDaemonPlugins) assert.deepEqual(await checkDaemonPlugins(), [], "New daemon registry must start empty");
  if (legacyRecords.length) {
    const rejected = await page.evaluate(async () => {
      try { await window.paseoDesktop.plugins.patch({ installationId: "desktop-pet", expectedRevision: 0, patch: { enabled: true } }); return false; }
      catch (error) { return /Legacy bundled/.test(String(error)); }
    });
    assert.equal(rejected, true, "A direct legacy activation request must fail explicitly");
    for (const record of legacyRecords) assert.equal(fs.existsSync(path.join(env.OMP_ELECTRON_USER_DATA_DIR, "desktop-plugins", "data", record.id)), false, "Legacy records must not acquire native execution resources");
    const daemonConfig = JSON.parse(fs.readFileSync(path.join(env.PASEO_HOME, "config.json"), "utf8"));
    assert.deepEqual(daemonConfig.plugins.qqbot, legacyDaemonSource(env.PASEO_HOME), "Enabled legacy QQ source and trust data must remain intact");
    assert.equal(fs.existsSync(path.join(env.PASEO_HOME, "legacy-qqbot-must-not-execute")), false, "Legacy QQ source must never be evaluated or executed");
  }
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-external-folder-smoke-")));
  const relative = path.relative(path.resolve(appPath), directory);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Fixture source must be outside the packaged application");
  createFixture(directory);
  const activation = path.join(env.OMP_ELECTRON_USER_DATA_DIR, "desktop-plugins", "data", FIXTURE_ID, "files", "activated.json");
  try {
    await openPluginSettings(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid^="plugin-row-local:"]').length), 0, "Settings must not display legacy plugin rows");
    const discovery = await page.evaluate(() => {
      const manager = document.querySelector('[data-testid="plugins-manager"]');
      const buttons = manager?.querySelectorAll('button, [role="button"]');
      const button = buttons?.[1];
      if (!button) return false;
      button.click(); return true;
    });
    assert.equal(discovery, true, "Actual Discover control must be present");
    await waitFor("folder installation form", () => page.evaluate(() => !!document.querySelector('[data-testid="plugins-install-directory"]')));
    await page.evaluate((directory) => {
      const input = document.querySelector('[data-testid="plugins-install-directory"]');
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
      setter.call(input, directory);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: directory }));
    }, directory);
    await waitFor("enabled inspection control", () => page.evaluate(() => { const button = document.querySelector('[data-testid="plugins-inspect-and-install"]'); return button && !button.disabled && button.getAttribute("aria-disabled") !== "true"; }));
    await click(page, '[data-testid="plugins-inspect-and-install"]');
    await waitFor("real source trust confirmation", () => page.evaluate(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]')));
    await click(page, '[data-testid="confirm-dialog-confirm"]');
    const rowSelector = `[data-testid="plugin-row-local:${FIXTURE_ID}"]`;
    let installationState;
    try {
      await waitFor("actual installed folder row", async () => {
        installationState = await page.evaluate(async (selector) => {
          const manager = document.querySelector('[data-testid="plugins-manager"]');
          return { row: !!document.querySelector(selector), alerts: Array.from(manager?.querySelectorAll('[role="alert"]') ?? []).map((alert) => alert.textContent?.trim()).filter(Boolean), manager: manager?.textContent, snapshot: await window.paseoDesktop.plugins.getSnapshot(), confirmation: document.querySelector('[data-testid="confirm-dialog"]')?.textContent };
        }, rowSelector);
        if (installationState.alerts.length) throw new Error(`Folder installation UI alert: ${installationState.alerts.join("; ")}`);
        return installationState.row;
      });
    } catch (error) {
      throw new Error(`${error.message}\nActual installation state: ${JSON.stringify(installationState)}`, { cause: error });
    }
    const installed = (await page.evaluate(() => window.paseoDesktop.plugins.getSnapshot())).installations.find(({ id }) => id === FIXTURE_ID);
    assert.ok(installed?.installed && installed.trusted && !installed.enabled && installed.source.type === "local");
    assert.equal(fs.realpathSync(installed.source.identity), directory);
    assert.equal(fs.existsSync(activation), false, "Installation must not start the service until enabled");
    await click(page, `${rowSelector} [role="switch"]`);
    const active = await waitFor("actual folder service activation", async () => {
      const snapshot = await page.evaluate(() => window.paseoDesktop.plugins.getSnapshot());
      const record = snapshot.installations.find(({ id }) => id === FIXTURE_ID);
      if (record?.status === "failed") throw new Error(record.error);
      return record?.enabled && record.status === "active" ? record : null;
    });
    await waitFor("real worker activation file", () => fs.existsSync(activation));
    assert.deepEqual(JSON.parse(fs.readFileSync(activation, "utf8")), { installationId: FIXTURE_ID, generation: active.generation, role: "service" });
    await click(page, `${rowSelector} [role="button"], ${rowSelector} button`);
    await waitFor("registered client settings contribution", () => page.evaluate(() => document.querySelector('[data-testid="folder-smoke-mode"]')?.textContent === "Folder client active"));
    await click(page, '[data-testid="folder-smoke-rpc"]');
    const result = await waitFor("real client-to-worker RPC result", () => page.evaluate(() => {
      const text = document.querySelector('[data-testid="folder-smoke-result"]')?.textContent;
      if (!text) return null;
      return JSON.parse(text);
    }));
    assert.deepEqual(result, { installationId: FIXTURE_ID, generation: active.generation, calls: 1 });
    const persisted = JSON.parse(fs.readFileSync(path.join(env.OMP_ELECTRON_USER_DATA_DIR, "desktop-settings.json"), "utf8"));
    assert.deepEqual(persisted.plugins.installations.filter(({ source }) => source.type === "builtin"), legacyRecords, "Existing legacy records/configuration must be retained without activation");
    assert.ok(persisted.plugins.installations.some(({ id, enabled, source }) => id === FIXTURE_ID && enabled && source.type === "local"));
    if (legacyRecords.length) {
      assert.deepEqual(persisted.settings.pet, { enabled: true, selectedId: "iris", size: "large", position: null }, "Original legacy pet configuration must remain intact");
      assert.equal(fs.existsSync(path.join(env.PASEO_HOME, "legacy-qqbot-must-not-execute")), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.PASEO_HOME, "config.json"), "utf8")).plugins.qqbot, legacyDaemonSource(env.PASEO_HOME));
    }
    const rowText = await page.evaluate((selector) => document.querySelector(selector)?.textContent, rowSelector);
    assert.ok(rowText?.includes(FIXTURE_ID) && rowText.includes(directory), "The real settings row must display the external source");
    await click(page, `${rowSelector} [role="switch"]`);
    await waitFor("explicit folder service disable", async () => {
      const snapshot = await page.evaluate(() => window.paseoDesktop.plugins.getSnapshot());
      return snapshot.installations.some(({ id, enabled, status }) => id === FIXTURE_ID && !enabled && status === "disabled");
    });
    return { profile: legacyRecords.length ? "legacy" : "fresh", installed: FIXTURE_ID, source: directory, worker: result, settingsRow: rowText };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { assertNoPackagedAddons, seedLegacyPluginProfile, smokeFolderPlugin };
