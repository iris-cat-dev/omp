import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { isPluginReleaseOperation, type PluginActivationScope, type PluginNativeApi, type PluginNativeOverlayRequest, type PluginNativeOverlayLease, type PluginNativeOverlayWireRequest } from "@omp-desktop/plugin/server";
import { LocalPluginActionSchema, LocalPluginInvocationSchema, LocalPluginPatchSchema, LocalPluginSelectionSchema, LocalPluginDirectoryInstallSchema, LocalPluginRecordSchema, LocalPluginClientScopeSchema, type LocalPluginRecord, type LocalPluginSnapshot, type LocalPluginDirectoryInstall } from "@omp-desktop/protocol/desktop-local-plugins";
import { isWallpaperCommand, type WallpaperCommand } from "@omp-desktop/protocol/desktop-wallpaper";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { getMainWindows, getMainWindowDocumentVersion, isMainWindowSender, onMainWindowRemoved, selectMainWindow } from "../window/main-windows.js";
import { wallpaperMediaRegistry, type WallpaperDocumentOwner } from "../wallpaper/media-registry.js";
import { createWallpaperCommandHandler } from "../wallpaper/commands.js";
import { getCommittedWallpaperDocumentIdentity } from "../wallpaper/media-request-authorization.js";
import { WallpaperError } from "../wallpaper/files.js";
import { LocalPluginRuntime } from "./local-runtime.js";
import { acquireNativeOverlay, getNativeOverlayDocument, NATIVE_OVERLAY_CSP } from "./native-overlay.js";
import { inspectLocalPluginDirectory, loadExternalLocalPlugin, type LocalPluginWorkerBridge } from "./external-plugins.js";
import { LocalPluginLogs } from "./logs.js";
import { LocalPluginSecrets, LocalPluginSecretRequestSchema } from "./secrets.js";
import { registerPluginNativeMenu, unregisterPluginNativeMenu, revokePluginNativeMenus, releasePluginDocumentMenus, releasePluginClientMenus } from "./native-menu.js";
import { LocalPluginClientScopes, type ClientScopeBinding } from "./client-scopes.js";

