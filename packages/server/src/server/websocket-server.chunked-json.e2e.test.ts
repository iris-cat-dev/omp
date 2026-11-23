import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import { mkdir, readFile as readSavedFile, symlink, writeFile as seedFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { WebSocket } from "ws";
import { DaemonClient } from "../../../client/src/daemon-client.js";
import { createOmpApi } from "../../../client/src/index.js";
import {
  asUint8Array,
  JSON_MESSAGE_CHUNK_OPCODE,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
} from "@omp-desktop/protocol/binary-frames/index";
import { CLIENT_CAPS } from "@omp-desktop/protocol/client-capabilities";
import { COMPRESSED_JSON_OPCODE, compressJsonFrame } from "@omp-desktop/protocol/json-compression";
import { MAX_WORKSPACE_FILE_BYTES } from "@omp-desktop/protocol/messages";
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

test(
  "scoped workspace files use registered roots and preserve revisions across connections",
  async () => {
    daemon = await createTestPaseoDaemon({ mcpEnabled: false, pluginsEnabled: false });
    const connect = async (clientId: string) => {
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon!.port}/ws`,
        clientId,
        capabilities: { [CLIENT_CAPS.gzipJsonMessages]: false },
        reconnect: { enabled: false },
        webSocketFactory: (url, options) => new WebSocket(url, options?.protocols),
      });
      clients.push(client);
      await client.connect();
      return client;
    };
    const first = await connect("workspace-files-first");
    const second = await connect("workspace-files-second");
    const projectRoot = path.join(daemon.paseoHome, "project");
    const checkout = path.join(daemon.paseoHome, "checkout");
    await mkdir(projectRoot);
    await mkdir(checkout);
    const added = await first.addProject(projectRoot);
    if (!added.project) throw new Error(added.error ?? "Project registration failed");
    const opened = await first.createWorkspace({
      source: { kind: "directory", path: checkout, projectId: added.project.projectId },
    });
    if (!opened.workspace) throw new Error(opened.error ?? "Workspace registration failed");

    const files = createOmpApi(first).workspaceFiles;
    const otherFiles = createOmpApi(second).workspaceFiles;
    const directory = { workspaceId: opened.workspace.id, scope: "project", path: "canvases" } as const;
    const target = { ...directory, path: "canvases/example.canva.json" };
    const checkoutTarget = { ...target, scope: "workspace" } as const;
    await expect(files.list(directory)).resolves.toBeNull();
    await expect(files.read(target)).resolves.toBeNull();
    await files.mkdir(directory);
    await files.mkdir(directory);

    const image = Buffer.alloc(8 * 1024 * 1024).toString("base64");
    const workspaceDocument = '{"checkout":"你好"}\n';
    const document = JSON.stringify({ image });
    const created = await Promise.all([
      files.create({ ...target, content: document }),
      otherFiles.create({ ...target, content: document }),
    ]);
    expect(created.toSorted()).toEqual([false, true]);
    await expect(otherFiles.create({ ...target, content: "must not overwrite" })).resolves.toBe(false);
    await expect(files.list(directory)).resolves.toEqual([{ name: "example.canva.json", kind: "file" }]);
    await expect(files.list(target)).rejects.toThrow("not a directory");
    await expect(files.mkdir(target)).rejects.toThrow();
    await expect(files.read(checkoutTarget)).resolves.toBeNull();
    await files.mkdir({ ...directory, scope: "workspace" });
    await expect(files.create({ ...checkoutTarget, content: workspaceDocument })).resolves.toBe(true);
    await expect(otherFiles.read(checkoutTarget)).resolves.toMatchObject({ content: workspaceDocument });
    await expect(files.read({ ...target, workspaceId: "unknown-workspace" })).rejects.toThrow("Workspace not found");

    const initial = await files.read(target);
    if (!initial) throw new Error("Created file was not readable");
    expect(initial.content === document).toBe(true);
    const version = {
      ...target,
      expectedModifiedAt: initial.modifiedAt,
      expectedRevision: initial.revision,
    };
    await expect(first.writeFile({ ...version, cwd: projectRoot, content: "too large for the editor" }))
      .resolves.toMatchObject({ status: "error", error: "File is too large to edit" });

    // Quotes at the exact text limit exceed a 32 MiB relay frame if sent as raw JSON.
    const maxText = '"'.repeat(MAX_WORKSPACE_FILE_BYTES);
    await expect(files.write({ ...version, content: maxText }))
      .resolves.toMatchObject({ status: "written", size: MAX_WORKSPACE_FILE_BYTES });
    const updated = await otherFiles.read(target);
    if (!updated) throw new Error("Updated file was not readable");
    expect(updated.content === maxText).toBe(true);
    await expect(files.write({ ...version, content: `${maxText}x` }))
      .resolves.toMatchObject({ status: "error", error: "File is too large to edit" });

    const baseline = {
      ...target,
      expectedModifiedAt: updated.modifiedAt,
      expectedRevision: updated.revision,
    };
    const writes = await Promise.all([
      files.write({ ...baseline, content: "first" }),
      otherFiles.write({ ...baseline, content: "second" }),
    ]);
    expect(writes.map(({ status }) => status).toSorted()).toEqual(["conflict", "written"]);
    expect(await readSavedFile(path.join(projectRoot, target.path), "utf8"))
      .toBe(writes[0].status === "written" ? "first" : "second");

    for (const invalid of [path.join(projectRoot, target.path), "../outside", "C:outside", "C:\\outside"]) {
      await expect(files.read({ ...target, path: invalid })).rejects.toThrow("must be relative");
    }
    await seedFile(path.join(projectRoot, "canvas-binary"), Buffer.from([0xff]));
    await expect(files.read({ ...target, path: "canvas-binary" })).rejects.toThrow("UTF-8 text");
    await symlink(checkout, path.join(projectRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(files.list({ ...directory, path: "escape" })).rejects.toThrow("outside of workspace");
    await expect(files.read({ ...target, path: "escape/absent.canva.json" })).rejects.toThrow("outside of workspace");
    await expect(files.create({ ...target, path: "escape/absent.canva.json", content: "{}" }))
      .rejects.toThrow("outside of workspace");
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
