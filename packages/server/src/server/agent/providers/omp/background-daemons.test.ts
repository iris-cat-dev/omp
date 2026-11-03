import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import { OmpBackgroundDaemons } from "./background-daemons.js";
import { OmpAgentClient } from "./agent.js";

let root: string;
let sdkRoot: string;
let runtime: string;
let daemonDir: string;
let env: NodeJS.ProcessEnv;
let adapter: OmpBackgroundDaemons;
let server: net.Server | undefined;
const sockets = new Set<net.Socket>();
const scopeKey = "0123456789abcdef";
let snapshot: Record<string, unknown>;

function brokerEndpoint(dir: string): string {
  const native = createRequire(path.join(sdkRoot, "package.json"))("@oh-my-pi/pi-natives") as {
    ipcEndpoint(dir: string, name: string): string;
  };
  return native.ipcEndpoint(dir, "broker");
}

async function persist() {
  await fs.mkdir(daemonDir, { recursive: true });
  await fs.writeFile(
    path.join(daemonDir, "meta.json"),
    JSON.stringify({
      daemon: snapshot,
      spec: {
        application: "node",
        args: ["server.js"],
        cwd: root,
        env: { SECRET: "never-expose-me" },
      },
      completionPending: true,
      pendingCompletion: { id: "unconsumed" },
    }),
  );
}

async function broker(reply: (request: Record<string, unknown>, socket: net.Socket) => void) {
  await fs.writeFile(path.join(runtime, "broker.token"), "private-token\n");
  await fs.writeFile(path.join(runtime, "broker.pid"), JSON.stringify({ pid: process.pid }));
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) reply(JSON.parse(buffer.slice(0, newline)), socket);
    });
  });
  const endpoint = brokerEndpoint(runtime);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(endpoint, resolve);
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(fileURLToPath(new URL("../../../../../../../.bg-", import.meta.url)));
  root = await fs.realpath(root);
  sdkRoot = path.join(root, "sdk");
  await fs.mkdir(path.join(sdkRoot, "dist", "node"), { recursive: true });
  await fs.writeFile(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.14.0" }),
  );
  for (const entry of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"]) {
    await fs.writeFile(path.join(sdkRoot, "dist", "node", entry), "");
  }
  const natives = path.join(sdkRoot, "node_modules", "@oh-my-pi", "pi-natives");
  await fs.mkdir(natives, { recursive: true });
  await fs.writeFile(path.join(natives, "package.json"), JSON.stringify({ main: "index.cjs" }));
  await fs.writeFile(
    path.join(natives, "index.cjs"),
    `
    const path = require("node:path");
    const { createHash } = require("node:crypto");
    exports.ipcEndpoint = (dir, name) => process.platform === "win32"
      ? ${JSON.stringify("\\\\.\\pipe\\omp-")} + name + "-" + createHash("sha256").update(path.resolve(dir).toLowerCase()).digest("hex").slice(0, 16)
      : path.join(dir, name + ".ipc");
  `,
  );
  env = {
    HOME: root,
    USERPROFILE: root,
    PI_CONFIG_DIR: ".omp",
    OMP_DESKTOP_SDK_ROOT: sdkRoot,
    OMP_PROFILE: "",
    PI_PROFILE: "",
    PI_CODING_AGENT_DIR: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    XDG_DATA_HOME: undefined,
  };
  runtime = path.join(root, ".omp", "run", "daemons", scopeKey);
  daemonDir = path.join(runtime, "daemons", "web");
  snapshot = {
    id: "daemon-id",
    name: "web",
    state: "ready",
    owner: "provider-session:exact",
    startedAt: 100,
    createdAt: 90,
    restartCount: 0,
    outputBytes: 0,
  };
  await persist();
  await fs.writeFile(path.join(runtime, "scope.json"), JSON.stringify({ projectDir: root }));
  adapter = new OmpBackgroundDaemons({ cwd: root, env, resolveBrokerEndpoint: brokerEndpoint });
});

