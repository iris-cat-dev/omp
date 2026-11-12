import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IpcMainInvokeEvent, WebFrameMain } from "electron";
import { registerApplicationMenuContribution } from "../features/menu.js";
import { getMainWindows, getMainWindowDocumentVersion, selectMainWindow } from "../window/main-windows.js";
import type { LocalPluginRuntime } from "./local-runtime.js";
import type { ClientScopeBinding } from "./client-scopes.js";
interface MenuLease { binding: ClientScopeBinding; frame: WebFrameMain; release(): void }
const leases = new Map<string, MenuLease>();
const MenuRegistrationSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), title: z.string().min(1).max(256), order: z.number().finite().optional() })).max(100) }).refine((value) => new Set(value.items.map(({ id }) => id)).size === value.items.length, "Duplicate native menu action ID.");
function requireMenuDocument(event: IpcMainInvokeEvent, binding: ClientScopeBinding): WebFrameMain {
  const window = getMainWindows().find((window) => window.webContents === event.sender);
  if (binding.closed || !window || event.sender.isDestroyed() || event.sender.id !== binding.senderId || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.detached || getMainWindowDocumentVersion(window) !== binding.documentEpoch) throw new Error("Menu operation requires the current plugin client document.");
  return event.senderFrame;
}
export function registerPluginNativeMenu(event: IpcMainInvokeEvent, binding: ClientScopeBinding, raw: unknown, runtime: LocalPluginRuntime): { leaseId: string } {
  const frame = requireMenuDocument(event, binding);
  const { installationId, generation, senderId, documentEpoch, clientActivationId } = binding;
  if (binding.mode !== "active") throw new Error("Management cannot acquire plugin execution resources.");
  runtime.assertAuthorized(installationId, generation, "active", "ui.menu");
  const { items } = MenuRegistrationSchema.parse(raw);
  const leaseId = randomUUID();
  const remove = registerApplicationMenuContribution(leaseId, () => {
    const window = getMainWindows().find((window) => window.webContents.id === senderId);
    if (!window || selectMainWindow() !== window || binding.closed || window.webContents.isDestroyed() || frame.detached || window.webContents.mainFrame !== frame || getMainWindowDocumentVersion(window) !== documentEpoch) return [];
    return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)).map((item) => ({ label: item.title, click: () => {
      if (leases.get(leaseId)?.binding !== binding || binding.closed || frame.detached || window.webContents.isDestroyed() || window.webContents.mainFrame !== frame || getMainWindowDocumentVersion(window) !== documentEpoch || selectMainWindow() !== window) return;
      try { runtime.assertAuthorized(installationId, generation, "active", "ui.menu"); }
      catch { return; }
      frame.send("paseo:event:plugin-menu-action", { installationId, generation, clientActivationId, actionId: item.id });
    } }));
  });
  leases.set(leaseId, { binding, frame, release: remove });
  return { leaseId };
}
export function unregisterPluginNativeMenu(event: IpcMainInvokeEvent, binding: ClientScopeBinding, raw: unknown): void {
  const frame = requireMenuDocument(event, binding);
  const { leaseId } = z.object({ leaseId: z.string() }).parse(raw), lease = leases.get(leaseId);
  if (!lease) return;
  if (lease.binding !== binding || lease.frame !== frame) throw new Error("Menu lease does not belong to this plugin client document.");
  leases.delete(leaseId); lease.release();
}
export function revokePluginNativeMenus(installationId: string, generation: number): void { for (const [id, lease] of leases) if (lease.binding.installationId === installationId && lease.binding.generation === generation) { leases.delete(id); lease.release(); } }
export function releasePluginDocumentMenus(senderId: number): void { for (const [id, lease] of leases) if (lease.binding.senderId === senderId) { leases.delete(id); lease.release(); } }
export function releasePluginClientMenus(binding: ClientScopeBinding): void { for (const [id, lease] of leases) if (lease.binding === binding) { leases.delete(id); lease.release(); } }
