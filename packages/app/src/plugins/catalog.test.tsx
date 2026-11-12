// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineRpc, useRpc } from "@omp-desktop/plugin";
import { PluginRpcProvider } from "@omp-desktop/plugin/host";
import { z } from "zod";
import type { PluginClientContext } from "@omp-desktop/plugin";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import { HostPluginCatalogBridge } from "./catalog";
import { usePluginClientSnapshot, usePluginContributions } from "./hooks";
import { pluginClientRegistry } from "./registry";

type CatalogSnapshot = { plugins: DesktopPluginCatalogEntry[]; revision: number; pluginsEnabled: boolean };
type CatalogStatus = { payload: { status: "plugin_catalog_changed"; pluginId: string; generation: number } };
interface CatalogClient {
  getPluginCatalogSnapshot(): Promise<CatalogSnapshot>;
  on(event: string, listener: (message: CatalogStatus) => void): () => void;
  invokePluginRpc(): Promise<unknown>;
}
const fixture = vi.hoisted(() => ({ client: null as CatalogClient | null, snapshot: null as { client: CatalogClient; connectionStatus: "online"; connectionEpoch: number } | null, listeners: new Set<(message: CatalogStatus) => void>(), nextSnapshot: null as Promise<CatalogSnapshot> | null, resolveRpc: null as ((value: unknown) => void) | null }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeSnapshot: () => fixture.snapshot, getHostRuntimeStore: () => { throw new Error("Counter does not acquire a Paseo session"); } }));
vi.mock("./client-trust", () => ({ hasPluginClientTrust: async () => true, subscribePluginClientTrust: () => () => {} }));
vi.mock("./load", () => ({ loadTrustedPluginClient: () => (context: PluginClientContext) => { context.addSurface("counter", Counter); } }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => undefined }));

const contract = defineRpc({ name: "increment", input: z.object({}), output: z.number() });
function Counter() {
  const rpc = useRpc(contract);
  const [count, setCount] = useState(0);
  return <button onClick={() => { void rpc({}).then(setCount, () => {}); }}>Count {count}</button>;
}
function Surface({ activeOnly = false }: { activeOnly?: boolean }) {
  const snapshot = usePluginClientSnapshot();
  const instance = snapshot.instances.find(({ installation }) => installation.id === "counter");
  const active = usePluginContributions("surface");
  const component = activeOnly
    ? active.find(({ instance }) => instance.installation.id === "counter")?.contribution.Component
    : instance?.contributions.surface[0]?.Component;
  if (!instance || !component) return null;
  const Component = component;
  return <PluginRpcProvider key={instance.scope.id} invoke={instance.invoke}><Component theme={{ colors: { surface0: "white", foreground: "black", foregroundMuted: "gray", accent: "blue", accentForeground: "white", statusDanger: "red" } }} host={{ id: "owned-host", label: "Owned host" }} layout={{ compact: false, platform: "web" }} /></PluginRpcProvider>;
}
const entry = (generation: number): DesktopPluginCatalogEntry => ({ id: "counter", packageId: "counter", owner: "daemon", generation, revision: 1, version: "1.0.0", enabled: false, effectiveEnabled: false, installed: true, bundled: false, metadata: null, trusted: true, status: "disabled", format: "package", source: { type: "directory", path: "/owned/counter" }, declaredCapabilities: [], grantedCapabilities: [], clientBundle: "counter-bundle" });
const snapshot = (generation: number, revision: number) => ({ plugins: [entry(generation)], revision, pluginsEnabled: false });
function notify(generation: number) { for (const listener of fixture.listeners) listener({ payload: { status: "plugin_catalog_changed", pluginId: "counter", generation } }); }
beforeEach(() => {
  fixture.listeners.clear(); fixture.nextSnapshot = null; fixture.resolveRpc = null;
  fixture.client = { getPluginCatalogSnapshot: () => fixture.nextSnapshot ?? Promise.resolve(snapshot(1, 1)), on: (_event: string, listener: (message: CatalogStatus) => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); }, invokePluginRpc: () => new Promise(resolve => { fixture.resolveRpc = resolve; }) };
  fixture.snapshot = { client: fixture.client, connectionStatus: "online", connectionEpoch: 1 };
});
afterEach(async () => { cleanup(); await Promise.all(pluginClientRegistry.getSnapshot().instances.map(instance => instance.scope.dispose())); });

describe("daemon client catalog lifetime", () => {
  it("keeps local state and an in-flight RPC across same-generation catalog updates", async () => {
    render(<><HostPluginCatalogBridge hostId="owned-host" /><Surface /></>);
    fireEvent.click(await screen.findByText("Count 0"));
    await waitFor(() => expect(fixture.resolveRpc).not.toBeNull());
    const original = pluginClientRegistry.getSnapshot().instances[0];
    await act(async () => { notify(1); await Promise.resolve(); fixture.resolveRpc!(7); });
    await screen.findByText("Count 7");
    expect(original.scope.signal.aborted).toBe(false);
    expect(pluginClientRegistry.getSnapshot().instances[0]).toBe(original);
    await act(async () => { notify(1); });
    expect(screen.getByText("Count 7")).toBeTruthy();
  });
  it("retires changed-generation code before its replacement catalog arrives", async () => {
    render(<><HostPluginCatalogBridge hostId="owned-host" /><Surface /></>);
    fireEvent.click(await screen.findByText("Count 0"));
    await waitFor(() => expect(fixture.resolveRpc).not.toBeNull());
    const old = pluginClientRegistry.getSnapshot().instances[0];
    let releaseSnapshot!: (value: CatalogSnapshot) => void;
    fixture.nextSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
    await act(async () => { notify(2); });
    expect(old.scope.signal.aborted).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => { fixture.resolveRpc!(9); releaseSnapshot(snapshot(2, 2)); });
    await screen.findByText("Count 0");
    expect(screen.queryByText("Count 9")).toBeNull();
    expect(pluginClientRegistry.getSnapshot().instances[0].installation.generation).toBe(2);
  });
  it("keeps an enabled waiting plugin usable through its transition to running", async () => {
    const waiting = { ...entry(1), enabled: true, effectiveEnabled: true, status: "waiting" as const, waitingReason: "Waiting for account credentials" };
    fixture.nextSnapshot = Promise.resolve({ plugins: [waiting], revision: 1, pluginsEnabled: true });
    render(<><HostPluginCatalogBridge hostId="owned-host" /><Surface activeOnly /></>);
    fireEvent.click(await screen.findByText("Count 0"));
    await waitFor(() => expect(fixture.resolveRpc).not.toBeNull());
    const original = pluginClientRegistry.getSnapshot().instances[0];
    fixture.nextSnapshot = Promise.resolve({ plugins: [{ ...waiting, status: "running", waitingReason: undefined }], revision: 2, pluginsEnabled: true });
    await act(async () => { notify(1); fixture.resolveRpc!(7); });
    await screen.findByText("Count 7");
    expect(pluginClientRegistry.getSnapshot().instances[0]).toBe(original);
    expect(original.scope.signal.aborted).toBe(false);
  });
});
