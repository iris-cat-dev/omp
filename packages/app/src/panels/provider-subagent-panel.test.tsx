// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DaemonClient,
  type DaemonTransport,
  type ProviderSubagentTimelinePayload,
} from "@omp-desktop/client/internal/daemon-client";
import type { ProviderSubagentDescriptorPayload } from "@omp-desktop/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { providerSubagentPanelRegistration } from "./provider-subagent-panel";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useSubagentsForParent } from "@/subagents/select";

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
  id: "child",
  parentAgentId: "parent",
  provider: "omp",
  title: "Explore",
  description: "Inspect the repository",
  model: "openai/gpt-5",
  status: "running",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  toolCallId: "dispatch",
};
const missingTimeline: ProviderSubagentTimelinePayload = {
  requestId: "tail",
  parentAgentId: "parent",
  subagentId: "child",
  provider: null,
  direction: "tail",
  epoch: "epoch",
  reset: false,
  staleCursor: false,
  gap: false,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
  hasOlder: false,
  hasNewer: false,
  rows: [],
  error: null,
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
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
    connectionGenerations: new Map(),
    listSync: new Map(),
    timelineSync: new Map(),
    liveRevisions: new Map(),
    runVersions: new Map(),
  });
  vi.unstubAllGlobals();
});

function initialize(
  client: Pick<
    DaemonClient,
    | "listProviderSubagents"
    | "fetchProviderSubagentTimeline"
    | "acquireProviderSubagentSubscription"
    | "getProviderSubagentSubscriptions"
  >,
) {
  useSessionStore.getState().initializeSession(SERVER, client as DaemonClient);
  useSessionStore.getState().updateSessionServerInfo(SERVER, {
    serverId: SERVER,
    hostname: "host",
    version: "test",
    features: { providerSubagents: true },
  });
}

