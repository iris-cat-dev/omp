import { describe, expect, it, vi } from "vitest";
import { RendererPluginProfile, RENDERER_PLUGIN_PROFILE_KEY, type RendererProfileStorage } from "./renderer-profile";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
class MemoryStorage implements RendererProfileStorage {
  values = new Map<string, string>();
  failure: Error | null = null;
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { if (this.failure) throw this.failure; this.values.set(key, value); }
  async removeItem(key: string) { this.values.delete(key); }
}

describe("renderer-only local plugin profile", () => {
  it("persists only the default-enabled speed builtin and retains desired state across clients", async () => {
    const storage = new MemoryStorage();
    const profile = new RendererPluginProfile(storage);
    const initial = await profile.getSnapshot();
    expect(initial.installations).toHaveLength(1);
    expect(initial.installations[0]).toMatchObject({ id: "agent-speed", enabled: true, trusted: true, status: "active" });
    await profile.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { enabled: false, config: { preference: 7 } } });
    const restarted = new RendererPluginProfile(storage);
    expect((await restarted.getSnapshot()).installations[0]).toMatchObject({ enabled: false, status: "disabled", config: { preference: 7 }, revision: 1, generation: 1 });
    await restarted.patch({ installationId: "agent-speed", expectedRevision: 1, patch: { enabled: true } });
    expect((await profile.getSnapshot()).installations[0].status).toBe("active");
  });
  it("preserves config through removal/reinstall/reload, and clears data without enabling", async () => {
    const profile = new RendererPluginProfile(new MemoryStorage());
    await profile.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { config: { preference: 7 } } });
    const removed = await profile.remove({ installationId: "agent-speed", expectedRevision: 1 });
    expect(removed.installations[0]).toMatchObject({ installed: false, enabled: false, config: { preference: 7 }, status: "removed" });
    await expect(profile.patch({ installationId: "agent-speed", expectedRevision: 2, patch: { enabled: true } })).rejects.toThrow("Reinstall");
    await profile.reinstall({ installationId: "agent-speed", expectedRevision: 2 });
    const reloaded = await profile.reload({ installationId: "agent-speed", expectedRevision: 3 });
    expect(reloaded.installations[0]).toMatchObject({ installed: true, enabled: false, config: { preference: 7 }, generation: 3 });
    profile.fail("agent-speed", 3, new Error("factory failed"));
    expect((await profile.getLogs({ installationId: "agent-speed" }))[0].message).toBe("factory failed");
    const cleared = await profile.clearData({ installationId: "agent-speed", expectedRevision: 4 });
    expect(cleared.installations[0]).toMatchObject({ enabled: false, config: {}, generation: 4 });
    expect(await profile.getLogs({ installationId: "agent-speed" })).toEqual([]);
  });
  it("rejects corrupt storage without deleting it or resetting enabled intent", async () => {
    for (const raw of ["{", JSON.stringify({ revision: "bad" })]) {
      const storage = new MemoryStorage();
      storage.values.set(RENDERER_PLUGIN_PROFILE_KEY, raw);
      const profile = new RendererPluginProfile(storage);
      await expect(profile.getSnapshot()).rejects.toThrow();
      await expect(profile.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { enabled: false } })).rejects.toThrow();
      expect(storage.values.get(RENDERER_PLUGIN_PROFILE_KEY)).toBe(raw);
    }
  });
  it("reports real write failures and does not publish or alter saved intent", async () => {
    const storage = new MemoryStorage();
    const profile = new RendererPluginProfile(storage);
    await profile.getSnapshot();
    const before = storage.values.get(RENDERER_PLUGIN_PROFILE_KEY);
    const listener = vi.fn();
    profile.subscribe(listener);
    storage.failure = new Error("disk unavailable");
    await expect(profile.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { enabled: false } })).rejects.toThrow("disk unavailable");
    expect(storage.values.get(RENDERER_PLUGIN_PROFILE_KEY)).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect((await profile.getSnapshot()).installations[0].enabled).toBe(true);
  });
  it("reads latest state under the shared document lock and rejects stale revisions", async () => {
    const storage = new MemoryStorage();
    let queue: Promise<unknown> = Promise.resolve();
    const lock = <T>(operation: () => Promise<T>) => { const result = queue.then(operation, operation); queue = result; return result; };
    const first = new RendererPluginProfile(storage, lock);
    const second = new RendererPluginProfile(storage, lock);
    await first.getSnapshot();
    const results = await Promise.allSettled([
      first.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { enabled: false } }),
      second.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { config: { stale: true } } }),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect((await second.getSnapshot()).installations[0]).toMatchObject({ enabled: false, config: {}, revision: 1 });
  });
  it("revokes trust without changing enabled intent and rechecks actor authorization at commit", async () => {
    const profile = new RendererPluginProfile(new MemoryStorage());
    const initial = (await profile.getSnapshot()).installations[0];
    await profile.patch({ installationId: initial.id, expectedRevision: 0, patch: { trusted: false } });
    const untrusted = (await profile.getSnapshot()).installations[0];
    expect(untrusted).toMatchObject({ enabled: true, trusted: false, status: "waiting", generation: 1 });
    await expect(profile.patch({ installationId: initial.id, expectedRevision: 1, patch: { config: { invalid: true } } }, (record) => {
      if (record.generation !== initial.generation) throw new Error("actor revoked");
    })).rejects.toThrow("actor revoked");
    await profile.patch({ installationId: initial.id, expectedRevision: 1, patch: { trusted: true } });
    expect((await profile.getSnapshot()).installations[0]).toMatchObject({ enabled: true, trusted: true, status: "active", generation: 2 });
  });
});
