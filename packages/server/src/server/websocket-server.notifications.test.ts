import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { decompressJsonFrame } from "@omp-desktop/protocol/json-compression";
import { wrapSessionMessage, type WSOutboundMessage } from "./messages.js";
import {
  type JsonOutboundSender,
  MAX_QUEUED_JSON_MESSAGES,
} from "./websocket/json-outbound-sender.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { PaseoWebSocketServer, type WebSocketLike } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  getJsonSender(ws: WebSocketLike): JsonOutboundSender;
  sendMessageToSockets(sockets: Iterable<WebSocketLike>, message: WSOutboundMessage): void;
  detachSocket(ws: WebSocketLike, details: { code?: number }): Promise<void>;
  dirtyProviderFeeds: Set<WebSocketLike>;
  jsonSenders: Map<WebSocketLike, JsonOutboundSender>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(agentManagerOverrides?: Record<string, unknown>) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new PaseoWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    undefined,
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: () => false,
  };
}

function connectClient(
  server: PaseoWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
) {
  const ws = createOpenSocket();
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: createSessionWithActivity(activity),
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("PaseoWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });
});

class ControlledOutboundSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: Array<string | Uint8Array> = [];
  readonly callbacks: Array<(error?: Error) => void> = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  readonly on = vi.fn();
  readonly once = vi.fn();

  send(frame: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    this.frames.push(
      typeof frame === "string"
        ? frame
        : frame instanceof ArrayBuffer
          ? new Uint8Array(frame.slice(0))
          : frame.slice(),
    );
    if (callback) this.callbacks.push(callback);
  }

  async complete(error?: Error): Promise<void> {
    const callback = this.callbacks.shift();
    expect(callback).toBeDefined();
    callback?.(error);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async finish(): Promise<void> {
    await vi.waitFor(() => expect(this.callbacks.length).toBeGreaterThan(0));
    for (let count = 0; this.callbacks.length > 0 && count < 256; count += 1) {
      await this.complete();
    }
    expect(this.callbacks).toHaveLength(0);
  }

  async messages(): Promise<WSOutboundMessage[]> {
    return Promise.all(
      this.frames.map(async (frame) => {
        const json = typeof frame === "string" ? frame : await decompressJsonFrame(frame);
        if (typeof json !== "string") throw new Error("Expected a complete JSON message");
        return JSON.parse(json) as WSOutboundMessage;
      }),
    );
  }
}

function providerRemoval(index: number): WSOutboundMessage {
  return wrapSessionMessage({
    type: "agent.provider_subagents.update",
    payload: { kind: "remove", parentAgentId: "parent", subagentId: `child-${index}` },
  });
}

function saturateProviderFeed(
  server: WebSocketServerInternals,
  socket: ControlledOutboundSocket,
): void {
  server.getJsonSender(socket).setGzipJsonMessages(true);
  server.sendMessageToSockets(
    [socket],
    wrapSessionMessage({ type: "status", payload: { status: "x".repeat(64 * 1024) } }),
  );
  for (let index = 0; index <= MAX_QUEUED_JSON_MESSAGES; index += 1) {
    server.sendMessageToSockets([socket], providerRemoval(index));
  }
}