interface Navigation { openApp(): void | Promise<void>; openAgent(target: { serverId: string; agentId: string }): void | Promise<void>; startupBarrier: Promise<void> }
let navigation: Navigation | undefined;
let runtime: LocalPluginRuntime | undefined;
let initializing: Promise<void> | undefined;
let logs: LocalPluginLogs | undefined;
let secrets: LocalPluginSecrets | undefined;
const events = new Map<string, Set<(payload: unknown) => void>>();
const wireOverlays = new Map<string, { installationId: string; generation: number; lease: PluginNativeOverlayLease }>();
function emit(event: string, payload: unknown): void { for (const listener of events.get(event) ?? []) listener(payload); }
function subscribe(event: string, listener: (payload: unknown) => void): () => void { const listeners = events.get(event) ?? new Set(); listeners.add(listener); events.set(event, listeners); return () => { listeners.delete(listener); }; }
const mediaClientOwners = new WeakMap<WallpaperDocumentOwner, Map<string, ClientScopeBinding>>();
const clientScopes = new LocalPluginClientScopes((binding) => {
  releasePluginClientMenus(binding);
  const window = getMainWindows().find((window) => window.webContents.id === binding.senderId);
  const owner = window ? wallpaperMediaRegistry.getOwner(window.webContents) : null;
  if (owner) {
    const ownership = mediaClientOwners.get(owner);
    for (const purpose of binding.revisions.keys()) {
      const key = JSON.stringify([binding.installationId, binding.generation, purpose]);
      if (ownership?.get(key) === binding) { ownership.delete(key); wallpaperMediaRegistry.releasePluginDocument(owner, binding.installationId, binding.generation, purpose); }
    }
  }
  emit(`client:${binding.installationId}:released`, binding.senderId);
});
function pluginLogs(): LocalPluginLogs { logs ??= new LocalPluginLogs(app.getPath("userData")); return logs; }
function pluginSecrets(): LocalPluginSecrets { secrets ??= new LocalPluginSecrets(app.getPath("userData")); return secrets; }
export function getLocalPluginRuntime(): LocalPluginRuntime {
  runtime ??= new LocalPluginRuntime(getDesktopSettingsStore(), serviceNative, (record, scope) => loadExternalLocalPlugin(record, scope, {
    logs: pluginLogs(), hostCall: workerHostCall, subscribe,
    fail: (id, generation, message) => getLocalPluginRuntime().fail(id, generation, message),
    waiting: (id, generation, reason) => getLocalPluginRuntime().waiting(id, generation, reason),
    clearData: (id) => pluginSecrets().clear(id),
  }), (id, message) => pluginLogs().append(id, "stderr", message));
  return runtime;
}
function requireCapability(record: LocalPluginRecord, capability: string): void { if (!record.grantedCapabilities.includes(capability)) throw new Error(`Plugin capability is not granted: ${capability}.`); }
const OpenDialogSchema = z.object({ title: z.string().optional(), directory: z.boolean().optional(), multiple: z.boolean().optional(), filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional() });
async function openPluginDialog(record: LocalPluginRecord, input: unknown, event?: IpcMainInvokeEvent) {
  requireCapability(record, "native.dialog");
  const options = OpenDialogSchema.parse(input ?? {});
  const window = selectMainWindow(event?.sender);
  if (!window) throw new Error("A main application window is required for a file dialog.");
  const result = await dialog.showOpenDialog(window, { title: options.title, filters: options.filters, properties: [options.directory ? "openDirectory" : "openFile", ...(options.multiple ? ["multiSelections" as const] : [])] });
  return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0] ?? null;
}
async function scopedFileOperation(record: LocalPluginRecord, operation: string, input: unknown) {
  requireCapability(record, "files.scoped");
  const request = z.object({ path: z.string(), text: z.string().optional() }).parse(input);
  const root = path.join(app.getPath("userData"), "desktop-plugins", "data", record.id, "files");
  const file = path.resolve(root, request.path);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("Plugin file path escapes its scope.");
  await mkdir(root, { recursive: true });
  if (operation === "files.writeText") {
    if (request.text === undefined) throw new TypeError("Writing a scoped file requires text.");
    await mkdir(path.dirname(file), { recursive: true });
    const parent = await realpath(path.dirname(file));
    const canonicalRoot = await realpath(root);
    if (parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Plugin file parent escapes its scope.");
    try { const existing = await realpath(file); if (!existing.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Plugin file escapes its scope."); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await writeFile(file, request.text, { mode: 0o600 });
    return;
  }
  const resolved = await realpath(file), canonicalRoot = await realpath(root);
  if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Plugin file escapes its scope.");
  if (operation === "files.readText") return readFile(resolved, "utf8");
  if (operation === "files.list") return readdir(resolved);
  throw new Error(`Unknown scoped file operation: ${operation}.`);
}
async function commonNativeOperation(record: LocalPluginRecord, scope: PluginActivationScope, operation: string, input: unknown) {
  scope.assertCurrent();
  if (operation === "storage.get") { const current = (await getDesktopSettingsStore().getPlugins()).installations.find(({ id }) => id === record.id)!; return { revision: current.revision, values: current.config }; }
  if (operation === "storage.patch") { const request = z.object({ expectedRevision: z.number().int().nonnegative(), patch: z.record(z.string(), z.unknown()) }).parse(input); const document = await getDesktopSettingsStore().patchPlugin({ installationId: record.id, expectedRevision: request.expectedRevision, patch: { config: request.patch } }, () => { scope.assertCurrent(); getLocalPluginRuntime().assertAuthorized(record.id, scope.generation, "manage"); }); const current = document.installations.find(({ id }) => id === record.id)!; return { revision: current.revision, values: current.config }; }
  if (operation === "secret") { requireCapability(record, "secrets.scoped"); return pluginSecrets().invoke(record.id, input, () => { scope.assertCurrent(); getLocalPluginRuntime().assertAuthorized(record.id, scope.generation, "manage"); }); }
  if (operation.startsWith("files.")) return scopedFileOperation(record, operation, input);
  if (operation === "dialog.open") return openPluginDialog(record, input);
  if (operation === "navigation.openApp" || operation === "navigation.openAgent") { requireCapability(record, "native.navigation"); if (!navigation) throw new Error("Application navigation is not ready."); return operation === "navigation.openApp" ? navigation.openApp() : navigation.openAgent(z.object({ serverId: z.string(), agentId: z.string() }).parse(input)); }
  if (operation === "plugin.setEnabled") { const { enabled } = z.object({ enabled: z.boolean() }).parse(input); const current = (await getDesktopSettingsStore().getPlugins()).installations.find(({ id }) => id === record.id)!; return getDesktopSettingsStore().patchPlugin({ installationId: record.id, expectedRevision: current.revision, patch: { enabled } }); }
  if (operation === "plugin.fail") { const { message } = z.object({ message: z.string() }).parse(input); getLocalPluginRuntime().fail(record.id, scope.generation, message); dialog.showErrorBox("Desktop plugin", message); return; }
  return getLocalPluginRuntime().invoke(record.id, scope.generation, operation, input);
}
function serviceNative(record: LocalPluginRecord, scope: PluginActivationScope): PluginNativeApi {
  return {
    async invoke<T>(operation: string, input?: unknown): Promise<T> {
      scope.assertCurrent();
      getLocalPluginRuntime().assertServiceAuthorized(record.id, scope.generation);
      let result: unknown;
      if (operation === "overlay.acquire") { requireCapability(record, "native.overlay"); const request = input as PluginNativeOverlayRequest; result = acquireNativeOverlay(request, scope, record.id); }
      else result = await commonNativeOperation(record, scope, operation, input);
      if (operation !== "plugin.setEnabled" && operation !== "plugin.fail") scope.assertCurrent();
      return result as T;
    },
    subscribe(event, listener) { scope.assertCurrent(); const key = event === "storage:changed" ? `storage:${record.id}` : event === "client:released" ? `client:${record.id}:released` : event; return scope.own(subscribe(key, (payload) => { if (!scope.signal.aborted) listener(payload); })); },
  };
}
const WireOverlaySchema: z.ZodType<PluginNativeOverlayWireRequest> = z.object({ id: z.string().min(1), html: z.string().max(1024 * 1024), width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096), position: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable(), state: z.unknown(), actionMethod: z.string().min(1), positionMethod: z.string().min(1) });
async function workerHostCall(record: LocalPluginRecord, scope: PluginActivationScope, mode: "active" | "manage", worker: LocalPluginWorkerBridge, operation: string, input: unknown): Promise<unknown> {
  if (operation === "overlay.release" && isPluginReleaseOperation(operation, input)) {
    const { leaseId } = z.object({ leaseId: z.string() }).parse(input);
    const owned = wireOverlays.get(leaseId);
    if (!owned || owned.installationId !== record.id || owned.generation !== scope.generation) throw new Error("Overlay lease does not belong to this plugin generation.");
    wireOverlays.delete(leaseId);
    owned.lease.release();
    return;
  }
  scope.assertCurrent();
  const local = getLocalPluginRuntime();
  local.assertAuthorized(record.id, scope.generation, "manage");
  if (mode === "manage" && operation === "secret" && LocalPluginSecretRequestSchema.parse(input).operation === "get") throw new Error("Management cannot read plugin secrets.");
  if (operation.startsWith("overlay.")) {
    if (mode !== "active") throw new Error("Management cannot acquire native overlay resources.");
    local.assertServiceAuthorized(record.id, scope.generation);
    requireCapability(record, "native.overlay");
    if (operation === "overlay.acquire") {
      const request = WireOverlaySchema.parse(input), leaseId = randomUUID();
      const lease = acquireNativeOverlay({ ...request, onAction: (action, value) => worker.invoke(request.actionMethod, { action, input: value }, scope.generation), onPosition: async (position) => { await worker.invoke(request.positionMethod, { position }, scope.generation); } }, scope, record.id);
      wireOverlays.set(leaseId, { installationId: record.id, generation: scope.generation, lease });
      scope.own(() => { wireOverlays.delete(leaseId); lease.release(); });
      return { leaseId };
    }
    const request = z.object({ leaseId: z.string(), update: z.object({ state: z.unknown().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable().optional() }).optional(), items: z.array(z.object({ id: z.string(), label: z.string(), type: z.literal("separator").optional() })).optional() }).parse(input);
    const owned = wireOverlays.get(request.leaseId);
    if (!owned || owned.installationId !== record.id || owned.generation !== scope.generation) throw new Error("Overlay lease does not belong to this plugin generation.");
    if (operation === "overlay.release") { wireOverlays.delete(request.leaseId); owned.lease.release(); return; }
    if (operation === "overlay.update" && request.update) { owned.lease.update(request.update); return; }
    if (operation === "overlay.menu" && request.items) { owned.lease.showMenu(request.items); return; }
    throw new Error("Invalid overlay operation.");
  }
  const manageAllowed = ["storage.get", "storage.patch", "secret", "dialog.open", "navigation.openApp", "navigation.openAgent"];
  if (mode === "manage" && !manageAllowed.includes(operation)) throw new Error("Management cannot acquire execution resources.");
  if (mode === "active" && !manageAllowed.includes(operation)) local.assertServiceAuthorized(record.id, scope.generation);
  const result = await commonNativeOperation(record, scope, operation, input);
  if (operation !== "plugin.setEnabled" && operation !== "plugin.fail") scope.assertCurrent();
  return result;
}
export interface LocalPluginAuthorization { installationId: string; generation: number; documentEpoch: number; webContentsId: number }
function requireMainFrame(event: IpcMainInvokeEvent, expectedEpoch?: number): number {
  if (!isMainWindowSender(event.sender) || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame.detached || event.senderFrame !== event.sender.mainFrame) throw new Error("Plugin operation requires a main application document.");
  const window = getMainWindows().find((window) => window.webContents === event.sender)!;
  const owner = wallpaperMediaRegistry.getOwner(event.sender);
  const committed = getCommittedWallpaperDocumentIdentity(event.sender);
  if (owner?.nativeIdentity) {
    if (!committed) throw new Error("Committed native document identity is unavailable.");
    if (committed.contentsId !== owner.nativeIdentity.contentsId || committed.frameId !== owner.nativeIdentity.frameId ||
        committed.navigationToken !== owner.nativeIdentity.navigationToken) throw new Error("Plugin document has not committed the current native owner.");
  } else if (committed) throw new Error("Plugin native document is not active.");
  const epoch = getMainWindowDocumentVersion(window);
  if (epoch === undefined || (expectedEpoch !== undefined && epoch !== expectedEpoch)) throw new Error("Plugin document was replaced.");
  return epoch;
}
export function authorizeLocalPlugin(event: IpcMainInvokeEvent, installationId: string, generation: number, purpose: "manage" | "background" | "active", capability?: string, extensionId?: string): LocalPluginAuthorization {
  const documentEpoch = requireMainFrame(event), local = getLocalPluginRuntime();
  local.assertAuthorized(installationId, generation, purpose, capability);
  if (purpose === "background" && extensionId && local.getSnapshot().backgroundProvider?.extensionId !== extensionId) throw new Error("This background extension is not selected.");
  return { installationId, generation, documentEpoch, webContentsId: event.sender.id };
}
export async function setupLocalPlugins(options: Navigation): Promise<void> {
  navigation = options;
  if (!initializing) initializing = (async () => {
    const local = getLocalPluginRuntime(), store = getDesktopSettingsStore();
    local.subscribeRevocations((id, generation) => { clientScopes.revokeInstallation(id, generation); wallpaperMediaRegistry.revokeInstallation(id, generation); revokePluginNativeMenus(id, generation); });
    let selection = (await store.getPlugins()).backgroundProvider;
    store.subscribePlugins((document) => {
      if (selection && (selection.installationId !== document.backgroundProvider?.installationId || selection.extensionId !== document.backgroundProvider?.extensionId)) { const previous = local.getSnapshot().installations.find(({ id }) => id === selection!.installationId); if (previous) wallpaperMediaRegistry.revokeBackground(previous.id, previous.generation); }
      selection = document.backgroundProvider;
      for (const record of document.installations) { emit(`storage:${record.id}`, { revision: record.revision, values: record.config }); emit(`selection:${record.id}`, selection?.installationId === record.id); }
    });
    local.subscribe((snapshot) => { for (const window of getMainWindows()) { try { if (!window.webContents.isDestroyed()) window.webContents.send("paseo:event:desktop-plugins-changed", snapshot); } catch { /* Closed documents release their own leases. */ } } });
    onMainWindowRemoved(releaseLocalPluginDocument);
    registerLocalPluginIpc();
    await local.initialize();
  })();
  return initializing;
}
export function releaseLocalPluginDocument(senderId: number): void { clientScopes.releaseDocument(senderId); releasePluginDocumentMenus(senderId); emit("window:removed", senderId); }
export function subscribeLocalPluginRevocations(listener: (id: string, generation: number) => void): () => void { return getLocalPluginRuntime().subscribeRevocations(listener); }
export async function installLocalPluginDirectory(raw: LocalPluginDirectoryInstall): Promise<LocalPluginSnapshot> {
  const input = LocalPluginDirectoryInstallSchema.parse(raw), inspected = await inspectLocalPluginDirectory(input.directory), local = getLocalPluginRuntime(), store = getDesktopSettingsStore();
  if (local.getSnapshot().revision !== input.expectedRevision) throw new Error("Plugin registry changed. Reload it before installing.");
  if (input.approval && (input.approval.version !== inspected.version || input.approval.capabilities.some((capability) => !inspected.capabilities.includes(capability)))) throw new Error("Plugin approval does not match the inspected source/version.");
  const document = await store.getPlugins();
  const record = LocalPluginRecordSchema.parse({ id: input.installationId ?? inspected.id, packageId: inspected.id, owner: "desktop", version: inspected.version, generation: 0, enabled: false, installed: true, source: { type: "local", identity: inspected.directory }, trusted: input.approval !== undefined, config: {}, declaredCapabilities: inspected.capabilities, grantedCapabilities: input.approval?.capabilities ?? [], revision: 0, migrationVersion: 1, format: inspected.format, metadata: inspected.metadata });
  await store.installPlugin(record, document.revision);
  return local.getSnapshot();
}
async function refreshDirectoryInstallation(record: LocalPluginRecord, installed: boolean) {
  const inspected = await inspectLocalPluginDirectory(record.source.identity), store = getDesktopSettingsStore();
  if (inspected.id !== record.packageId) throw new Error("Source package identity changed. Install it with a different identity.");
  const sameApproval = inspected.version === record.version && inspected.capabilities.every((capability) => record.grantedCapabilities.includes(capability));
  const document = await store.getPlugins();
  await store.installPlugin({ ...record, installed, version: inspected.version, format: inspected.format, metadata: inspected.metadata, declaredCapabilities: inspected.capabilities, grantedCapabilities: record.grantedCapabilities.filter((capability) => inspected.capabilities.includes(capability)), trusted: record.trusted && sameApproval }, document.revision);
}
let ipcRegistered = false;
function registerLocalPluginIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const wallpaperActors = new WeakMap<IpcMainInvokeEvent, ClientScopeBinding>();
  const invokeWallpaper = createWallpaperCommandHandler({ registry: wallpaperMediaRegistry, store: getDesktopSettingsStore(), getMainWindows, showOpenDialog: (window, options) => dialog.showOpenDialog(window, options), beforeAcquire: (event, request, owner, purpose) => {
    const binding = wallpaperActors.get(event);
    if (!binding) throw new Error("Wallpaper acquisition has no client activation.");
    clientScopes.assertCurrent(binding);
    const clearing = "candidateId" in request ? request.candidateId === null : request.candidateIds.length === 0;
    if (purpose === "background" && binding.mode !== "active" && !clearing) throw new WallpaperError("unauthorized", "Management cannot acquire a background lease.");
    const key = JSON.stringify([request.installationId, request.generation, purpose]);
    const ownership = mediaClientOwners.get(owner);
    if (clearing && ownership?.has(key) && ownership.get(key) !== binding) throw new WallpaperError("stale-document", "This client does not own the media holding.");
    clientScopes.acceptRevision(binding, purpose, request.revision);
    if (clearing) ownership?.delete(key);
    else { const holdings = ownership ?? new Map<string, ClientScopeBinding>(); holdings.set(key, binding); mediaClientOwners.set(owner, holdings); }
    return wallpaperMediaRegistry.nextPluginDocumentRevision(owner, request.installationId, request.generation, purpose);
  } });
  ipcMain.handle("omp:plugins:bind", (event) => ({ documentEpoch: requireMainFrame(event) }));
  ipcMain.handle("omp:plugins:openClientScope", async (event, raw) => { const input = LocalPluginClientScopeSchema.parse(raw); requireMainFrame(event, input.documentEpoch); await initializing; requireMainFrame(event, input.documentEpoch); getLocalPluginRuntime().assertAuthorized(input.installationId, input.generation, input.mode === "active" ? "active" : "manage"); clientScopes.open(input, event.sender.id); });
  ipcMain.handle("omp:plugins:releaseClientScope", (event, raw) => { const input = LocalPluginClientScopeSchema.omit({ mode: true }).parse(raw); requireMainFrame(event, input.documentEpoch); clientScopes.close(input, event.sender.id); });
  ipcMain.handle("omp:plugins:startup-ready", async (event) => { const epoch = requireMainFrame(event); await initializing; await navigation!.startupBarrier; requireMainFrame(event, epoch); getLocalPluginRuntime().startupReady(); });
  ipcMain.handle("omp:plugins:get", async (event) => { requireMainFrame(event); await initializing; return getLocalPluginRuntime().getSnapshot(); });
  ipcMain.handle("omp:plugins:patch", async (event, raw) => { requireMainFrame(event); await initializing; await getDesktopSettingsStore().patchPlugin(LocalPluginPatchSchema.parse(raw)); return getLocalPluginRuntime().getSnapshot(); });
  ipcMain.handle("omp:plugins:inspectDirectory", async (event, raw) => { requireMainFrame(event); return inspectLocalPluginDirectory(z.object({ directory: z.string() }).parse(raw).directory); });
  ipcMain.handle("omp:plugins:installDirectory", async (event, raw) => { requireMainFrame(event); await initializing; return installLocalPluginDirectory(LocalPluginDirectoryInstallSchema.parse(raw)); });
  ipcMain.handle("omp:plugins:getLogs", async (event, raw) => { requireMainFrame(event); const { installationId } = z.object({ installationId: z.string() }).parse(raw); if (!getLocalPluginRuntime().getSnapshot().installations.some(({ id }) => id === installationId)) throw new Error("Plugin is not installed."); return pluginLogs().get(installationId); });
  ipcMain.handle("omp:plugins:selectBackground", async (event, raw) => { requireMainFrame(event); await initializing; const input = LocalPluginSelectionSchema.parse(raw), local = getLocalPluginRuntime(); if (local.getSnapshot().revision !== input.expectedRevision) throw new Error("Plugin registry changed."); const document = await getDesktopSettingsStore().getPlugins(); await getDesktopSettingsStore().selectPluginBackground(input.provider, document.revision); return local.getSnapshot(); });
  for (const action of ["reload", "remove", "reinstall", "clearData"] as const) ipcMain.handle(`omp:plugins:${action}`, async (event, raw) => {
    requireMainFrame(event); await initializing;
    const input = LocalPluginActionSchema.parse(raw), local = getLocalPluginRuntime(), store = getDesktopSettingsStore();
    const record = local.getSnapshot().installations.find(({ id }) => id === input.installationId);
    if (!record || record.revision !== input.expectedRevision) throw new Error("Plugin installation changed.");
    if (action === "reload") {
      await local.suspend(record.id);
      try { if (record.source.type === "local") await refreshDirectoryInstallation(record, record.installed); await local.reload(record.id); }
      catch (error) { local.fail(record.id, record.generation, error instanceof Error ? error.message : String(error)); throw error; }
    } else if (action === "clearData") {
      await local.suspend(record.id); await local.clearData(record.id); await pluginSecrets().clear(record.id);
      const current = (await store.getPlugins()).installations.find(({ id }) => id === record.id)!;
      await store.resetPluginConfiguration(record.id, {}, current.revision);
    } else if (action === "reinstall" && record.source.type === "local") await refreshDirectoryInstallation({ ...record, enabled: false }, true);
    else await store.setPluginInstalled(record.id, action === "reinstall", record.revision);
    return local.getSnapshot();
  });
  ipcMain.handle("omp:plugins:invoke", async (event, raw) => {
    const input = LocalPluginInvocationSchema.parse(raw), epoch = requireMainFrame(event, input.documentEpoch), local = getLocalPluginRuntime();
    const binding = clientScopes.accept(input, event.sender.id);
    try {
      const record = local.assertAuthorized(input.installationId, input.generation, "manage");
      const authorizeCommit = () => { requireMainFrame(event, epoch); clientScopes.assertCurrent(binding); local.assertAuthorized(record.id, input.generation, "manage"); };
      if (input.method.startsWith("wallpaper:")) requireCapability(record, "wallpaper.media");
      if (input.method === "menu.register" && binding.mode !== "active") throw new Error("Management cannot acquire plugin execution resources.");
      let result: unknown;
      if (input.method.startsWith("overlay.")) throw new Error("Native overlays are owned by the active Desktop service.");
      if (input.method === "dialog.open") result = await openPluginDialog(record, input.input, event);
      else if (input.method === "menu.register") result = registerPluginNativeMenu(event, binding, input.input, local);
      else if (input.method === "menu.unregister") result = unregisterPluginNativeMenu(event, binding, input.input);
      else if (["secrets.configured", "secrets.set", "secrets.delete"].includes(input.method)) { requireCapability(record, "secrets.scoped"); const request = z.object({ key: z.string(), value: z.string().optional() }).parse(input.input); result = await pluginSecrets().invoke(record.id, { ...request, operation: input.method.slice("secrets.".length) }, authorizeCommit); }
      else if (input.method === "storage.get") result = { revision: record.revision, values: record.config };
      else if (input.method === "storage.patch") { const request = z.object({ patch: z.record(z.string(), z.unknown()), expectedRevision: z.number().int().nonnegative() }).parse(input.input); const document = await getDesktopSettingsStore().patchPlugin({ installationId: record.id, expectedRevision: request.expectedRevision, patch: { config: request.patch } }, authorizeCommit); const updated = document.installations.find(({ id }) => id === record.id)!; result = { revision: updated.revision, values: updated.config }; }
      else if (input.method === "secret") { requireCapability(record, "secrets.scoped"); if (LocalPluginSecretRequestSchema.parse(input.input).operation === "get") throw new Error("Renderer clients cannot read plugin secrets."); result = await pluginSecrets().invoke(record.id, input.input, authorizeCommit); }
      else if (input.method === "wallpaper:selection") result = local.getSnapshot().backgroundProvider?.installationId === record.id && local.getSnapshot().backgroundProvider?.extensionId === "wallpaper";
      else if (input.method.startsWith("wallpaper:")) {
        const command = input.method.slice("wallpaper:".length);
        if (!isWallpaperCommand(command)) throw new Error("Unknown wallpaper command.");
        const request = z.record(z.string(), z.unknown()).parse(input.input ?? {});
        wallpaperActors.set(event, binding);
        try { result = await invokeWallpaper(event, command as WallpaperCommand, { ...request, installationId: record.id, generation: input.generation }); }
        finally { wallpaperActors.delete(event); }
      } else result = await local.invoke(record.id, input.generation, input.method, input.input);
      requireMainFrame(event, epoch);
      clientScopes.assertCurrent(binding);
      local.assertAuthorized(record.id, input.generation, "manage");
      return result;
    } finally { clientScopes.finish(binding); }
  });
}
export function createLocalPluginCommandHandlers() { return { get_desktop_plugins: () => getLocalPluginRuntime().getSnapshot(), patch_desktop_plugin: async (raw: unknown) => { await getDesktopSettingsStore().patchPlugin(LocalPluginPatchSchema.parse(raw)); return getLocalPluginRuntime().getSnapshot(); } }; }
export function requireLocalPluginCommandDocument(event: IpcMainInvokeEvent): void { requireMainFrame(event); }
export async function handleLocalPluginResource(hostname: string, pathname: string): Promise<Response | null> {
  if (hostname === "overlay" && pathname.startsWith("/plugin-overlay/")) {
    const html = getNativeOverlayDocument(pathname);
    return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": NATIVE_OVERLAY_CSP } }) : new Response("Not found", { status: 404 });
  }
  if (pathname.startsWith("/plugin-overlay/")) return new Response("Not found", { status: 404 });
  return null;
}
