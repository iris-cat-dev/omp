import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import { readFile as readSavedFile, writeFile as seedFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { WebSocket } from "ws";
import { DaemonClient } from "../../../client/src/daemon-client.js";
import {
  asUint8Array,
  JSON_MESSAGE_CHUNK_OPCODE,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
} from "@omp-desktop/protocol/binary-frames/index";
import { CLIENT_CAPS } from "@omp-desktop/protocol/client-capabilities";
import { COMPRESSED_JSON_OPCODE, compressJsonFrame } from "@omp-desktop/protocol/json-compression";
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
          if (
            interrupt &&
            (bytes?.[0] === JSON_MESSAGE_CHUNK_OPCODE || bytes?.[0] === COMPRESSED_JSON_OPCODE)
          ) {
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

test.each([true, false])(
  "large file edits and history remain lossless with compression capability=%s",
  async (compression) => {
    daemon = await createTestPaseoDaemon({ mcpEnabled: false, pluginsEnabled: false });
    const filename = "unicode.txt";
    await seedFile(path.join(daemon.paseoHome, filename), "before");
    const agent = await daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: daemon.paseoHome },
      undefined,
      { initialTitle: "Compressed history" },
    );
    const expectedText = '历史🙂"\\\\\\n'.repeat(100_000);
    const fileText = "文件🙂\\\n".repeat(10_000);
    await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: expectedText,
    });
    let inboundCompressed = false;
    let send: MockInstance<WebSocket["send"]>;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: `gzip-file-history-${compression}`,
      capabilities: { [CLIENT_CAPS.gzipJsonMessages]: compression },
      reconnect: { enabled: false },
      webSocketFactory: (url, options) => {
        const socket = new WebSocket(url, options?.protocols);
        sockets.push(socket);
        send = vi.spyOn(socket, "send");
        socket.on("message", (data, binary) => {
          if (binary && asUint8Array(data)?.[0] === COMPRESSED_JSON_OPCODE)
            inboundCompressed = true;
        });
        return socket;
      },
    });
    clients.push(client);
    await client.connect();
    const initial = await client.readFile(daemon.paseoHome, filename);
    const saved = await client.writeFile({
      cwd: daemon.paseoHome,
      path: filename,
      content: fileText,
      expectedModifiedAt: initial.modifiedAt,
      expectedRevision: initial.revision,
    });
    expect(saved.status).toBe("written");
    const [file, history] = await Promise.all([
      client.readFile(daemon.paseoHome, filename),
      client.fetchAgentTimeline(agent.id, { limit: 40 }),
    ]);
    expect(new TextDecoder().decode(file.bytes)).toBe(fileText);
    expect(history.entries.map((entry) => entry.item)).toEqual([
      { type: "assistant_message", text: expectedText },
    ]);
    expect(inboundCompressed).toBe(compression);
    expect(
      send!.mock.calls.some(([data]) => asUint8Array(data)?.[0] === COMPRESSED_JSON_OPCODE),
    ).toBe(compression);
  },
  TEST_TIMEOUT_MS,
);

test("a client that declined compression cannot dispatch a compressed file edit", async () => {
  daemon = await createTestPaseoDaemon({ mcpEnabled: false, pluginsEnabled: false });
  const filename = "protected.txt";
  await seedFile(path.join(daemon.paseoHome, filename), "before");
  let socket: WebSocket;
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "declined-compression",
    capabilities: { [CLIENT_CAPS.gzipJsonMessages]: false },
    reconnect: { enabled: false },
    webSocketFactory: (url, options) => {
      socket = new WebSocket(url, options?.protocols);
      sockets.push(socket);
      return socket;
    },
  });
  clients.push(client);
  await client.connect();
  const initial = await client.readFile(daemon.paseoHome, filename);
  const closed = once(socket!, "close");
  const compressed = await compressJsonFrame(
    JSON.stringify({
      type: "session",
      message: {
        type: "fs.file.write.request",
        requestId: "unnegotiated-edit",
        cwd: daemon.paseoHome,
        path: filename,
        content: "overwrite".repeat(10_000),
        expectedModifiedAt: initial.modifiedAt,
        expectedRevision: initial.revision,
      },
    }),
  );
  socket!.send(compressed!);
  await closed;
  expect(await readSavedFile(path.join(daemon.paseoHome, filename), "utf8")).toBe("before");
});
