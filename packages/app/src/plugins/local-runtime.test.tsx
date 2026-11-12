// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalPluginCatalogBridge } from "./local-runtime";
import { getLocalPluginControl } from "./local-control";
import { collectPluginContributions, pluginClientRegistry } from "./registry";

const fixtures = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: vi.fn(),
  native: null as { plugins: Record<string, unknown> } | null,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => fixtures.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { fixtures.writes(key, value); fixtures.values.set(key, value); },
  removeItem: async (key: string) => { fixtures.values.delete(key); },
} }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => fixtures.native }));
vi.mock("@/desktop/electron/events", () => ({ listenToDesktopEvent: async () => () => undefined }));
vi.mock("@/desktop/plugins/client-hosts", () => ({ configureBuiltinPluginClientHosts: () => undefined }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useLocalDaemonServerId: () => null }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: () => { throw new Error("Renderer speed must not request a daemon"); } }));
vi.mock("@omp-desktop/plugin-desktop-pet", () => ({ default: () => { throw new Error("Pet cannot run in renderer-only mode"); } }));
vi.mock("@omp-desktop/plugin-wallpaper", () => ({ default: () => { throw new Error("Wallpaper cannot run in renderer-only mode"); } }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => undefined }));
vi.mock("react-native", () => ({ Platform: { OS: "web" }, Text: "span", View: "div" }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: (factory: (theme: unknown) => unknown) => factory({ colors: { foregroundMuted: "gray", surface2: "white" }, borderRadius: { full: 999 }, spacing: { 2: 8 } }) } }));
beforeAll(() => {
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: (_name: string, operation: () => Promise<unknown>) => { const result = queue.then(operation, operation); queue = result; return result; },
  } });
});
afterEach(() => { cleanup(); fixtures.native = null; });

describe("intrinsic client plugin activation", () => {
  it("activates the real speed contribution without native/daemon services and persists disable/restore", async () => {
    const view = render(<LocalPluginCatalogBridge />);
    await waitFor(() => expect(collectPluginContributions(pluginClientRegistry.getSnapshot(), "metric").map(({ contribution }) => contribution.id)).toEqual(["output-speed"]));
    const control = getLocalPluginControl();
    expect(control.environment).toBe("web-client");
    const instance = pluginClientRegistry.getSnapshot().instances[0];
    await expect(instance.context.native.invoke("anything")).rejects.toThrow("does not support native operations");
    expect(() => instance.context.native.subscribe("anything", () => undefined)).toThrow("does not support native subscriptions");
    await expect(instance.context.secrets.configured("key")).rejects.toThrow("does not support secrets");
    await expect(instance.invoke("anything", {})).rejects.toThrow("does not support service RPC");
    await control.patch({ installationId: "agent-speed", expectedRevision: 0, patch: { enabled: false } });
    await waitFor(() => expect(collectPluginContributions(pluginClientRegistry.getSnapshot(), "metric")).toHaveLength(0));
    view.unmount();
    const restored = render(<LocalPluginCatalogBridge />);
    await waitFor(() => expect(pluginClientRegistry.getSnapshot().instances[0]?.mode).toBe("manage"));
    expect((await control.getSnapshot()).installations[0].enabled).toBe(false);
    await control.patch({ installationId: "agent-speed", expectedRevision: 1, patch: { enabled: true } });
    await waitFor(() => expect(collectPluginContributions(pluginClientRegistry.getSnapshot(), "metric")).toHaveLength(1));
    restored.unmount();
  });
});
