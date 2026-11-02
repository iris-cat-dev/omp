// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient, ProviderSubagentTimelinePayload } from "@omp-desktop/client/internal/daemon-client";
import type { ProviderSubagentDescriptorPayload } from "@omp-desktop/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { providerSubagentPanelRegistration } from "./provider-subagent-panel";

vi.mock("@/agent-stream/view", () => ({ AgentStreamView: () => null }));
vi.mock("@/components/provider-icons", () => ({ getProviderIcon: () => () => null }));
vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "panel-server",
    target: { kind: "provider_subagent", parentAgentId: "parent", subagentId: "child" },
    openFileInWorkspace: () => {},
  }),
}));

const SERVER = "panel-server";
const target = { kind: "provider_subagent" as const, parentAgentId: "parent", subagentId: "child" };
const context = { serverId: SERVER, workspaceId: "workspace", tabId: "tab" };
const descriptor: ProviderSubagentDescriptorPayload = {
  id: "child", parentAgentId: "parent", provider: "omp", title: "Explore",
  description: "Inspect the repository", model: "openai/gpt-5", status: "running",
  createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", toolCallId: "dispatch",
};
const missingTimeline: ProviderSubagentTimelinePayload = {
  requestId: "tail", parentAgentId: "parent", subagentId: "child", provider: null,
  direction: "tail", epoch: "epoch", reset: false, staleCursor: false, gap: false,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, hasOlder: false, hasNewer: false, rows: [], error: null,
};

beforeEach(async () => {
  vi.stubGlobal("React", React);
  if (!i18n.isInitialized) await i18n.init();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(SERVER);
  useProviderSubagentStore.setState({
    descriptors: new Map(), timelines: new Map(), hiddenFromTrack: new Set(),
    connectionGenerations: new Map(), listSync: new Map(), timelineSync: new Map(),
    liveRevisions: new Map(), runVersions: new Map(),
  });
  vi.unstubAllGlobals();
});

function initialize(client: Pick<DaemonClient, "listProviderSubagents" | "fetchProviderSubagentTimeline">) {
  useSessionStore.getState().initializeSession(SERVER, client as DaemonClient);
  useSessionStore.getState().updateSessionServerInfo(SERVER, {
    serverId: SERVER, hostname: "host", version: "test", features: { providerSubagents: true },
  });
}

describe("provider child panel recovery states", () => {
  it("settles a missing child instead of loading forever, then opens it after an explicit retry", async () => {
    const client = {
      listProviderSubagents: vi.fn(async () => ({ requestId: "list", parentAgentId: "parent", subagents: [] as ProviderSubagentDescriptorPayload[], error: null })),
      fetchProviderSubagentTimeline: vi.fn(async () => missingTimeline),
    };
    initialize(client);
    const Panel = providerSubagentPanelRegistration.component;
    render(<Panel />);
    const title = renderHook(() => providerSubagentPanelRegistration.useDescriptor(target, context));
    await waitFor(() => expect(screen.getByText("Agent not found")).toBeTruthy());
    expect(title.result.current.titleState).toBe("ready");
    expect(title.result.current.label).toBe("Agent not found");

    client.listProviderSubagents.mockResolvedValueOnce({ requestId: "new-list", parentAgentId: "parent", subagents: [descriptor], error: null });
    client.fetchProviderSubagentTimeline.mockResolvedValue({ ...missingTimeline, provider: "omp" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.getByTestId("provider-subagent-panel")).toBeTruthy());
    expect(screen.queryByText("Agent not found")).toBeNull();
    expect(title.result.current.label).toBe("Inspect the repository");
    expect(screen.getByTestId("provider-subagent-pane-subtitle").textContent).toContain("openai/gpt-5");
  });

  it("presents a failed sync with a retry action rather than a permanent loading tab", async () => {
    initialize({
      listProviderSubagents: vi.fn(async () => { throw new Error("offline"); }),
      fetchProviderSubagentTimeline: vi.fn(async () => { throw new Error("offline"); }),
    });
    const Panel = providerSubagentPanelRegistration.component;
    render(<Panel />);
    const title = renderHook(() => providerSubagentPanelRegistration.useDescriptor(target, context));
    await waitFor(() => expect(screen.getByText("Failed to load agent")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(title.result.current.titleState).toBe("ready");
  });
});
