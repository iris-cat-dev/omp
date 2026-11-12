import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPluginClientScopes, type ClientScopeBinding } from "./client-scopes.js";
import type { LocalPluginRuntime } from "./local-runtime.js";
import { registerPluginNativeMenu, unregisterPluginNativeMenu, releasePluginClientMenus, releasePluginDocumentMenus, revokePluginNativeMenus } from "./native-menu.js";

const host = vi.hoisted(() => ({ windows: [] as BrowserWindow[], selected: null as BrowserWindow | null, epochs: new Map<BrowserWindow, number>(), contributions: new Map<string, () => Electron.MenuItemConstructorOptions[]>() }));
vi.mock("../features/menu.js", () => ({ registerApplicationMenuContribution: (id: string, items: () => Electron.MenuItemConstructorOptions[]) => { host.contributions.set(id, items); return () => { host.contributions.delete(id); }; } }));
vi.mock("../window/main-windows.js", () => ({ getMainWindows: () => host.windows, selectMainWindow: () => host.selected, getMainWindowDocumentVersion: (window: BrowserWindow) => host.epochs.get(window) }));
beforeEach(() => { host.windows.length = 0; host.selected = null; host.epochs.clear(); host.contributions.clear(); });
afterEach(() => { for (const window of host.windows) releasePluginDocumentMenus(window.webContents.id); });
function fixture() {
  const send = vi.fn();
  const frame = { send } as unknown as WebFrameMain;
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents } as unknown as BrowserWindow;
  host.windows.push(window); host.selected = window; host.epochs.set(window, 7);
  const scopes = new LocalPluginClientScopes(releasePluginClientMenus);
  const input = { installationId: "custom-installation", generation: 3, documentEpoch: 7, clientActivationId: "old-client", mode: "active" as const };
  scopes.open(input, contents.id);
  const binding = scopes.accept(input, contents.id); scopes.finish(binding);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const assertAuthorized = vi.fn();
  const runtime = { assertAuthorized } as unknown as LocalPluginRuntime;
  const register = (current: ClientScopeBinding = binding) => registerPluginNativeMenu(event, current, { items: [{ id: "open", title: "Open" }] }, runtime);
  return { window, contents, event, scopes, input, binding, frame, send, assertAuthorized, register };
}
function click(leaseId: string): () => void { return host.contributions.get(leaseId)!()[0]!.click as () => void; }
describe("native plugin menus", () => {
  it("delivers an action to the exact renderer frame and client activation", () => {
    const f = fixture(); const lease = f.register(); click(lease.leaseId)();
    expect(f.send).toHaveBeenCalledWith("paseo:event:plugin-menu-action", { installationId: f.input.installationId, generation: 3, clientActivationId: "old-client", actionId: "open" });
    expect(f.assertAuthorized).toHaveBeenLastCalledWith(f.input.installationId, 3, "active", "ui.menu");
  });
  it("never dispatches a retained menu callback after a replacement client activates", () => {
    const f = fixture(); const old = f.register(); const oldClick = click(old.leaseId);
    f.scopes.close(f.input, f.contents.id);
    const next = { ...f.input, clientActivationId: "new-client" };
    f.scopes.open(next, f.contents.id); const binding = f.scopes.accept(next, f.contents.id); f.scopes.finish(binding);
    const replacement = f.register(binding); oldClick();
    expect(f.send).not.toHaveBeenCalled(); click(replacement.leaseId)();
    expect(f.send).toHaveBeenCalledWith("paseo:event:plugin-menu-action", expect.objectContaining({ clientActivationId: "new-client" }));
  });
  it("rejects wrong frame, document epoch and installation lease cleanup", () => {
    const f = fixture(); const lease = f.register();
    expect(() => registerPluginNativeMenu({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, f.binding, { items: [] }, { assertAuthorized: f.assertAuthorized } as unknown as LocalPluginRuntime)).toThrow("current plugin client document");
    expect(() => unregisterPluginNativeMenu(f.event, { ...f.binding, installationId: "other" }, lease)).toThrow("does not belong");
    expect(() => unregisterPluginNativeMenu(f.event, { ...f.binding, clientActivationId: "other-client" }, lease)).toThrow("does not belong");
    host.epochs.set(f.window, 8);
    expect(() => unregisterPluginNativeMenu(f.event, f.binding, lease)).toThrow("current plugin client document");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects retained callbacks after frame replacement, focus change or generation revocation", () => {
    const f = fixture(); const lease = f.register(); const invoke = click(lease.leaseId);
    f.contents.mainFrame = {} as WebFrameMain; invoke(); expect(f.send).not.toHaveBeenCalled();
    f.contents.mainFrame = f.frame; host.selected = null; invoke(); expect(f.send).not.toHaveBeenCalled();
    host.selected = f.window; f.assertAuthorized.mockImplementation(() => { throw new Error("generation revoked"); }); invoke(); expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects retained callbacks after document epoch changes or exact frame detachment", () => {
    const f = fixture(); const lease = f.register(); const invoke = click(lease.leaseId);
    host.epochs.set(f.window, 8); invoke(); expect(f.send).not.toHaveBeenCalled();
    expect(host.contributions.get(lease.leaseId)!()).toEqual([]);
    host.epochs.set(f.window, 7);
    Object.assign(f.frame, { detached: true }); invoke(); expect(f.send).not.toHaveBeenCalled();
    expect(() => f.register()).toThrow("current plugin client document");
  });
  it("cannot acquire execution resources for management or a revoked installation generation", () => {
    const f = fixture();
    expect(() => f.register({ ...f.binding, mode: "manage" })).toThrow("Management cannot acquire");
    f.assertAuthorized.mockImplementation(() => { throw new Error("installation removed"); });
    expect(() => f.register()).toThrow("installation removed");
    expect(host.contributions.size).toBe(0);
  });
  it("revokes retained installation callbacks without removing another installation or its replacement generation", () => {
    const f = fixture(); const old = f.register(); const oldClick = click(old.leaseId);
    const nextInput = { ...f.input, generation: 4, clientActivationId: "replacement-installation" };
    f.scopes.open(nextInput, f.contents.id);
    const next = f.scopes.accept(nextInput, f.contents.id); f.scopes.finish(next);
    const replacement = f.register(next);
    revokePluginNativeMenus("different-installation", 3);
    expect(host.contributions.has(old.leaseId)).toBe(true);
    revokePluginNativeMenus(f.input.installationId, 3); oldClick();
    expect(f.send).not.toHaveBeenCalled(); expect(host.contributions.has(old.leaseId)).toBe(false);
    expect(host.contributions.has(replacement.leaseId)).toBe(true);
    click(replacement.leaseId)();
    expect(f.send).toHaveBeenCalledWith("paseo:event:plugin-menu-action", expect.objectContaining({ generation: 4, clientActivationId: "replacement-installation" }));
  });
  it("does not release a new document's menu when an old binding is cleaned up", () => {
    const f = fixture(); const old = f.register();
    host.epochs.set(f.window, 8);
    const input = { ...f.input, documentEpoch: 8 };
    f.scopes.open(input, f.contents.id); const next = f.scopes.accept(input, f.contents.id); f.scopes.finish(next);
    const lease = f.register(next); releasePluginClientMenus(f.binding);
    expect(host.contributions.has(old.leaseId)).toBe(false);
    expect(host.contributions.has(lease.leaseId)).toBe(true); click(lease.leaseId)(); expect(f.send).toHaveBeenCalledOnce();
  });
});