describe("PaseoWebSocketServer recoverable provider feed overload", () => {
  it("keeps 128 accepted pushes before one drain invalidate even with no subsequent update", async () => {
    const { server } = createServer();
    const internals = asInternals<WebSocketServerInternals>(server);
    const socket = new ControlledOutboundSocket();
    saturateProviderFeed(internals, socket);

    expect(socket.close).not.toHaveBeenCalled();
    expect(internals.dirtyProviderFeeds.has(socket)).toBe(true);
    await socket.finish();
    const accepted = Array.from({ length: MAX_QUEUED_JSON_MESSAGES }, (_, index) =>
      providerRemoval(index),
    );
    expect((await socket.messages()).slice(1)).toEqual([
      ...accepted,
      wrapSessionMessage({
        type: "agent.provider_subagents.update",
        payload: { kind: "invalidate" },
      }),
    ]);
    expect(internals.dirtyProviderFeeds.has(socket)).toBe(false);
    expect(socket.readyState).toBe(1);

    internals.sendMessageToSockets([socket], providerRemoval(999));
    await socket.finish();
    expect((await socket.messages()).at(-1)).toEqual(providerRemoval(999));
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("pauses only provider pushes while control replies, RPC errors and snapshots remain deliverable", async () => {
    const { server } = createServer();
    const internals = asInternals<WebSocketServerInternals>(server);
    const socket = new ControlledOutboundSocket();
    saturateProviderFeed(internals, socket);
    internals.sendMessageToSockets([socket], providerRemoval(500));
    internals.sendMessageToSockets(
      [socket],
      wrapSessionMessage({
        type: "agent.provider_subagents.update",
        payload: { kind: "invalidate", parentAgentId: "parent" },
      }),
    );
    const snapshot = wrapSessionMessage({
      type: "agent.provider_subagents.list.response",
      payload: { requestId: "snapshot", parentAgentId: "parent", subagents: [], error: null },
    });
    internals.sendMessageToSockets([socket], snapshot);
    internals.sendMessageToSockets([socket], { type: "pong" });
    await vi.waitFor(() => expect(socket.callbacks.length).toBeGreaterThan(1));
    // The heartbeat bypasses the logical queue. Completing it and the active
    // response opens queue capacity without clearing the feed's dirty state.
    await socket.complete();
    await socket.complete();
    await socket.complete();
    internals.sendMessageToSockets([socket], snapshot);
    const control = wrapSessionMessage({ type: "status", payload: { status: "control" } });
    internals.sendMessageToSockets([socket], control);
    await socket.finish();

    const messages = await socket.messages();
    expect(messages).toContainEqual({ type: "pong" });
    expect(messages).toContainEqual(snapshot);
    expect(messages).toContainEqual(control);
    expect(messages).toContainEqual(
      wrapSessionMessage({
        type: "rpc_error",
        payload: {
          requestId: "snapshot",
          code: "outbound_queue_full",
          error:
            "Outbound response queue is full; retry this request after pending responses finish",
        },
      }),
    );
    const updates = messages.filter(
      (message) =>
        message.type === "session" && message.message.type === "agent.provider_subagents.update",
    );
    expect(updates).toHaveLength(MAX_QUEUED_JSON_MESSAGES + 1);
    expect(messages.at(-1)).toEqual(
      wrapSessionMessage({
        type: "agent.provider_subagents.update",
        payload: { kind: "invalidate" },
      }),
    );
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("isolates dirty sockets and drops recovery state when a stalled socket closes", async () => {
    const { server } = createServer();
    const internals = asInternals<WebSocketServerInternals>(server);
    const stale = new ControlledOutboundSocket();
    const healthy = new ControlledOutboundSocket();
    saturateProviderFeed(internals, stale);
    internals.sendMessageToSockets([stale, healthy], providerRemoval(700));
    await healthy.finish();
    expect(await healthy.messages()).toEqual([providerRemoval(700)]);
    expect(internals.dirtyProviderFeeds.has(healthy)).toBe(false);

    await vi.waitFor(() => expect(stale.callbacks).toHaveLength(1));
    stale.readyState = 3;
    await internals.detachSocket(stale, { code: 1000 });
    expect(internals.dirtyProviderFeeds.has(stale)).toBe(false);
    expect(internals.jsonSenders.has(stale)).toBe(false);
    await stale.complete();
    expect(stale.frames).toHaveLength(1);

    const replacement = new ControlledOutboundSocket();
    internals.sendMessageToSockets([healthy, replacement], providerRemoval(701));
    await healthy.finish();
    await replacement.finish();
    expect(await replacement.messages()).toEqual([providerRemoval(701)]);
    expect(await healthy.messages()).toEqual([providerRemoval(700), providerRemoval(701)]);
    expect(internals.dirtyProviderFeeds.size).toBe(0);
  });

  it("still closes for an uncorrelated nonrecoverable push rejected by the bounded queue", async () => {
    const { server } = createServer();
    const internals = asInternals<WebSocketServerInternals>(server);
    const socket = new ControlledOutboundSocket();
    saturateProviderFeed(internals, socket);
    internals.sendMessageToSockets(
      [socket],
      wrapSessionMessage({ type: "status", payload: { status: "must not disappear" } }),
    );
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(internals.dirtyProviderFeeds.has(socket)).toBe(false);
    expect(internals.jsonSenders.has(socket)).toBe(false);
    await Promise.resolve();
  });
});
