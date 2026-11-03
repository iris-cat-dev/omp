import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { DaemonClient } from "../../../client/src/daemon-client.js";
import {
  asUint8Array,
  JSON_MESSAGE_CHUNK_OPCODE,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
} from "@omp-desktop/protocol/binary-frames/index";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const TEST_TIMEOUT_MS = 30_000;
let daemon: TestPaseoDaemon | undefined;
const clients: DaemonClient[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
});

test(
  "history survives an interrupted chunk stream and a resumed physical connection",
  async () => {
    daemon = await createTestPaseoDaemon({
      daemonVersion: "0.6.0",
      mcpEnabled: false,
      pluginsEnabled: false,
    });
    const agent = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.paseoHome },
      undefined,
      { workspaceId: undefined, initialTitle: "Chunked history regression" },
    );
    const expectedText = '历史🙂"\\\n'.repeat(MAX_JSON_MESSAGE_CHUNK_BYTES);
    await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: expectedText,
    });

    let interrupt = true;
    let interrupted = false;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: "interrupted-chunked-history",
      reconnect: { enabled: false },
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, options?.protocols);
        sockets.push(socket);
        socket.on("message", (data, isBinary) => {
          const bytes = isBinary ? asUint8Array(data) : null;
          if (interrupt && bytes?.[0] === JSON_MESSAGE_CHUNK_OPCODE) {
            interrupt = false;
            interrupted = true;
            socket.terminate();
          }
        });
        return socket;
      },
    });
    clients.push(client);
    await client.connect();

    const interruptedRequest = await client
      .fetchAgentTimeline(agent.id, { limit: 40, timeout: 10_000 })
      .then(
        () => false,
        () => true,
      );
    expect(interruptedRequest).toBe(true);
    expect(client.getConnectionState().status).toBe("disconnected");
    expect(interrupted).toBe(true);

    await client.connect();
    const [history, projects] = await Promise.all([
      client.fetchAgentTimeline(agent.id, { limit: 40, timeout: 10_000 }),
      client.listProjects(),
    ]);
    expect(history.entries.map((entry) => entry.item)).toEqual([
      { type: "assistant_message", text: expectedText },
    ]);
    expect(history.startCursor).toEqual(history.endCursor);
    expect(history.endCursor).toEqual({ epoch: history.epoch, seq: 1 });
    expect(projects.projects).toEqual([]);

    const resumed = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: history.endCursor!,
      limit: 40,
      timeout: 10_000,
    });
    expect(resumed.entries).toEqual([]);
    expect(resumed.reset).toBe(false);
    expect(resumed.hasNewer).toBe(false);
  },
  TEST_TIMEOUT_MS,
);
