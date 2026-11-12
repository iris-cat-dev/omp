// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivationScope, type PluginActivationScope } from "@omp-desktop/plugin/host";
import type { PluginHostProps } from "@omp-desktop/plugin";
import setupQQClient from "@omp-desktop/plugin-qqbot";
import { setupPluginClient } from "./context";
import { collectPluginContributions, createPluginClientRegistry } from "./registry";
import { validatePluginContribution } from "./contribution-validation";

vi.mock("./icons", () => ({ resolvePluginIcon: () => () => <svg /> }));

const scopes: PluginActivationScope[] = [];
const unavailable = (): never => { throw new Error("Unexpected host operation in QQ page scenario"); };
const props: PluginHostProps = {
  theme: { colors: { surface0: "white", foreground: "black", foregroundMuted: "gray", accent: "blue", accentForeground: "white", statusDanger: "red" } },
  host: { id: "owned-host", label: "Owned host" },
  layout: { compact: false, platform: "web" },
};
afterEach(async () => {
  cleanup();
  await Promise.all(scopes.splice(0).map(scope => scope.dispose()));
});

describe("plugin contribution identifier boundary", () => {
  it.each(["manage", "active"] as const)("loads the real QQ account page in %s mode", async mode => {
    const scope = createActivationScope(1);
    scopes.push(scope);
    const state = {};
    const snapshot = {
      generation: 1, connection: "waiting", reason: null, appId: "",
      secretConfigured: false, binding: { phase: "idle" }, config: {},
      access: {}, peers: [], challenges: [], importReport: [],
    };
    const instance = await setupPluginClient({
      hostId: props.host.id,
      installation: { id: "qqbot", packageId: "qqbot", owner: "daemon", version: "1.0.0", generation: 1, enabled: mode === "active", declaredCapabilities: [], grantedCapabilities: [] },
      mode, format: "package", scope, setup: setupQQClient,
      services: {
        getOmp: unavailable,
        storage: { get: async <T,>() => ({ values: state as T, revision: 0 }), patch: async () => unavailable() },
        secrets: { configured: async () => unavailable(), set: async () => unavailable(), delete: async () => unavailable() },
        native: { invoke: async () => unavailable(), subscribe: unavailable },
        invoke: async method => { if (method !== "qqbot.status") return unavailable(); return snapshot; },
      },
    });
    if (!instance) throw new Error("QQ client activation was cancelled");
    const registry = createPluginClientRegistry();
    registry.replace(instance);
    const settings = collectPluginContributions(registry.getSnapshot(), "settings");
    const Page = settings[0].contribution.Component;
    await act(async () => { render(<Page {...props} installation={instance.installation} mode={mode} />); });
    const appId = screen.getByLabelText("QQ AppID");
    fireEvent.change(appId, { target: { value: "owned-qq-account" } });
    expect((appId as HTMLInputElement).value).toBe("owned-qq-account");
    expect(screen.getByLabelText("QQ AppSecret")).toBeTruthy();
    expect(collectPluginContributions(registry.getSnapshot(), "sidebar").map(({ contribution }) => contribution.surface)).toEqual(mode === "active" ? ["qqbot"] : []);
  });

  it.each(["qqbot..settings", ".qqbot", "qqbot.", "qqbot/settings", "qqbot:settings", "qqbot settings"])("rejects malformed or path-like contribution id %s", id => {
    expect(() => validatePluginContribution("settings", { id, title: "Account", Component: () => null })).toThrow("Invalid plugin settings id");
  });
});
