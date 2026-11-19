// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSurfaceScreen } from "./surface-screen";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  canGoBack: vi.fn(() => false),
  selectMemory: vi.fn(async () => {}),
  hosts: [
    { serverId: "host-a", label: "MX0KQTV64D" },
    { serverId: "host-b", label: "Remote-Linux" },
  ],
  sidebar: [] as Array<{
    key: string;
    instance: {
      hostId: string;
      installation: { id: string; owner: "desktop" | "daemon" };
      scope: { assertCurrent: () => void };
    };
    contribution: { id: string; title: string; surface: string };
  }>,
  surfaces: [] as Array<{
    key: string;
    instance: {
      hostId: string;
      installation: { id: string; owner: "desktop" | "daemon" };
      scope: { assertCurrent: () => void };
    };
    contribution: { id: string; Component: React.ComponentType };
  }>,
}));

vi.mock("expo-router", () => ({
  router: {
    replace: mocks.replace,
    push: mocks.push,
    back: mocks.back,
    canGoBack: mocks.canGoBack,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "plugins.daemon": "主机 daemon",
        "plugins.environment.native-desktop": "本机 Desktop",
        "plugins.close": "关闭",
        "plugins.unavailable": "插件不可用",
        "plugins.configure": "配置",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ title, rightContent }: { title?: string; rightContent?: React.ReactNode }) => (
    <div data-testid="menu-header">
      <span>{title}</span>
      <div>{rightContent}</div>
    </div>
  ),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mocks.hosts,
}));

vi.mock("./hooks", () => ({
  usePluginContributions: (kind: "surface" | "sidebar") =>
    kind === "sidebar" ? mocks.sidebar : mocks.surfaces,
}));

vi.mock("./view", () => ({
  usePluginHostProps: () => ({
    host: { id: "host-a", label: "MX0KQTV64D" },
    layout: { compact: false, platform: "web" },
    theme: { colors: {} },
  }),
  PluginView: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="plugin-view">{children}</div>
  ),
}));

vi.mock("./selection-memory", () => ({
  pluginSelectionMemory: {
    select: mocks.selectMemory,
  },
}));

function makeEntry(hostId: string) {
  const scope = { assertCurrent: vi.fn() };
  const instance = {
    hostId,
    installation: { id: "qqbot", owner: "daemon" as const },
    scope,
  };
  return {
    sidebar: {
      key: `daemon:${hostId}:qqbot:sidebar`,
      instance,
      contribution: { id: "qqbot", title: "QQ 连接", surface: "qqbot" },
    },
    surface: {
      key: `daemon:${hostId}:qqbot:surface`,
      instance,
      contribution: {
        id: "qqbot",
        Component: () => <div data-testid={`qqbot-body-${hostId}`}>QQ Body {hostId}</div>,
      },
    },
  };
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.selectMemory.mockClear();
  mocks.sidebar = [];
  mocks.surfaces = [];
});

afterEach(cleanup);

const qqbotSidebarIdentity = { kind: "sidebar" as const, id: "qqbot" };

describe("PluginSurfaceScreen host switcher", () => {
  it("hides the host switcher bar when only the current host is available and shows a quiet badge in the header", () => {
    const a = makeEntry("host-a");
    mocks.sidebar = [a.sidebar];
    mocks.surfaces = [a.surface];

    render(
      <PluginSurfaceScreen
        hostId="host-a"
        owner="daemon"
        pluginId="qqbot"
        identity={qqbotSidebarIdentity}
      />,
    );

    expect(screen.queryByTestId("plugin-surface-host-switcher-bar")).toBeNull();
    expect(screen.getByTestId("plugin-surface-host-badge").textContent).toBe(
      "主机 daemon · MX0KQTV64D",
    );
    expect(screen.getByTestId("qqbot-body-host-a")).toBeTruthy();
  });

  it("renders a segmented host switcher when multiple hosts provide the plugin and navigates on switch", async () => {
    const a = makeEntry("host-a");
    const b = makeEntry("host-b");
    mocks.sidebar = [a.sidebar, b.sidebar];
    mocks.surfaces = [a.surface, b.surface];

    render(
      <PluginSurfaceScreen
        hostId="host-a"
        owner="daemon"
        pluginId="qqbot"
        identity={qqbotSidebarIdentity}
      />,
    );

    expect(screen.queryByTestId("plugin-surface-host-badge")).toBeNull();
    expect(screen.getByTestId("plugin-surface-host-switcher-bar")).toBeTruthy();

    fireEvent.click(screen.getByText("主机 daemon · Remote-Linux"));

    await waitFor(() => {
      expect(mocks.selectMemory).toHaveBeenCalledWith(
        "sidebar",
        "qqbot/sidebar/qqbot",
        "host-b",
        "daemon",
      );
      expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining("host-b"));
    });
  });

  it("keeps the switcher visible when the routed host is unavailable so the user can switch to an available host", () => {
    const b = makeEntry("host-b");
    mocks.sidebar = [b.sidebar];
    mocks.surfaces = [b.surface];

    render(
      <PluginSurfaceScreen
        hostId="host-offline"
        owner="daemon"
        pluginId="qqbot"
        identity={qqbotSidebarIdentity}
      />,
    );

    expect(screen.getByTestId("plugin-surface-host-switcher-bar")).toBeTruthy();
    expect(screen.getByText("主机 daemon · Remote-Linux")).toBeTruthy();
  });
});
