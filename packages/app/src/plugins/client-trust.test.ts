import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientTrust from "./client-trust";

const storage = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.values.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.values.delete(key);
    },
  },
}));

const hostId = "trusted-host";
const plugin: DesktopPluginCatalogEntry = {
  id: "qqbot-installation",
  packageId: "qqbot",
  owner: "daemon",
  version: "0.7.1",
  generation: 1,
  revision: 1,
  installed: true,
  enabled: true,
  effectiveEnabled: true,
  trusted: true,
  bundled: false,
  status: "running",
  format: "package",
  source: { type: "directory", path: "/plugins/qqbot" },
  metadata: null,
  declaredCapabilities: ["storage"],
  grantedCapabilities: ["storage"],
  clientBundle: "first client build",
};
let trust: typeof ClientTrust;

// Module reloads intentionally exercise persistence without cached in-memory approvals.
beforeEach(async () => {
  storage.values.clear();
  vi.resetModules();
  trust = await import("./client-trust");
});
afterEach(() => vi.restoreAllMocks());

function legacyApproval(version: string, capabilities: string[]) {
  return [
    JSON.stringify([hostId, plugin.id, plugin.packageId, plugin.source.path, version]),
    { bundleDigest: "previous-approved-digest", capabilities },
  ] as const;
}

describe("plugin client device trust", () => {
  it("reuses a trusted installation across reinstallation, version updates and rebuilt client code", async () => {
    await trust.approvePluginClientTrust(hostId, plugin);
    expect(
      await trust.hasPluginClientTrust(hostId, {
        ...plugin,
        version: "0.7.2",
        generation: 8,
        clientBundle: "reinstalled client build",
      }),
    ).toBe(true);
  });

  it("retains existing device approvals when upgrading from version-bound trust records", async () => {
    storage.values.set(
      "desktop-plugin-client-trust-v1",
      JSON.stringify(
        Object.fromEntries([
          legacyApproval("0.7.0", ["storage"]),
          legacyApproval("0.7.1", ["storage", "process"]),
        ]),
      ),
    );
    const updated = {
      ...plugin,
      version: "0.7.2",
      clientBundle: "new build",
      declaredCapabilities: ["storage", "process"],
    };
    expect(await trust.hasPluginClientTrust(hostId, updated)).toBe(true);
    vi.resetModules();
    trust = await import("./client-trust");
    expect(await trust.hasPluginClientTrust(hostId, updated)).toBe(true);
  });

  it.each([
    { boundary: "host", host: "other-host", entry: plugin },
    { boundary: "installation", host: hostId, entry: { ...plugin, id: "other-installation" } },
    { boundary: "package", host: hostId, entry: { ...plugin, packageId: "other-package" } },
    {
      boundary: "source",
      host: hostId,
      entry: { ...plugin, source: { type: "directory" as const, path: "/plugins/other-qqbot" } },
    },
  ])("requires device approval for a different $boundary", async ({ host, entry }) => {
    await trust.approvePluginClientTrust(hostId, plugin);
    expect(await trust.hasPluginClientTrust(host, entry)).toBe(false);
  });

  it("does not grant new capabilities through a trusted reinstall", async () => {
    await trust.approvePluginClientTrust(hostId, plugin);
    expect(
      await trust.hasPluginClientTrust(hostId, {
        ...plugin,
        version: "0.7.2",
        declaredCapabilities: ["storage", "process"],
      }),
    ).toBe(false);
  });

  it("keeps revocation effective across all versions and source directories of an installation", async () => {
    await trust.approvePluginClientTrust(hostId, plugin);
    const moved = { ...plugin, source: { type: "directory" as const, path: "/plugins/qqbot-new" } };
    await trust.approvePluginClientTrust(hostId, moved);
    await trust.revokePluginClientTrust(hostId, plugin.id);
    vi.resetModules();
    trust = await import("./client-trust");
    expect(await trust.hasPluginClientTrust(hostId, { ...plugin, version: "0.7.2" })).toBe(false);
    expect(await trust.hasPluginClientTrust(hostId, moved)).toBe(false);
  });

  it("does not load a client when its executable bundle is unavailable", async () => {
    await trust.approvePluginClientTrust(hostId, plugin);
    expect(await trust.hasPluginClientTrust(hostId, { ...plugin, clientBundle: undefined })).toBe(
      false,
    );
  });

  it("retains earlier explicit capabilities when approving a reduced declaration", async () => {
    await trust.approvePluginClientTrust(hostId, {
      ...plugin,
      declaredCapabilities: ["storage", "process"],
    });
    await trust.approvePluginClientTrust(hostId, plugin);
    expect(
      await trust.hasPluginClientTrust(hostId, { ...plugin, declaredCapabilities: ["process"] }),
    ).toBe(true);
  });

  it("does not revive another window's revoked installation when approving a different plugin", async () => {
    await trust.approvePluginClientTrust(hostId, plugin);
    const firstWindow = trust;
    vi.resetModules();
    const secondWindow = await import("./client-trust");
    expect(await secondWindow.hasPluginClientTrust(hostId, plugin)).toBe(true);
    await firstWindow.revokePluginClientTrust(hostId, plugin.id);
    const other = { ...plugin, id: "other-installation" };
    await secondWindow.approvePluginClientTrust(hostId, other);
    vi.resetModules();
    const reopenedWindow = await import("./client-trust");
    expect(await reopenedWindow.hasPluginClientTrust(hostId, plugin)).toBe(false);
    expect(await reopenedWindow.hasPluginClientTrust(hostId, other)).toBe(true);
  });

  it("retries migration after a failed write", async () => {
    storage.values.set(
      "desktop-plugin-client-trust-v1",
      JSON.stringify(Object.fromEntries([legacyApproval("0.7.1", ["storage"])])),
    );
    const asyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.spyOn(asyncStorage, "setItem").mockRejectedValueOnce(new Error("write failed"));
    await expect(trust.hasPluginClientTrust(hostId, plugin)).rejects.toThrow("write failed");
    await expect(trust.hasPluginClientTrust(hostId, plugin)).resolves.toBe(true);
  });

  it("uses durable migrated approvals even when removing obsolete records fails", async () => {
    storage.values.set(
      "desktop-plugin-client-trust-v1",
      JSON.stringify(Object.fromEntries([legacyApproval("0.7.1", ["storage"])])),
    );
    const asyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.spyOn(asyncStorage, "removeItem").mockRejectedValueOnce(new Error("cleanup failed"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(trust.hasPluginClientTrust(hostId, plugin)).resolves.toBe(true);
    expect(await trust.hasPluginClientTrust(hostId, plugin)).toBe(true);
  });
});
