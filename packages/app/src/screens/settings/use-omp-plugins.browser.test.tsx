import { act } from "react";
import { createInstance } from "i18next";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  OmpPluginInfo,
  OmpPluginMarketplaceCatalogEntry,
} from "@omp-desktop/protocol/messages";
import { ompPluginSettings } from "@/i18n/resources/plugin-settings";
import { unifiedPluginSettings } from "@/i18n/resources/unified-plugin-settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isOmpMarketplaceSpec, useOmpPlugins } from "./use-omp-plugins";

type PluginsClient = Pick<
  DaemonClient,
  | "listOmpPlugins"
  | "listOmpPluginMarketplaces"
  | "runOmpPluginDoctor"
  | "setOmpPluginEnabled"
  | "removeOmpPlugin"
  | "upgradeOmpPlugin"
  | "installOmpPlugin"
  | "addOmpPluginMarketplace"
  | "removeOmpPluginMarketplace"
  | "updateOmpPluginMarketplace"
>;

const runtime = vi.hoisted(() => ({
  client: null as PluginsClient | null,
  connected: true,
  t: (key: string, _options?: Record<string, unknown>): string => key,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: runtime.t }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

const recoveredPlugin: OmpPluginInfo = {
  name: "Recovered plugin",
  id: "recovered-plugin@test-marketplace",
  version: "1.0.0",
  scope: "user",
  enabled: true,
};
const freshPlugin: OmpPluginMarketplaceCatalogEntry = { name: "fresh-plugin", version: "1.0.0" };
const marketplace = {
  name: "test-marketplace",
  source: "publisher/catalog",
  plugins: [freshPlugin],
};

function createClient(plugins: OmpPluginInfo[] = [recoveredPlugin]) {
  return {
    listOmpPlugins: vi
      .fn<PluginsClient["listOmpPlugins"]>()
      .mockResolvedValue({ requestId: "list", plugins, marketplace: [] }),
    listOmpPluginMarketplaces: vi
      .fn<PluginsClient["listOmpPluginMarketplaces"]>()
      .mockResolvedValue({ requestId: "marketplaces", marketplaces: [marketplace] }),
    runOmpPluginDoctor: vi
      .fn<PluginsClient["runOmpPluginDoctor"]>()
      .mockResolvedValue({ requestId: "doctor", checks: [] }),
    setOmpPluginEnabled: vi
      .fn<PluginsClient["setOmpPluginEnabled"]>()
      .mockResolvedValue({
        requestId: "toggle",
        ok: true,
        name: recoveredPlugin.id!,
        enabled: false,
      }),
    removeOmpPlugin: vi
      .fn<PluginsClient["removeOmpPlugin"]>()
      .mockResolvedValue({ requestId: "remove", ok: true }),
    upgradeOmpPlugin: vi
      .fn<PluginsClient["upgradeOmpPlugin"]>()
      .mockResolvedValue({ requestId: "upgrade", ok: true }),
    installOmpPlugin: vi
      .fn<PluginsClient["installOmpPlugin"]>()
      .mockResolvedValue({
        requestId: "install",
        ok: true,
        plugin: null,
        output: "Installed source",
      }),
    addOmpPluginMarketplace: vi
      .fn<PluginsClient["addOmpPluginMarketplace"]>()
      .mockResolvedValue({ requestId: "add", ok: true, marketplace }),
    removeOmpPluginMarketplace: vi
      .fn<PluginsClient["removeOmpPluginMarketplace"]>()
      .mockResolvedValue({ requestId: "remove-marketplace", ok: true }),
    updateOmpPluginMarketplace: vi
      .fn<PluginsClient["updateOmpPluginMarketplace"]>()
      .mockResolvedValue({ requestId: "update-marketplace", ok: true }),
  };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runtime.connected = true;
  vi.mocked(confirmDialog).mockResolvedValue(true);
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          plugins: unifiedPluginSettings.en,
          settings: { host: { ompPlugins: ompPluginSettings } },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  runtime.t = (key, options) => i18n.t(key, options);
});

afterEach(() => {
  cleanup();
  runtime.client = null;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { plugins: [recoveredPlugin], pageState: "ready" },
  { plugins: [], pageState: "empty" },
])(
  "recovers a failed load into $pageState without retaining its error",
  async ({ plugins, pageState }) => {
    const client = createClient(plugins);
    client.listOmpPlugins.mockRejectedValueOnce(new Error("Host plugin list unavailable"));
    runtime.client = client;
    const { result } = renderHook(() => useOmpPlugins("server-1"));
    await waitFor(() => expect(result.current.pageState).toBe("error"));
    expect(result.current.error).toBe("Host plugin list unavailable");

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.pageState).toBe(pageState);
    expect(result.current.plugins).toEqual(plugins);
    expect(result.current.error).toBeNull();
    expect(result.current.controlsDisabled).toBe(false);
  },
);

