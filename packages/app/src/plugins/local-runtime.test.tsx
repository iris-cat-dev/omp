// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPluginSnapshot } from "@omp-desktop/protocol/desktop-local-plugins";
import type { DesktopPluginsBridge } from "@/desktop/host";
import { LocalPluginCatalogBridge } from "./local-runtime";
import { getLocalPluginControl } from "./local-control";
import { usePluginContributions } from "./hooks";
import { pluginClientRegistry } from "./registry";

const fixture = vi.hoisted(() => ({
  native: null as Pick<DesktopPluginsBridge, "getSnapshot" | "openClientScope" | "releaseClientScope" | "publish"> | null,
  snapshot: null as LocalPluginSnapshot | null,
  listeners: new Set<() => void>(),
}));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => fixture.native ? { plugins: fixture.native } : null }));
vi.mock("@/desktop/electron/events", () => ({ listenToDesktopEvent: async (_event: string, listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; } }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useLocalDaemonServerId: () => null }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: () => { throw new Error("This client does not request a daemon"); } }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => undefined }));
vi.mock("react-native", () => ({ Platform: { OS: "web" }, Text: "span", View: "div" }));
vi.mock("react-native-unistyles", () => import("../../test-stubs/react-native-unistyles"));

// The installed folder supplies executable code; exercise the real bundle loader,
// activation context, registry and stateful contribution rather than a loader mock.
const bundle = `(require) => {
  const React = require("react");
  return (context) => context.addSurface("counter", function Counter() {
    const [count, setCount] = React.useState(0);
    return React.createElement("button", { onClick: () => setCount(value => value + 1) }, "Folder count " + count);
  });
}`;
function snapshot(enabled: boolean, revision: number): LocalPluginSnapshot {
  return { revision, backgroundProvider: null, installations: [{
    id: "folder-counter", packageId: "folder-counter", owner: "desktop", version: "1.0.0", generation: revision,
    enabled, installed: true, source: { type: "local", identity: "/owned/folder-counter" }, trusted: true,
    config: { saved: "user preference" }, declaredCapabilities: [], grantedCapabilities: [], revision, migrationVersion: 1,
    format: "package", metadata: null, status: enabled ? "active" : "disabled", error: null, clientBundle: bundle,
  }] };
}
function Surface() {
  const entries = usePluginContributions("surface");
  const entry = entries.find(({ instance }) => instance.installation.id === "folder-counter");
  if (!entry) return null;
  const Component = entry.contribution.Component;
  return <Component key={entry.instance.scope.id} theme={{ colors: { surface0: "white", foreground: "black", foregroundMuted: "gray", accent: "blue", accentForeground: "white", statusDanger: "red" } }} host={{ id: "desktop", label: "Desktop" }} layout={{ compact: false, platform: "web" }} />;
}
beforeEach(() => {
  fixture.listeners.clear();
  fixture.snapshot = snapshot(true, 1);
  fixture.native = {
    getSnapshot: async () => fixture.snapshot!,
    openClientScope: vi.fn(async () => undefined),
    releaseClientScope: vi.fn(async () => undefined),
    publish: async () => { throw new Error("This client does not invoke host services"); },
  };
});
afterEach(async () => {
  cleanup();
  await Promise.all(pluginClientRegistry.getSnapshot().instances.map(instance => instance.scope.dispose()));
  fixture.native = null;
});

describe("folder client activation", () => {
  it("loads the supplied client, retires disabled contributions and restores them on enable", async () => {
    render(<><LocalPluginCatalogBridge /><Surface /></>);
    fireEvent.click(await screen.findByText("Folder count 0"));
    await screen.findByText("Folder count 1");
    const previous = pluginClientRegistry.getSnapshot().instances[0];
    await act(async () => {
      fixture.snapshot = snapshot(false, 2);
      for (const listener of fixture.listeners) listener();
    });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(previous.scope.signal.aborted).toBe(true);
    expect(fixture.snapshot!.installations[0].config).toEqual({ saved: "user preference" });
    await act(async () => {
      fixture.snapshot = snapshot(true, 3);
      for (const listener of fixture.listeners) listener();
    });
    await screen.findByText("Folder count 0");
  });

  it("does not invent a local client installation when the native host is absent", () => {
    fixture.native = null;
    render(<LocalPluginCatalogBridge />);
    expect(pluginClientRegistry.getSnapshot().instances).toHaveLength(0);
    expect(() => getLocalPluginControl()).toThrow("Local plugins require the native Desktop host");
  });
});
