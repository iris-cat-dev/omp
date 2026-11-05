import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import pino from "pino";
import { expect, test } from "vitest";
import { startOmpRpcSession } from "./cli-runtime.js";

interface TestChild extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function createChild(): TestChild {
  const child: TestChild = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
  }) as TestChild;
  child.stdout.write(
    `${JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] })}\n`,
  );
  return child;
}

function start(child: TestChild) {
  return startOmpRpcSession({
    launch: { argv: ["omp"], cwd: process.cwd(), env: {} },
    logger: pino({ level: "silent" }),
    spawnProcess: () => child,
    getImageGenerationConfig: () => undefined,
    imageSettingsToken: "isolated-image-test-token",
  });
}

function exit(child: TestChild) {
  child.stderr.write("proxy TLS handshake failed");
  child.exitCode = 1;
  child.emit("exit", 1, null);
}

function announceImageBridge(child: TestChild, port: number) {
  child.stdout.write(`${JSON.stringify({ type: "desktop_image_settings_ready", port })}\n`);
}

async function imageBridge(holdUpdates = false) {
  const requests: string[] = [];
  const updateReceived = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    request.resume();
    if (holdUpdates && requests.length > 1) {
      updateReceived.resolve();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Image bridge did not bind");
  return {
    port: address.port,
    requests,
    updateReceived: updateReceived.promise,
    close: async () => {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    },
  };
}

test("does not send image credentials to a cached bridge after its runtime exits", async () => {
  const bridge = await imageBridge();
  const child = createChild();
  announceImageBridge(child, bridge.port);
  const session = await start(child);
  try {
    expect(bridge.requests).toEqual(["Bearer isolated-image-test-token"]);
    exit(child);
    // Keep the old listener alive to model port reuse and deliver a stale frame.
    announceImageBridge(child, bridge.port);
    const failure = await session.prompt("continue").catch((error: unknown) => error);
    expect(bridge.requests).toEqual(["Bearer isolated-image-test-token"]);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("proxy TLS handshake failed");
  } finally {
    await session.close();
    await bridge.close();
  }
});

test("rejects startup promptly if the process exits before advertising its image bridge", async () => {
  const child = createChild();
  const rejected = expect(start(child)).rejects.toThrow("proxy TLS handshake failed");
  // The RPC ready frame is consumed; startup now awaits image bridge readiness.
  await waitForImmediate();
  exit(child);
  await rejected;
}, 3000);

test("aborts an in-flight image update and rejects queued inputs on process exit", async () => {
  const bridge = await imageBridge(true);
  const child = createChild();
  announceImageBridge(child, bridge.port);
  const session = await start(child);
  try {
    announceImageBridge(child, bridge.port);
    const first = expect(session.prompt("first")).rejects.toThrow("proxy TLS handshake failed");
    const queued = expect(session.steer("queued")).rejects.toThrow("proxy TLS handshake failed");
    await bridge.updateReceived;
    exit(child);
    await Promise.all([first, queued]);
    expect(bridge.requests).toEqual([
      "Bearer isolated-image-test-token",
      "Bearer isolated-image-test-token",
    ]);
  } finally {
    await session.close();
    await bridge.close();
  }
}, 3000);
