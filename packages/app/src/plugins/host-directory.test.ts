import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OmpApi } from "@omp-desktop/client";
import { createActivationScope, createPluginOmpApi } from "@omp-desktop/plugin/host";
import { defineRpc, type PluginInstallation } from "@omp-desktop/plugin";
import { z } from "zod";
import { setupPluginClient } from "./context";
import { pluginClientRegistry } from "./registry";

const runtime = vi.hoisted(() => ({
  hosts: [{ serverId: "home", label: "Home" }, { serverId: "office", label: "Office" }],
  online: new Set(["home", "office"]),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHosts: () => runtime.hosts,
    getSnapshot: (id: string) => ({ connectionStatus: runtime.online.has(id) ? "online" : "offline" }),
    subscribeAll: () => () => {},
    subscribeHostList: () => () => {},
  }),
}));

async function install(hostId: string, capabilities: string[], packageId = "schedules") {
  const scope = createActivationScope(1);
  const installation: PluginInstallation = {
    id: "schedules", packageId, owner: "daemon", version: "0.7.0", generation: 1,
    enabled: true, declaredCapabilities: capabilities, grantedCapabilities: capabilities,
  };
  const api = { agents: { create() { throw new Error("Unexpected privileged operation"); } } } as unknown as OmpApi;
  const instance = await setupPluginClient({
    hostId, installation, scope, mode: "active", format: "package", setup() {},
    services: {
      getOmp: () => createPluginOmpApi(api, installation, scope, { mode: "active" }),
      storage: { get: async () => ({ revision: 0, values: {} as never }), patch: async () => ({ revision: 0, values: {} as never }) },
      secrets: { configured: async () => false, set: async () => {}, delete: async () => {} },
      native: { invoke: async () => undefined as never, subscribe: () => () => {} },
      invoke: async () => "available",
    },
  });
  if (!instance) throw new Error("Activation was cancelled");
  pluginClientRegistry.replace(instance);
  return instance;
}
beforeEach(() => { runtime.online = new Set(["home", "office"]); });
afterEach(async () => {
  for (const instance of pluginClientRegistry.getSnapshot().instances) {
    pluginClientRegistry.remove(instance.key, instance.scope);
    await instance.scope.dispose();
  }
});

it("retains a disconnected installation but removes a disabled or foreign-package host", async () => {
  const home = await install("home", ["agents.events"]);
  const office = await install("office", ["agents.events"]);
  expect(home.context.hosts.list()).toEqual([
    { id: "home", label: "Home", online: true }, { id: "office", label: "Office", online: true },
  ]);
  runtime.online.delete("office");
  pluginClientRegistry.remove(office.key, office.scope);
  await office.scope.dispose();
  expect(home.context.hosts.list()).toEqual([
    { id: "home", label: "Home", online: true }, { id: "office", label: "Office", online: false },
  ]);
  expect(home.context.hosts.get("office")).toBeNull();
  runtime.online.add("office");
  await install("office", ["agents.events"], "different-package");
  expect(home.context.hosts.list()).toEqual([{ id: "home", label: "Home", online: true }]);
});

it("does not inherit a remote creation grant and fences captured RPCs after remote disposal", async () => {
  const home = await install("home", ["agents.events"]);
  const office = await install("office", ["agents.events", "agents.create"]);
  const connection = home.context.hosts.get("office");
  if (!connection) throw new Error("Office is missing");
  expect(() => connection.omp.agents.create({ config: { provider: "codex/test" }, cwd: "/tmp" })).toThrow("Plugin capability is not granted: agents.create");
  await office.scope.dispose();
  const rpc = defineRpc({ name: "inspect", input: z.object({}), output: z.string() });
  await expect(connection.rpc(rpc, {})).rejects.toThrow("Plugin generation is no longer active");
});
