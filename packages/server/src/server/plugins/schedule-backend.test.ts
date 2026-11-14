import { describe, expect, it, vi } from "vitest";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import type { CreateScheduleInput, StoredSchedule } from "@omp-desktop/protocol/schedule/types";
import { createSchedulePluginBackend, SchedulePluginUnavailableError } from "./schedule-backend.js";

const stored: StoredSchedule = {
  id: "task-1",
  name: "Daily check",
  prompt: "Check the project",
  cadence: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
  target: { type: "new-agent", config: { provider: "omp", cwd: "/project" } },
  status: "active",
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  nextRunAt: "2026-11-13T09:00:00.000Z",
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
};

function installation(id = "schedules", overrides: Partial<DesktopPluginCatalogEntry> = {}): DesktopPluginCatalogEntry {
  return {
    id,
    packageId: "schedules",
    owner: "daemon",
    version: "0.7.0",
    generation: 7,
    installed: true,
    bundled: false,
    enabled: true,
    effectiveEnabled: true,
    source: { type: "directory", path: "/plugins/schedules" },
    format: "package",
    metadata: null,
    declaredCapabilities: [],
    grantedCapabilities: [],
    trusted: true,
    status: "running",
    revision: 1,
    ...overrides,
  };
}

function setup(catalog: DesktopPluginCatalogEntry[], response: unknown = stored) {
  const invokePluginRpc = vi.fn(async (_id: string, _method: string, _input: unknown, _generation: number) => response);
  return { backend: createSchedulePluginBackend({ catalog: () => catalog, invokePluginRpc }), invokePluginRpc };
}

describe("legacy schedule API plugin backend", () => {
  it("forwards every legacy operation to its named RPC and validates the returned value", async () => {
    const catalog = [installation()];
    const invokePluginRpc = vi.fn(async (_id: string, method: string, _input: unknown, _generation: number) => {
      if (method === "schedules.list") return [stored];
      if (method === "schedules.logs") return stored.runs;
      if (method === "schedules.delete") return { deleted: true };
      return stored;
    });
    const backend = createSchedulePluginBackend({ catalog: () => catalog, invokePluginRpc });
    const input: CreateScheduleInput = { prompt: stored.prompt, cadence: stored.cadence, target: stored.target };
    expect(await backend.create(input)).toEqual(stored);
    expect(await backend.list()).toEqual([stored]);
    expect(await backend.inspect(stored.id)).toEqual(stored);
    expect(await backend.logs(stored.id)).toEqual([]);
    expect(await backend.pause(stored.id)).toEqual(stored);
    expect(await backend.resume(stored.id)).toEqual(stored);
    expect(await backend.delete(stored.id)).toBeUndefined();
    expect(await backend.runOnce(stored.id)).toEqual(stored);
    expect(await backend.update({ id: stored.id, prompt: "Updated" })).toEqual(stored);
    expect(invokePluginRpc.mock.calls).toEqual([
      ["schedules", "schedules.create", input, 7],
      ["schedules", "schedules.list", {}, 7],
      ["schedules", "schedules.inspect", { id: stored.id }, 7],
      ["schedules", "schedules.logs", { id: stored.id }, 7],
      ["schedules", "schedules.pause", { id: stored.id }, 7],
      ["schedules", "schedules.resume", { id: stored.id }, 7],
      ["schedules", "schedules.delete", { id: stored.id }, 7],
      ["schedules", "schedules.run-once", { id: stored.id }, 7],
      ["schedules", "schedules.update", { id: stored.id, prompt: "Updated" }, 7],
    ]);
  });

  it("prefers the active canonical installation", async () => {
    const { backend, invokePluginRpc } = setup([installation("other"), installation()]);
    await backend.inspect(stored.id);
    expect(invokePluginRpc).toHaveBeenCalledWith("schedules", "schedules.inspect", { id: stored.id }, 7);
  });

  it("uses one active noncanonical installation and resolves its generation on every call", async () => {
    const catalog = [installation("custom")];
    const { backend, invokePluginRpc } = setup(catalog);
    await backend.inspect(stored.id);
    catalog[0] = installation("custom", { generation: 8 });
    await backend.inspect(stored.id);
    expect(invokePluginRpc).toHaveBeenLastCalledWith("custom", "schedules.inspect", { id: stored.id }, 8);
  });

  it("rejects ambiguous active installations", async () => {
    const { backend, invokePluginRpc } = setup([installation("first"), installation("second")]);
    await expect(backend.list()).rejects.toThrow(/multiple active installations.*first, second/);
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it.each([
    { catalog: [] },
    { catalog: [installation("schedules", { installed: false })] },
    { catalog: [installation("schedules", { enabled: false, status: "disabled" })] },
    { catalog: [installation("schedules", { effectiveEnabled: false })] },
    { catalog: [installation("schedules", { status: "failed", error: "Service failed" })] },
    { catalog: [installation("schedules", { status: "waiting", waitingReason: "Approve trust" })] },
    { catalog: [installation("schedules", { owner: "desktop" })] },
    { catalog: [installation("schedules", { packageId: "another-package" })] },
  ])("reports unavailable installations without invoking a worker %#", async ({ catalog }) => {
    const { backend, invokePluginRpc } = setup(catalog);
    await expect(backend.list()).rejects.toBeInstanceOf(SchedulePluginUnavailableError);
    await expect(backend.list()).rejects.toThrow(/Plugins/);
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("supports servers without a plugin service and fails when requested", async () => {
    await expect(createSchedulePluginBackend().list()).rejects.toThrow(/install and enable/);
  });

  it.each(["inspect", "list", "logs", "delete"] as const)("rejects invalid %s RPC responses", async (method) => {
    const { backend } = setup([installation()], { invalid: true });
    const result = method === "list" ? backend.list() : backend[method](stored.id);
    await expect(result).rejects.toThrow();
  });
});
