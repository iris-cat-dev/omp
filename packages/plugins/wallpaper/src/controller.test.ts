import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@omp-desktop/plugin";
import type { WallpaperErrorCode, WallpaperLibrary, WallpaperMediaDescriptor } from "@omp-desktop/protocol/desktop-wallpaper";
import { WallpaperController } from "./controller.js";
import { DEFAULT_WALLPAPER_CONFIGURATION, type WallpaperConfiguration } from "./source.js";

const candidateA = { candidateId: "0199ef80-5ff5-7000-8000-000000000001", directory: "C:/wallpapers", path: "C:/wallpapers/a.png", name: "a.png", kind: "image" as const };
const candidateB = { ...candidateA, candidateId: "0199ef80-5ff5-7000-8000-000000000002", path: "C:/wallpapers/b.png", name: "b.png" };
async function drain() { for (let count = 0; count < 12; count++) await Promise.resolve(); }
function fixture(config: WallpaperConfiguration, mode: "manage" | "active" = "active") {
  let revision = 1;
  let configuration = { ...config };
  let library: WallpaperLibrary = { version: 1, revision: 1, items: [candidateA, candidateB] };
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const pending: Array<{ candidateId: string; resolve: (response: unknown) => void }> = [];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const abort = new AbortController();
  let releaseFailure: Error | { code: WallpaperErrorCode; message: string } | null = null;
  const ctx = { installation: { id: "wallpaper", generation: 1, enabled: mode === "active" }, mode, signal: abort.signal,
    storage: {
      async get() { return { revision, values: { ...configuration } }; },
      async patch(fields: Partial<WallpaperConfiguration>, expected: number) {
        if (expected !== revision) throw new Error("configuration revision conflict");
        configuration = { ...configuration, ...fields }; revision++;
        return { revision, values: { ...configuration } };
      },
    },
    native: {
      subscribe(event: string, listener: (value: unknown) => void) {
        const set = listeners.get(event) ?? new Set(); listeners.set(event, set); set.add(listener);
        return () => { set.delete(listener); };
      },
      async invoke(operation: string, input: Record<string, unknown> = {}) {
        calls.push({ operation, input });
        const release = (operation === "wallpaper:setBackground" && input.candidateId === null) ||
          (operation === "wallpaper:setPreviews" && Array.isArray(input.candidateIds) && input.candidateIds.length === 0);
        if (release && releaseFailure) {
          if (releaseFailure instanceof Error) throw releaseFailure;
          return { ok: false, ...releaseFailure };
        }
        if (operation === "wallpaper:getContext") return { ok: true, data: { epoch: "document-a" } };
        if (operation === "wallpaper:selection") return mode === "active";
        if (operation === "wallpaper:migrationStatus") return { reason: null, pending: false };
        if (operation === "wallpaper:getLibrary") return { ok: true, data: library };
        if (operation === "wallpaper:setBackground") {
          if (!input.candidateId) return { ok: true, data: { media: null } };
          const { promise, resolve } = Promise.withResolvers<unknown>();
          pending.push({ candidateId: input.candidateId as string, resolve });
          return promise;
        }
        if (operation === "wallpaper:setPreviews") return { ok: true, data: { media: [], rejected: [] } };
        if (operation === "wallpaper:addCandidates") return { ok: true, data: { library, added: [], duplicates: [], cancelled: false, rejected: [] } };
        if (operation === "wallpaper:removeCandidates") {
          library = { ...library, revision: library.revision + 1, items: library.items.filter(item => !(input.candidateIds as string[]).includes(item.candidateId)) };
          return { ok: true, data: { library, removedCandidateIds: input.candidateIds } };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    },
  } as unknown as PluginClientContext;
  const controller = new WallpaperController(ctx);
  const detach = controller.attach(ctx);
  const deactivate = mode === "active" ? controller.activate(ctx) : () => {};
  function emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); }
  function complete(index: number) {
    const request = pending[index];
    const item = request.candidateId === candidateA.candidateId ? candidateA : candidateB;
    const media: WallpaperMediaDescriptor = { ...item, id: `lease-${index}`, uri: `omp-desktop://app/wallpaper-media?id=lease-${index}`,
      scope: { installationId: "wallpaper", generation: 1, epoch: "document-a", purpose: "background" } };
    request.resolve({ ok: true, data: { media } });
  }
  return { controller, ctx, calls, pending, complete, emit,
    edit(next: Partial<WallpaperConfiguration>) { configuration = { ...configuration, ...next }; revision++; emit("plugins:changed", {}); },
    failRelease(failure: Error | { code: WallpaperErrorCode; message: string }) { releaseFailure = failure; },
    abortClient() { abort.abort(); },
    dispose() { abort.abort(); deactivate(); detach(); controller.dispose(); },
  };
}

