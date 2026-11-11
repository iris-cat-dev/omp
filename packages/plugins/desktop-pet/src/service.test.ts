import { describe, expect, it, vi } from "vitest";
import { createActivationScope, type PluginServiceContext, type PluginNativeOverlayRequest, type PluginNativeOverlayLease } from "@omp-desktop/plugin/host";
import setup, { compactPetMenuTitle } from "./service.js";
import { DEFAULT_PET_ACTIVITY } from "./activity.js";
import { DEFAULT_PET_CONFIG } from "./config.js";
function host() {
  const scope = createActivationScope(1), subscriptions = new Map<string, (value: unknown) => void>(), handlers = new Map<string, (input: unknown) => unknown>();
  let request: PluginNativeOverlayRequest;
  const overlay: PluginNativeOverlayLease = { update: vi.fn(), showMenu: vi.fn(), release: vi.fn() };
  const invoke = vi.fn(async (method: string, input: unknown) => {
    if (method === "pet:selected") return { id: "iris" };
    if (method === "overlay.acquire") { request = input as PluginNativeOverlayRequest; return overlay; }
    if (method.startsWith("navigation.") || method === "plugin.fail" || method === "plugin.setEnabled") return;
    throw new Error(`Unexpected native operation: ${method}`);
  });
  const ctx = { signal: scope.signal, own: scope.own, storage: { get: async () => ({ revision: 1, values: DEFAULT_PET_CONFIG }), patch: vi.fn() }, native: { invoke, subscribe: (name: string, listener: (value: unknown) => void) => { subscriptions.set(name, listener); return () => { subscriptions.delete(name); }; } }, handle: (rpc: { name: string }, handler: (input: unknown) => unknown) => { handlers.set(rpc.name, handler); scope.own(() => { handlers.delete(rpc.name); }); } } as unknown as PluginServiceContext;
  return { ctx, scope, subscriptions, handlers, overlay, invoke, request: () => request };
}
describe("pet service ownership", () => {
  it("releases the overlay, RPC and subscriptions when the generation stops", async () => { const h = host(); await setup(h.ctx); await h.scope.dispose(); expect(h.overlay.release).toHaveBeenCalledOnce(); expect(h.subscriptions.size).toBe(0); expect(h.handlers.size).toBe(0); });
  it("removes only the released window's activity and navigates to the priority task", async () => {
    const h = host(); await setup(h.ctx);
    const task = { serverId: "local", agentId: "one", status: "running", title: "One", generation: "connection-1", updatedAt: 1 };
    h.handlers.get("pet.activity")!({ senderId: 11, activity: { ...DEFAULT_PET_ACTIVITY, connected: true, serverIds: ["local"], revisions: { local: { generation: "connection-1", seq: 1 } }, tasks: [task] } });
    h.handlers.get("pet.activity")!({ senderId: 12, activity: { ...DEFAULT_PET_ACTIVITY, connected: true, serverIds: ["other-local"], revisions: { "other-local": { generation: "connection-2", seq: 1 } }, tasks: [{ ...task, serverId: "other-local", agentId: "two", status: "needs_input", title: "Two" }] } });
    await h.request().onAction("open", undefined);
    expect(h.invoke).toHaveBeenLastCalledWith("navigation.openAgent", { serverId: "other-local", agentId: "two" });
    h.subscriptions.get("client:released")!(12);
    await h.request().onAction("open", undefined);
    expect(h.invoke).toHaveBeenLastCalledWith("navigation.openAgent", { serverId: "local", agentId: "one" });
    await h.scope.dispose();
  });
  it("surfaces selected-art failure instead of opening an empty overlay", async () => { const h = host(); h.invoke.mockRejectedValueOnce(new Error("Invalid pet sprite atlas")); await expect(setup(h.ctx)).rejects.toThrow("Invalid pet sprite atlas"); expect(h.overlay.update).not.toHaveBeenCalled(); await h.scope.dispose(); });
  it("keeps Chinese and joined emoji graphemes intact with bounded menu labels", () => { expect(compactPetMenuTitle("中文".repeat(10))).toBe("中文".repeat(10)); expect(compactPetMenuTitle("👨‍👩‍👧‍👦".repeat(21))).toBe(`${"👨‍👩‍👧‍👦".repeat(20)}…`); });
});