afterEach(async () => {
  adapter.dispose();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

describe("OMP passive daemon inspection", () => {
  test("cold provider inspection retains owned daemons but excludes other sessions and workspace daemons", async () => {
    await broker((request, socket) => {
      socket.end(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            op: "list",
            daemons: [
              snapshot,
              { ...snapshot, id: "foreign-id", name: "foreign", owner: "another-session" },
              { ...snapshot, id: "workspace-id", name: "workspace", owner: null },
            ],
          },
        }) + "\n",
      );
    });
    const client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: {
        ompBackend: "sdk",
        ompSdkPath: sdkRoot,
        env: {
          ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? ""])),
          OMP_DESKTOP_SDK_ROOT: path.join(root, "not-the-selected-sdk"),
        },
      },
    });
    expect(
      await client.listPersistedBackgroundProcesses(
        { provider: "omp", sessionId: "provider-session:exact" },
        root,
      ),
    ).toEqual([
      {
        id: "daemon-id",
        name: "web",
        command: "node server.js",
        cwd: root,
        ownerAgentId: null,
        scope: "agent",
        source: "omp-daemon",
        status: "ready",
        startedAt: 100,
        endedAt: null,
        exitCode: null,
        terminalId: null,
      },
    ]);
  });

  test("uses authenticated list without completion subscriptions, and never exposes spec env", async () => {
    const requests: Record<string, unknown>[] = [];
    const before = await fs.readFile(path.join(daemonDir, "meta.json"), "utf8");
    await broker((request, socket) => {
      requests.push(request);
      const response = JSON.stringify({
        id: request.id,
        ok: true,
        result: { op: "list", daemons: [snapshot] },
      });
      socket.write(response.slice(0, 12));
      socket.write(`${response.slice(12)}\n`);
    });
    expect(await adapter.list()).toEqual([
      {
        id: "daemon-id",
        name: "web",
        command: "node server.js",
        cwd: root,
        providerOwnerId: "provider-session:exact",
        ownerAgentId: null,
        scope: "agent",
        source: "omp-daemon",
        status: "ready",
        startedAt: 100,
        endedAt: null,
        exitCode: null,
        terminalId: null,
      },
    ]);
    expect(Object.keys(requests[0]!).sort()).toEqual(["id", "operation", "token"]);
    expect(requests[0]).toMatchObject({ token: "private-token", operation: { op: "list" } });
    expect(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8")).toBe(before);
  });

  test("retains offline terminal logs without inventing exits for unsupervised active daemons", async () => {
    expect((await adapter.list())[0]).toMatchObject({
      status: "unknown",
      endedAt: null,
      exitCode: null,
    });
    snapshot.state = "failed";
    snapshot.exitedAt = 200;
    snapshot.exitCode = 2;
    delete snapshot.owner;
    await persist();
    await fs.writeFile(path.join(daemonDir, "output.log"), "failure\r\n");
    expect((await adapter.list())[0]).toMatchObject({
      status: "failed",
      endedAt: 200,
      exitCode: 2,
      scope: "workspace",
    });
    expect(await adapter.output("daemon-id")).toMatchObject({
      text: "failure\r\n",
      reset: true,
      truncated: false,
    });
    await expect(fs.access(path.join(runtime, "broker.token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(runtime, "broker.pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not turn a missing endpoint of a live broker into an offline scope", async () => {
    await fs.writeFile(path.join(runtime, "broker.token"), "private-token\n");
    await fs.writeFile(path.join(runtime, "broker.pid"), JSON.stringify({ pid: process.pid }));
    await expect(adapter.list()).rejects.toMatchObject({
      code: "ENOENT",
      address: brokerEndpoint(runtime),
    });
  });

  test("surfaces rejected authentication without returning broker error secrets", async () => {
    await broker((request, socket) =>
      socket.end(
        `${JSON.stringify({ id: request.id, ok: false, error: "private-token never-expose-me" })}\n`,
      ),
    );
    await expect(adapter.list()).rejects.toMatchObject({
      message: expect.not.stringMatching(/private-token|never-expose-me/u),
    });
  });

  test("finds a scope created after an empty initial inspection and isolates other projects", async () => {
    await fs.writeFile(
      path.join(runtime, "scope.json"),
      JSON.stringify({ projectDir: path.dirname(root) }),
    );
    expect(await adapter.list()).toEqual([]);
    await fs.writeFile(path.join(runtime, "scope.json"), JSON.stringify({ projectDir: root }));
    expect((await adapter.list()).map((row) => row.id)).toEqual(["daemon-id"]);
  });

  test("honors launch profile flags over environment without executing the launch command", async () => {
    adapter.dispose();
    const profileRoot = path.join(root, ".omp", "profiles", "work", "run", "daemons");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.rename(runtime, path.join(profileRoot, scopeKey));
    adapter = new OmpBackgroundDaemons({
      cwd: root,
      env: { ...env, OMP_PROFILE: "wrong" },
      command: ["must-not-be-executed", "--profile", "work"],
      resolveBrokerEndpoint: brokerEndpoint,
    });
    expect((await adapter.list()).map((row) => row.id)).toEqual(["daemon-id"]);
  });

  test("rejects arbitrary paths, unknown IDs, replacement IDs, and symlinked logs", async () => {
    await adapter.list();
    await expect(adapter.output("../../scope.json")).rejects.toThrow(
      "Unknown OMP background process",
    );
    await fs.writeFile(path.join(root, "secret"), "secret");
    await fs.symlink(path.join(root, "secret"), path.join(daemonDir, "output.log"));
    await expect(adapter.output("daemon-id")).rejects.toThrow("Invalid OMP daemon log file");
    snapshot.id = "replacement";
    await persist();
    await expect(adapter.output("daemon-id")).rejects.toThrow("was replaced");
  });

  test("returns raw incremental bytes without replay, synthetic newlines, or split UTF-8 corruption", async () => {
    await fs.writeFile(path.join(daemonDir, "output.previous.log"), "previous");
    await fs.writeFile(path.join(daemonDir, "output.log"), "\r\u001b[32mcurrent");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    expect(first.text).toBe("previous\r\u001b[32mcurrent");
    expect(await adapter.output("daemon-id", first.cursor)).toEqual({
      text: "",
      cursor: first.cursor,
      reset: false,
      truncated: false,
      format: "text",
    });
    const unicode = Buffer.from("界");
    await fs.appendFile(path.join(daemonDir, "output.log"), unicode.subarray(0, 2));
    const partial = await adapter.output("daemon-id", first.cursor);
    expect(partial.text).toBe("");
    await fs.appendFile(path.join(daemonDir, "output.log"), unicode.subarray(2));
    expect(await adapter.output("daemon-id", partial.cursor)).toMatchObject({
      text: "界",
      reset: false,
      truncated: false,
    });
  });

  test("continues through rotation and resets when a cursor loses retained history", async () => {
    const current = path.join(daemonDir, "output.log");
    const previous = path.join(daemonDir, "output.previous.log");
    await fs.writeFile(current, "first");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    await fs.rename(current, previous);
    await fs.writeFile(current, "second");
    const second = await adapter.output("daemon-id", first.cursor);
    expect(second).toMatchObject({ text: "second", reset: false, truncated: false });
    await fs.rm(previous);
    await fs.rename(current, previous);
    await fs.writeFile(current, "third");
    await fs.rm(previous);
    await fs.rename(current, previous);
    await fs.writeFile(current, "fourth");
    expect(await adapter.output("daemon-id", second.cursor)).toMatchObject({
      text: "thirdfourth",
      reset: true,
    });
  });

  test("resets same-ID restarts and truncate/regrow rather than skipping replacement bytes", async () => {
    const current = path.join(daemonDir, "output.log");
    await fs.writeFile(current, "old");
    await adapter.list();
    const first = await adapter.output("daemon-id");
    await fs.writeFile(current, "new-longer");
    const rewritten = await adapter.output("daemon-id", first.cursor);
    expect(rewritten).toMatchObject({ text: "new-longer", reset: true });
    snapshot.startedAt = 300;
    snapshot.restartCount = 1;
    await persist();
    expect(await adapter.output("daemon-id", rewritten.cursor)).toMatchObject({
      text: "new-longer",
      reset: true,
    });
  });

  test("bounds large backlogs and resets stale or invalid cursors", async () => {
    await fs.writeFile(path.join(daemonDir, "output.log"), "a".repeat(300 * 1024));
    await adapter.list();
    const first = await adapter.output("daemon-id");
    expect(first).toMatchObject({ text: "a".repeat(256 * 1024), reset: true, truncated: true });
    expect(await adapter.output("daemon-id", first.cursor + 50)).toMatchObject({
      reset: true,
      truncated: true,
    });
    await expect(adapter.output("daemon-id", -1)).rejects.toThrow(
      "Invalid background output cursor",
    );
    adapter.dispose();
    await expect(adapter.list()).rejects.toThrow("disposed");
    await expect(adapter.output("daemon-id")).rejects.toThrow("disposed");
  });
});