describe("provider child panel recovery states", () => {
  it("settles a missing child instead of loading forever, then opens it after an explicit retry", async () => {
    const client = {
      listProviderSubagents: vi.fn(async () => ({
        requestId: "list",
        parentAgentId: "parent",
        subagents: [] as ProviderSubagentDescriptorPayload[],
        error: null,
      })),
      fetchProviderSubagentTimeline: vi.fn(async () => missingTimeline),
      acquireProviderSubagentSubscription: vi.fn(async () => () => {}),
      getProviderSubagentSubscriptions: () => ({
        parentAgentIds: ["parent"],
        timelines: [{ parentAgentId: "parent", subagentId: "child" }],
      }),
    };
    initialize(client);
    const Panel = providerSubagentPanelRegistration.component;
    render(<Panel />);
    const title = renderHook(() =>
      providerSubagentPanelRegistration.useDescriptor(target, context),
    );
    await waitFor(() => expect(screen.getByText("Agent not found")).toBeTruthy());
    expect(title.result.current.titleState).toBe("ready");
    expect(title.result.current.label).toBe("Agent not found");

    client.listProviderSubagents.mockResolvedValueOnce({
      requestId: "new-list",
      parentAgentId: "parent",
      subagents: [descriptor],
      error: null,
    });
    client.fetchProviderSubagentTimeline.mockResolvedValue({ ...missingTimeline, provider: "omp" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.getByTestId("provider-subagent-panel")).toBeTruthy());
    expect(screen.queryByText("Agent not found")).toBeNull();
    expect(title.result.current.label).toBe("Inspect the repository");
    expect(screen.getByTestId("provider-subagent-pane-subtitle").textContent).toContain(
      "openai/gpt-5",
    );
  });

  it("presents a failed sync with a retry action rather than a permanent loading tab", async () => {
    initialize({
      listProviderSubagents: vi.fn(async () => {
        throw new Error("offline");
      }),
      fetchProviderSubagentTimeline: vi.fn(async () => {
        throw new Error("offline");
      }),
      acquireProviderSubagentSubscription: vi.fn(async () => () => {}),
      getProviderSubagentSubscriptions: () => ({
        parentAgentIds: ["parent"],
        timelines: [{ parentAgentId: "parent", subagentId: "child" }],
      }),
    });
    const Panel = providerSubagentPanelRegistration.component;
    render(<Panel />);
    const title = renderHook(() =>
      providerSubagentPanelRegistration.useDescriptor(target, context),
    );
    await waitFor(() => expect(screen.getByText("Failed to load agent")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(title.result.current.titleState).toBe("ready");
  });

  it("removes an unacknowledged real-client lease synchronously when a disconnected panel closes", async () => {
    const sent: Array<string | Uint8Array | ArrayBuffer> = [];
    let onOpen = () => {};
    let onClose: (event?: unknown) => void = () => {};
    let onMessage: (data: unknown, isBinary: boolean) => void = () => {};
    const transport: DaemonTransport = {
      send: (data) => {
        sent.push(data);
      },
      close: () => {},
      onOpen: (listener) => {
        onOpen = listener;
        return () => {};
      },
      onClose: (listener) => {
        onClose = listener;
        return () => {};
      },
      onMessage: (listener) => {
        onMessage = listener;
        return () => {};
      },
      onError: () => () => {},
    };
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "panel-aborted-provider-lease",
      transportFactory: () => transport,
      reconnect: { enabled: true, baseDelayMs: 30_000 },
    });
    try {
      const connected = client.connect();
      onOpen();
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: SERVER,
              hostname: null,
              version: null,
              features: { providerSubagents: true },
            },
          },
        }),
        false,
      );
      await connected;
      initialize(client);
      const Panel = providerSubagentPanelRegistration.component;
      const view = render(<Panel />);
      await waitFor(() =>
        expect(
          sent.some(
            (frame) =>
              typeof frame === "string" &&
              frame.includes("agent.provider_subagents.set_subscription.request"),
          ),
        ).toBe(true),
      );
      expect(client.getProviderSubagentSubscriptions().timelines).toHaveLength(1);
      onClose();
      view.unmount();
      expect(client.getProviderSubagentSubscriptions()).toEqual({
        parentAgentIds: [],
        timelines: [],
      });
      for (let index = 0; index < 5; index += 1) {
        const hidden = render(<Panel />);
        hidden.unmount();
        expect(client.getProviderSubagentSubscriptions()).toEqual({
          parentAgentIds: [],
          timelines: [],
        });
      }
      await client.syncProviderSubagentSubscriptions();
      expect(
        sent.filter(
          (frame) =>
            typeof frame === "string" &&
            frame.includes("agent.provider_subagents.set_subscription.request"),
        ),
      ).toHaveLength(1);
      expect(
        sent.some(
          (frame) =>
            typeof frame === "string" &&
            frame.includes("agent.provider_subagents.timeline.get.request"),
        ),
      ).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("holds a child lease only while shown and releases an ACK arriving after hide", async () => {
    const lease = Promise.withResolvers<() => void>();
    const release = vi.fn();
    const client = {
      listProviderSubagents: vi.fn(async () => ({
        requestId: "list",
        parentAgentId: "parent",
        subagents: [descriptor],
        error: null,
      })),
      fetchProviderSubagentTimeline: vi.fn(async () => ({
        ...missingTimeline,
        provider: "omp" as const,
      })),
      acquireProviderSubagentSubscription: vi.fn(() => lease.promise),
      getProviderSubagentSubscriptions: () => ({
        parentAgentIds: ["parent"],
        timelines: [{ parentAgentId: "parent", subagentId: "child" }],
      }),
    };
    initialize(client);
    const Panel = providerSubagentPanelRegistration.component;
    const view = render(
      <RetainedPanelActivity active={false}>
        <Panel />
      </RetainedPanelActivity>,
    );
    expect(client.acquireProviderSubagentSubscription).not.toHaveBeenCalled();
    view.rerender(
      <RetainedPanelActivity active>
        <Panel />
      </RetainedPanelActivity>,
    );
    expect(client.acquireProviderSubagentSubscription).toHaveBeenCalledWith("parent", "child", {
      signal: expect.any(AbortSignal),
    });
    expect(client.listProviderSubagents).not.toHaveBeenCalled();
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
    view.rerender(
      <RetainedPanelActivity active={false}>
        <Panel />
      </RetainedPanelActivity>,
    );
    await act(async () => lease.resolve(release));
    expect(release).toHaveBeenCalledTimes(1);
    expect(client.listProviderSubagents).not.toHaveBeenCalled();
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
  });

  it("acquires descriptor-only leases for enabled lists and releases late ACKs after unmount", async () => {
    const lease = Promise.withResolvers<() => void>();
    const release = vi.fn();
    const client = {
      listProviderSubagents: vi.fn(async () => ({
        requestId: "list",
        parentAgentId: "parent",
        subagents: [descriptor],
        error: null,
      })),
      fetchProviderSubagentTimeline: vi.fn(async () => missingTimeline),
      acquireProviderSubagentSubscription: vi.fn(() => lease.promise),
      getProviderSubagentSubscriptions: () => ({ parentAgentIds: ["parent"], timelines: [] }),
    };
    initialize(client);
    const queryClient = new QueryClient();
    const view = renderHook(
      ({ enabled }) =>
        useSubagentsForParent({ serverId: SERVER, parentAgentId: "parent", enabled }),
      {
        initialProps: { enabled: false },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    expect(client.acquireProviderSubagentSubscription).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    expect(client.acquireProviderSubagentSubscription).toHaveBeenCalledWith("parent", undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(client.listProviderSubagents).not.toHaveBeenCalled();
    await act(async () => lease.resolve(release));
    await waitFor(() => expect(view.result.current.map((row) => row.id)).toEqual(["child"]));
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
    view.rerender({ enabled: false });
    expect(release).toHaveBeenCalledTimes(1);

    const lateLease = Promise.withResolvers<() => void>();
    const lateRelease = vi.fn();
    client.acquireProviderSubagentSubscription.mockImplementationOnce(() => lateLease.promise);
    view.rerender({ enabled: true });
    const listsBeforeUnmount = client.listProviderSubagents.mock.calls.length;
    view.unmount();
    queryClient.clear();
    await act(async () => lateLease.resolve(lateRelease));
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(client.listProviderSubagents).toHaveBeenCalledTimes(listsBeforeUnmount);
  });
});