it("preserves doctor checks and output through fix readback and a later load", async () => {
  const checks = [
    {
      name: "Permissions",
      status: "warning" as const,
      message: "Manual approval is still required",
    },
  ];
  const client = createClient([]);
  client.runOmpPluginDoctor
    .mockRejectedValueOnce(new Error("Doctor could not access the plugin directory"))
    .mockResolvedValue({ requestId: "doctor-fix", checks, rawOutput: "Repaired the plugin index" });
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("empty"));

  await act(async () => {
    await result.current.doctor(false);
  });
  expect(result.current.error).toBe("Doctor could not access the plugin directory");
  client.listOmpPlugins.mockResolvedValue({
    requestId: "readback",
    plugins: [recoveredPlugin],
    marketplace: [],
  });
  await act(async () => {
    await result.current.doctor(true);
  });
  await act(async () => {
    await result.current.load();
  });

  expect(result.current.error).toBeNull();
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  expect(result.current.doctorChecks).toEqual(checks);
  expect(result.current.output).toBe("Repaired the plugin index");
  expect(result.current.notice).toBe("applied");
});

it.each(["rejection", "raw output"])(
  "reports a catalog %s without hiding installed plugins",
  async (failure) => {
    const client = createClient();
    if (failure === "rejection")
      client.listOmpPluginMarketplaces.mockRejectedValueOnce(
        new Error("Catalog registry unavailable"),
      );
    else
      client.listOmpPluginMarketplaces.mockResolvedValueOnce({
        requestId: "bad-catalog",
        marketplaces: [],
        rawOutput: "Catalog registry unavailable",
      });
    runtime.client = client;
    const { result } = renderHook(() => useOmpPlugins("server-1"));
    await waitFor(() => expect(result.current.pageState).toBe("ready"));
    expect(result.current.plugins).toEqual([recoveredPlugin]);
    expect(result.current.error).toBe("Catalog registry unavailable");
    expect(result.current.controlsDisabled).toBe(false);

    await act(async () => {
      await result.current.load();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.marketplaces).toEqual([marketplace]);
  },
);

it("exposes raw failed list output as an error and recovers to an actually empty list", async () => {
  const client = createClient([]);
  client.listOmpPlugins.mockResolvedValueOnce({
    requestId: "bad-list",
    plugins: [],
    marketplace: [],
    rawOutput: "Native runtime returned invalid metadata",
  });
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("error"));
  expect(result.current.error).toBe("Native runtime returned invalid metadata");
  expect(result.current.marketplaces).toEqual([marketplace]);
  await act(async () => {
    await result.current.load();
  });
  expect(result.current.pageState).toBe("empty");
  expect(result.current.error).toBeNull();
});

it("cancels destructive removal and refreshes the list after acceptance", async () => {
  const client = createClient();
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1", "/work/project"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  vi.mocked(confirmDialog).mockResolvedValueOnce(false);
  await act(async () => {
    await result.current.remove(recoveredPlugin);
  });
  expect(client.removeOmpPlugin).not.toHaveBeenCalled();
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  expect(vi.mocked(confirmDialog).mock.calls[0]?.[0]).toMatchObject({ destructive: true });
  client.listOmpPlugins.mockResolvedValue({
    requestId: "removed-list",
    plugins: [],
    marketplace: [],
  });
  await act(async () => {
    await result.current.remove(recoveredPlugin);
  });
  expect(result.current.pageState).toBe("empty");
  expect(result.current.notice).toBe("applied");
});