describe("wallpaper builtin lifecycle", () => {
  it.each([
    { ...DEFAULT_WALLPAPER_CONFIGURATION, source: "none", candidateId: candidateA.candidateId, url: "https://example.com/a.png" },
    { ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: null },
    { ...DEFAULT_WALLPAPER_CONFIGURATION, source: "url", url: null },
  ] satisfies WallpaperConfiguration[])("keeps $source with absent media intent inactive without changing retained fields", async config => {
    const f = fixture(config);
    await drain();
    expect(f.controller.getSnapshot().configuration).toEqual(config);
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    expect(f.calls.some(call => call.operation === "wallpaper:setBackground")).toBe(false);
    f.dispose();
  });

  it("management loads local configuration/library without obtaining background execution leases", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId }, "manage");
    await drain();
    expect(f.controller.getSnapshot().configuration.candidateId).toBe(candidateA.candidateId);
    expect(f.calls.some(call => call.operation === "wallpaper:setBackground")).toBe(false);
    const previews = f.controller.acquirePreviews([candidateA.candidateId]); await previews.result; previews.release();
    await f.controller.patch({ opacity: 0 });
    expect(f.controller.getSnapshot().configuration.opacity).toBe(0);
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    f.dispose();
  });
  it("requires actual ready and keeps A-B-A, failures and explicit retry bound to unique attempts", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "url", url: "https://example.com/a.mp4" });
    await drain();
    const firstA = f.controller.getBackgroundSnapshot()!;
    expect(f.controller.getSnapshot().loadStatus).toBe("loading");
    f.edit({ url: "https://example.com/b.png" }); await drain();
    f.edit({ url: "https://example.com/a.mp4" }); await drain();
    const secondA = f.controller.getBackgroundSnapshot()!;
    expect(secondA.requestKey).not.toBe(firstA.requestKey);
    firstA.onReady(); firstA.onError();
    expect(f.controller.getSnapshot().loadStatus).toBe("loading");
    secondA.onError(); secondA.onReady();
    expect(f.controller.getSnapshot().loadStatus).toBe("error");
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    f.controller.retry();
    const retry = f.controller.getBackgroundSnapshot()!;
    secondA.onReady();
    expect(f.controller.getSnapshot().loadStatus).toBe("loading");
    retry.onReady(); expect(f.controller.getSnapshot().loadStatus).toBe("ready");
    f.dispose(); retry.onReady();
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
  });
  it("late file acquisitions cannot replace A-B-A or resurrect a deactivated background", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId });
    await drain();
    f.edit({ candidateId: candidateB.candidateId }); await drain();
    f.edit({ candidateId: candidateA.candidateId }); await drain();
    expect(f.pending.map(request => request.candidateId)).toEqual([candidateA.candidateId, candidateB.candidateId, candidateA.candidateId]);
    f.complete(0); f.complete(1); await drain();
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    f.dispose(); f.complete(2); await drain();
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
  });
  it("ignores old/equal library revisions and never binds a removed selection to a same-path replacement", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId });
    await drain();
    f.emit("wallpaper:libraryChanged", { version: 1, revision: 3, items: [] });
    f.emit("wallpaper:libraryChanged", { version: 1, revision: 2, items: [candidateA] });
    f.emit("wallpaper:libraryChanged", { version: 1, revision: 3, items: [candidateA] });
    expect(f.controller.getSnapshot().library?.items).toEqual([]);
    f.emit("wallpaper:libraryChanged", { version: 1, revision: 4, items: [{ ...candidateA, candidateId: candidateB.candidateId }] });
    await drain();
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    expect(f.controller.getSnapshot().configuration.candidateId).toBe(candidateA.candidateId);
    f.dispose();
  });
  it("adding/removing candidates does not select another candidate or clear retained configuration", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId }, "manage");
    await drain();
    await f.controller.add({ title: "Add", mediaLabel: "Media", imageLabel: "Image", videoLabel: "Video" });
    await f.controller.remove([candidateA.candidateId]);
    expect(f.controller.getSnapshot().configuration.candidateId).toBe(candidateA.candidateId);
    expect(f.controller.getSnapshot().configuration.source).toBe("file");
    expect(f.controller.getSnapshot().library?.items.map(item => item.candidateId)).toEqual([candidateB.candidateId]);
    f.dispose();
  });

  it("losing the selected slot cancels file leases and ignores their late result", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId });
    await drain();
    f.emit("wallpaper:selectionChanged", false);
    f.complete(0); await drain();
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    expect(f.controller.getSnapshot().loadStatus).toBe("idle");
    f.emit("wallpaper:selectionChanged", true); await drain();
    expect(f.pending).toHaveLength(2);
    f.complete(1); await drain();
    expect(f.controller.getBackgroundSnapshot()).not.toBeNull();
    f.dispose();
  });

  it("reports preserved legacy file migration errors without suspending a selected URL background", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "url", url: "https://example.com/a.png" });
    await drain();
    const intent = f.controller.getBackgroundSnapshot()!;
    intent.onReady();
    f.emit("wallpaper:migrationChanged", { reason: "Original wallpaper file is missing.", pending: false });
    expect(f.controller.getSnapshot().migrationStatus?.reason).toBe("Original wallpaper file is missing.");
    expect(f.controller.getSnapshot().loadStatus).toBe("ready");
    expect(f.controller.getBackgroundSnapshot()).toBe(intent);
    f.dispose();
  });

  it("reports genuine release errors even after abort and reuses the previously issued epoch", async () => {
    const f = fixture(DEFAULT_WALLPAPER_CONFIGURATION, "manage");
    const reported: unknown[][] = [];
    const report = vi.spyOn(console, "error").mockImplementation((...args) => { reported.push(args); });
    try {
      await drain();
      const lease = f.controller.acquirePreviews([candidateA.candidateId]); await lease.result;
      const contextCalls = f.calls.filter(call => call.operation === "wallpaper:getContext").length;
      f.failRelease({ code: "storage-error", message: "Native release transport failed." });
      f.abortClient(); lease.release(); await drain();
      expect(f.calls.filter(call => call.operation === "wallpaper:getContext")).toHaveLength(contextCalls);
      expect(f.calls.at(-1)?.input.epoch).toBe("document-a");
      expect(f.controller.getSnapshot().cleanupError).toBe("Native release transport failed.");
      expect(f.controller.getSnapshot().loadStatus).toBe("idle");
      expect(reported).toHaveLength(1);
    } finally { f.dispose(); report.mockRestore(); }
  });

  it.each([
    { code: "superseded", message: "The media intent was superseded." },
    { code: "stale-document", message: "The document has changed." },
    new Error("Error invoking remote method 'paseo:plugins:invoke': Error: Plugin client activation has been released."),
  ] satisfies Array<Error | { code: WallpaperErrorCode; message: string }>)("recognizes already-revoked release results without hiding other errors", async failure => {
    const f = fixture(DEFAULT_WALLPAPER_CONFIGURATION, "manage");
    const reported: unknown[][] = [];
    const report = vi.spyOn(console, "error").mockImplementation((...args) => { reported.push(args); });
    try {
      await drain();
      const lease = f.controller.acquirePreviews([candidateA.candidateId]); await lease.result;
      f.failRelease(failure); lease.release(); await drain();
      expect(f.controller.getSnapshot().cleanupError).toBeNull();
      expect(reported).toHaveLength(0);
    } finally { f.dispose(); report.mockRestore(); }
  });

  it("management previews release through their originating client after an active client is attached", async () => {
    const f = fixture(DEFAULT_WALLPAPER_CONFIGURATION);
    await drain();
    const management = { ...f.ctx, mode: "manage" as const };
    const lease = f.controller.acquirePreviews([candidateA.candidateId], management); await lease.result;
    const activeCalls: string[] = [];
    const active = { ...f.ctx, mode: "active" as const, signal: new AbortController().signal, native: {
      ...f.ctx.native,
      invoke: async <T,>(operation: string, input?: unknown): Promise<T> => {
        activeCalls.push(operation);
        return f.ctx.native.invoke<T>(operation, input);
      },
    } };
    const deactivate = f.controller.activate(active);
    try {
      lease.release(); await drain();
      expect(activeCalls).not.toContain("wallpaper:setPreviews");
      expect(f.calls.filter(call => call.operation === "wallpaper:setPreviews")).toHaveLength(2);
    } finally { deactivate(); f.dispose(); }
  });

  it("retains monotonically increasing preview revisions across view lease remounts in one factory", async () => {
    const f = fixture(DEFAULT_WALLPAPER_CONFIGURATION, "manage"); await drain();
    const first = f.controller.acquirePreviews([candidateA.candidateId]); await first.result;
    first.release(); await drain();
    const second = f.controller.acquirePreviews([candidateB.candidateId]); await second.result;
    second.release(); await drain();
    expect(f.calls.filter(call => call.operation === "wallpaper:setPreviews").map(call => call.input.revision)).toEqual([1, 2, 3, 4]);
    f.dispose();
  });

  it("direct disposal prevents late snapshots and acquisition replies from issuing new RPCs", async () => {
    const f = fixture({ ...DEFAULT_WALLPAPER_CONFIGURATION, source: "file", candidateId: candidateA.candidateId });
    await drain();
    f.controller.dispose(); await drain();
    const before = f.calls.length;
    f.complete(0);
    f.emit("plugins:changed", {});
    f.emit("wallpaper:libraryChanged", { version: 1, revision: 8, items: [candidateB] });
    f.controller.retry(); await drain();
    expect(f.calls).toHaveLength(before);
    expect(f.controller.getBackgroundSnapshot()).toBeNull();
    f.dispose();
  });

  it("disposal explicitly cancels a queued configuration patch before it is dispatched", async () => {
    const f = fixture(DEFAULT_WALLPAPER_CONFIGURATION, "manage"); await drain();
    const patch = f.controller.patch({ opacity: 0 });
    const cancelled = expect(patch).rejects.toThrow("controller has been disposed");
    f.controller.dispose(); await cancelled;
    expect((await f.ctx.storage.get<WallpaperConfiguration>()).values.opacity).toBe(0.85);
    f.dispose();
  });
});
