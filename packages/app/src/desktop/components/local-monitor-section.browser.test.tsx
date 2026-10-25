import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { DesktopLocalMonitorSection } from "./local-monitor-section";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let client: QueryClient;
let previousBridge: DesktopHostBridge | undefined;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousBridge = window.paseoDesktop;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.paseoDesktop = {
    platform: "win32",
    invoke: async (command) => {
      if (command !== "desktop_daemon_status") throw new Error("Unexpected desktop operation");
      return {
        serverId: "local-host",
        status: "running",
        home: "owned-fixture",
        desktopManaged: true,
      };
    },
    monitor: { open: async () => undefined },
  };
});
afterEach(async () => {
  cleanup();
  await client.cancelQueries();
  client.clear();
  window.paseoDesktop = previousBridge;
  vi.unstubAllGlobals();
});

function surface(serverId: string) {
  return (
    <QueryClientProvider client={client}>
      <DesktopLocalMonitorSection serverId={serverId} />
    </QueryClientProvider>
  );
}

it("does not misrepresent local monitoring as a remote host's Usage feature", async () => {
  const mounted = render(surface("local-host"));
  await screen.findByTestId("omp-local-monitor-section");
  mounted.rerender(surface("remote-host"));
  expect(screen.queryByTestId("omp-local-monitor-section")).toBeNull();
  mounted.rerender(surface("local-host"));
  await screen.findByTestId("omp-local-monitor-open");
  window.paseoDesktop = { platform: "win32" };
  mounted.rerender(surface("local-host"));
  expect(screen.queryByTestId("omp-local-monitor-section")).toBeNull();
});

it("shows a recoverable opening failure without leaking native paths", async () => {
  window.paseoDesktop!.monitor!.open = async () => {
    throw new Error("C:/private/monitor/native-failure");
  };
  const mounted = render(surface("local-host"));
  fireEvent.click(await screen.findByTestId("omp-local-monitor-open"));
  await screen.findByText("providerUsage.localMonitor.openFailed");
  expect(document.body.textContent).not.toContain("C:/private/monitor");
  window.paseoDesktop!.monitor!.open = async () => undefined;
  mounted.rerender(surface("local-host"));
  fireEvent.click(screen.getByTestId("omp-local-monitor-open"));
  await waitFor(() =>
    expect(screen.queryByText("providerUsage.localMonitor.openFailed")).toBeNull(),
  );
});