it.each(["manual", "catalog"])(
  "keeps a canceled %s install open and requires executable-code trust",
  async (kind) => {
    const client = createClient();
    runtime.client = client;
    const { result } = renderHook(() => useOmpPlugins("server-1"));
    await waitFor(() => expect(result.current.pageState).toBe("ready"));
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await act(async () => {
      const installed =
        kind === "manual"
          ? await result.current.install("fresh-plugin@test-marketplace")
          : await result.current.installMarketplace(freshPlugin, marketplace.name, "user");
      expect(installed).toBe(false);
    });
    expect(client.installOmpPlugin).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
    expect(result.current.operation).toBeNull();
    const confirmation = vi.mocked(confirmDialog).mock.calls[0]?.[0];
    expect(confirmation?.message).toContain("fresh-plugin@test-marketplace");
    expect(confirmation?.message).toContain(ompPluginSettings.trustWarning);
    expect(confirmation?.destructive).toBe(false);
  },
);

it("keeps a dry-run installer open with its preview output and no install confirmation", async () => {
  const client = createClient();
  client.installOmpPlugin.mockResolvedValue({
    requestId: "preview",
    ok: true,
    plugin: null,
    output: "Would install the selected source",
  });
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  await act(async () => {
    expect(await result.current.install("fresh-plugin@test-marketplace", "user", true)).toBe(false);
  });
  expect(result.current.notice).toBe("preview");
  expect(result.current.output).toBe("Would install the selected source");
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  expect(client.listOmpPlugins).toHaveBeenCalledTimes(1);
  expect(confirmDialog).not.toHaveBeenCalled();
});

it.each(["native failure", "readback failure"])(
  "keeps the installer open on %s",
  async (failure) => {
    const client = createClient();
    runtime.client = client;
    const { result } = renderHook(() => useOmpPlugins("server-1"));
    await waitFor(() => expect(result.current.pageState).toBe("ready"));
    if (failure === "native failure")
      client.installOmpPlugin.mockResolvedValue({
        requestId: "failed-install",
        ok: false,
        plugin: null,
        output: "Source is unavailable",
      });
    else client.listOmpPlugins.mockRejectedValueOnce(new Error("Installed list is unavailable"));
    await act(async () => {
      expect(await result.current.install("new-package")).toBe(false);
    });
    expect(result.current.error).toBe(
      failure === "native failure" ? "Source is unavailable" : "Installed list is unavailable",
    );
    expect(result.current.operation).toBeNull();
    expect(result.current.controlsDisabled).toBe(false);
  },
);

it("rejects project operations without an applied cwd before confirmation or mutation", async () => {
  const client = createClient();
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  const projectPlugin = { ...recoveredPlugin, scope: "project" as const };
  for (const action of [
    () => result.current.install("fresh-plugin@test-marketplace", "project"),
    () => result.current.installMarketplace(freshPlugin, marketplace.name, "project"),
    () => result.current.toggle(projectPlugin, false),
    () => result.current.remove(projectPlugin),
    () => result.current.upgrade(projectPlugin),
  ]) {
    await act(async () => {
      expect(await action()).toBe(false);
    });
    expect(result.current.error).toBe(ompPluginSettings.scope.hint);
  }
  expect(confirmDialog).not.toHaveBeenCalled();
  expect(client.installOmpPlugin).not.toHaveBeenCalled();
  expect(client.setOmpPluginEnabled).not.toHaveBeenCalled();
  expect(client.removeOmpPlugin).not.toHaveBeenCalled();
  expect(client.upgradeOmpPlugin).not.toHaveBeenCalled();
});

it("serializes actions while trust is pending and drops approval after context changes", async () => {
  const client = createClient();
  const approval = Promise.withResolvers<boolean>();
  runtime.client = client;
  const { result, rerender } = renderHook(({ cwd }) => useOmpPlugins("server-1", cwd), {
    initialProps: { cwd: "/old/project" },
  });
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  vi.mocked(confirmDialog).mockReturnValueOnce(approval.promise);
  let installation!: Promise<boolean>;
  act(() => {
    installation = result.current.install("new-package");
  });
  expect(result.current.operation).toBe("install");
  expect(result.current.controlsDisabled).toBe(true);
  await act(async () => {
    expect(await result.current.remove(recoveredPlugin)).toBe(false);
  });
  expect(client.removeOmpPlugin).not.toHaveBeenCalled();
  rerender({ cwd: "/new/project" });
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  await act(async () => {
    approval.resolve(true);
    expect(await installation).toBe(false);
  });
  expect(client.installOmpPlugin).not.toHaveBeenCalled();
  expect(result.current.notice).toBeNull();
  expect(result.current.operation).toBeNull();
});

it.each(["project", "client", "connection"])(
  "ignores stale install completion after a %s change",
  async (change) => {
    const client = createClient();
    const installation = Promise.withResolvers<{
      requestId: string;
      ok: boolean;
      plugin: OmpPluginInfo | null;
      output?: string;
    }>();
    client.installOmpPlugin.mockReturnValueOnce(installation.promise);
    runtime.client = client;
    const { result, rerender } = renderHook(({ cwd }) => useOmpPlugins("server-1", cwd), {
      initialProps: { cwd: "/old/project" },
    });
    await waitFor(() => expect(result.current.pageState).toBe("ready"));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.install("new-package");
    });
    await waitFor(() => expect(client.installOmpPlugin).toHaveBeenCalledOnce());
    if (change === "client") runtime.client = createClient([]);
    if (change === "connection") runtime.connected = false;
    rerender({ cwd: change === "project" ? "/new/project" : "/old/project" });
    await waitFor(() =>
      expect(result.current.pageState).toBe(
        change === "connection" ? "offline" : change === "client" ? "empty" : "ready",
      ),
    );
    await act(async () => {
      installation.resolve({
        requestId: "stale-install",
        ok: true,
        plugin: null,
        output: "Old installation output",
      });
      expect(await pending).toBe(false);
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.output).toBeNull();
    expect(result.current.operation).toBeNull();
    expect(client.listOmpPlugins).toHaveBeenCalledTimes(change === "project" ? 2 : 1);
  },
);

it("drops an old load before issuing its catalog request and exposes only the new context", async () => {
  const client = createClient();
  const oldList = Promise.withResolvers<{
    requestId: string;
    plugins: OmpPluginInfo[];
    marketplace: [];
  }>();
  client.listOmpPlugins
    .mockReturnValueOnce(oldList.promise)
    .mockResolvedValue({ requestId: "new-context", plugins: [], marketplace: [] });
  runtime.client = client;
  const { result, rerender } = renderHook(({ cwd }) => useOmpPlugins("server-1", cwd), {
    initialProps: { cwd: "/old/project" },
  });
  rerender({ cwd: "/new/project" });
  await waitFor(() => expect(result.current.pageState).toBe("empty"));
  await act(async () => {
    oldList.resolve({ requestId: "old-context", plugins: [recoveredPlugin], marketplace: [] });
  });
  expect(result.current.plugins).toEqual([]);
  expect(client.listOmpPluginMarketplaces).toHaveBeenCalledExactlyOnceWith("/new/project");
});

it("keeps catalog readback failures visible and recovers a later marketplace addition", async () => {
  const client = createClient();
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1", "/work/project"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  client.listOmpPluginMarketplaces.mockRejectedValueOnce(
    new Error("Updated catalog could not be read"),
  );
  await act(async () => {
    expect(await result.current.addMarketplace("publisher/new-catalog")).toBe(false);
  });
  expect(result.current.error).toBe("Updated catalog could not be read");
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  const added = { name: "new-catalog", source: "publisher/new-catalog", plugins: [] };
  client.listOmpPluginMarketplaces.mockResolvedValue({
    requestId: "added-catalog",
    marketplaces: [marketplace, added],
  });
  await act(async () => {
    expect(await result.current.addMarketplace(" publisher/new-catalog ")).toBe(true);
  });
  expect(result.current.marketplaces).toEqual([marketplace, added]);
  expect(result.current.error).toBeNull();
  expect(result.current.notice).toBe("catalogRefreshed");
});

it("refreshes and removes marketplace metadata without upgrading installed code", async () => {
  const client = createClient();
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  const refreshed = { ...marketplace, plugins: [{ ...freshPlugin, version: "2.0.0" }] };
  client.listOmpPluginMarketplaces.mockResolvedValue({
    requestId: "catalog-refreshed",
    marketplaces: [refreshed],
  });
  await act(async () => {
    await result.current.refreshMarketplace(marketplace.name);
  });
  expect(result.current.marketplaces).toEqual([refreshed]);
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  expect(client.upgradeOmpPlugin).not.toHaveBeenCalled();
  client.listOmpPluginMarketplaces.mockResolvedValue({
    requestId: "catalog-removed",
    marketplaces: [],
  });
  await act(async () => {
    await result.current.removeMarketplace(marketplace.name);
  });
  expect(result.current.marketplaces).toEqual([]);
  expect(result.current.plugins).toEqual([recoveredPlugin]);
  expect(result.current.notice).toBe("catalogRefreshed");
});

it("makes an empty host selection offline without querying or installing against its client", async () => {
  const client = createClient();
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins(""));
  expect(result.current.pageState).toBe("offline");
  expect(result.current.controlsDisabled).toBe(true);
  await act(async () => {
    expect(await result.current.install("new-package")).toBe(false);
  });
  expect(client.listOmpPlugins).not.toHaveBeenCalled();
  expect(client.installOmpPlugin).not.toHaveBeenCalled();
  expect(confirmDialog).not.toHaveBeenCalled();
});

it("keeps actions locked while catalogs load and shares concurrent list readback", async () => {
  const client = createClient();
  const catalog = Promise.withResolvers<{
    requestId: string;
    marketplaces: (typeof marketplace)[];
  }>();
  client.listOmpPluginMarketplaces.mockReturnValueOnce(catalog.promise);
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.plugins).toEqual([recoveredPlugin]));
  expect(result.current.controlsDisabled).toBe(true);
  let readback!: Promise<boolean>;
  act(() => {
    readback = result.current.load();
  });
  await act(async () => {
    expect(await result.current.toggle(recoveredPlugin, false)).toBe(false);
  });
  expect(client.setOmpPluginEnabled).not.toHaveBeenCalled();
  await act(async () => {
    catalog.resolve({ requestId: "catalog-loaded", marketplaces: [marketplace] });
    expect(await readback).toBe(true);
  });
  expect(client.listOmpPlugins).toHaveBeenCalledTimes(1);
  expect(result.current.pageState).toBe("ready");
  expect(result.current.controlsDisabled).toBe(false);
});

it("never upgrades a linked plugin through installed or catalog actions", async () => {
  const linked = { ...recoveredPlugin, linked: true };
  const client = createClient([linked]);
  runtime.client = client;
  const { result } = renderHook(() => useOmpPlugins("server-1"));
  await waitFor(() => expect(result.current.pageState).toBe("ready"));
  await act(async () => {
    expect(await result.current.upgrade(linked)).toBe(false);
    expect(
      await result.current.installMarketplace(
        { name: "recovered-plugin", version: "2.0.0" },
        marketplace.name,
        "user",
      ),
    ).toBe(false);
  });
  expect(client.upgradeOmpPlugin).not.toHaveBeenCalled();
  expect(confirmDialog).not.toHaveBeenCalled();
  expect(result.current.plugins).toEqual([linked]);
  expect(result.current.notice).toBeNull();
});

it.each([
  { source: " fresh-plugin@test-marketplace ", expected: true },
  { source: "fresh-plugin@unknown-marketplace", expected: false },
  { source: "package@latest", expected: false },
  { source: "package@1.2.3", expected: false },
  { source: "@publisher/package@test-marketplace", expected: false },
  { source: "/work/plugin@test-marketplace", expected: false },
  { source: ".\\plugin@test-marketplace", expected: false },
  { source: "https://example.com/plugin@test-marketplace", expected: false },
])("classifies shared manual scope availability for $source", ({ source, expected }) => {
  const catalogs = [{ name: "test-marketplace" }, { name: "latest" }, { name: "1.2.3" }] as const;
  expect(isOmpMarketplaceSpec(source, catalogs)).toBe(expected);
});
