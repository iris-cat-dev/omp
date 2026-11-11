import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.tsx"), source, "utf8");
  return directory;
}

function createReloadChild(name: string, events: string[], methods: string[] = []) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send(message: { type: string }, callback?: (error: Error | null) => void) {
      callback?.(null);
      if (message.type === "initialize") {
        events.push(`start:${name}`);
        queueMicrotask(() => emit("message", { type: "ready", methods }));
      }
      if (message.type === "shutdown") {
        events.push(`shutdown:${name}`);
        this.connected = false;
        queueMicrotask(() => {
          this.exit();
          this.closeOutput();
        });
      }
      return true;
    },
    kill() {
      this.killed = true;
      this.connected = false;
      this.signalCode = "SIGKILL";
      queueMicrotask(() => { emit("exit", null); emit("close", null); });
      return true;
    },
    disconnect() {
      this.connected = false;
      emit("disconnect", undefined);
    },
    exit() {
      this.connected = false;
      this.exitCode = 0;
      events.push(`exit:${name}`);
      emit("exit", 0);
    },
    closeOutput() {
      emit("close", this.exitCode);
    },
    on(event: string, listener: (message: never) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return this;
    },
  };
}

function createTestRuntime(
  dependencies: NonNullable<ConstructorParameters<typeof PluginRuntime>[1]> = {},
  logger = pino({ level: "silent" }),
): PluginRuntime {
  return new PluginRuntime(logger, {
    ...dependencies,
    sessionHost: dependencies.sessionHost ?? {
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "plugin-test",
                  hostname: "plugin-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  });
}

function createTrackedSessionHost() {
  const active = new Set<object>();
  return {
    active,
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        active.add(socket);
        socket.once("close", () => active.delete(socket));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "tracked-plugin-test",
                  hostname: "tracked-plugin-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  };
}

function lifecycleMessages(runtime: PluginRuntime): string[] {
  return runtime
    .getLogs("lifecycle-output")
    .map((entry) => entry.message)
    .filter((message) => message === "initialized" || message === "initialization warning")
    .sort();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it("records host-owned plugin lifecycle events", async () => {
    const directory = await createPlugin(
      "lifecycle",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("lifecycle", []);
    const runtime = createTestRuntime({ spawnChild: () => child });

    await runtime.startPlugin("lifecycle", directory);
    await runtime.stopPluginById("lifecycle");

    expect(
      runtime.getLogs("lifecycle").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "[paseo] Loading plugin" },
      { stream: "stdout", message: "[paseo] Plugin ready" },
      { stream: "stdout", message: "[paseo] Stopping plugin" },
      { stream: "stdout", message: "[paseo] Plugin stopped" },
    ]);
  });

  it("cleans the daemon session on IPC disconnect without waiting for process exit", async () => {
    const directory = await createPlugin(
      "ipc-disconnect",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("ipc-disconnect", []);
    const sessionHost = createTrackedSessionHost();
    const runtime = createTestRuntime({ spawnChild: () => child, sessionHost: sessionHost.host });
    try {
      await runtime.startPlugin("ipc-disconnect", directory);
      expect(sessionHost.active.size).toBe(1);

      child.disconnect();
      expect(child.killed).toBe(false);
      expect(sessionHost.active.size).toBe(0);
    } finally {
      await runtime.stopAll();
    }
  });

  it("revokes an exited plugin and its pending RPC before stdout close", async () => {
    const directory = await createPlugin(
      "exit-only",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("exit-only", [], ["wait"]);
    const runtime = createTestRuntime({ spawnChild: () => child });
    try {
      await runtime.startPlugin("exit-only", directory);
      const rejection = expect(runtime.invoke("exit-only", "wait", {})).rejects.toThrow(
        "Plugin process exited: exit-only",
      );
      child.stdout.write("final fragment");
      child.exit();

      expect(runtime.catalog()).toEqual([]);
      await rejection;
      expect(runtime.getLogs("exit-only").some(entry => entry.message === "final fragment")).toBe(false);
      child.closeOutput();
      expect(runtime.getLogs("exit-only").some(entry => entry.message === "final fragment")).toBe(true);
      expect(child.killed).toBe(false);
    } finally {
      await runtime.stopAll();
    }
  });

  it("does not schedule a kill or wait for close when stopping an already exited child", async () => {
    const directory = await createPlugin(
      "already-exited",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("already-exited", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("already-exited", directory);
    // Node sets exitCode before invoking exit listeners; stop may be requested
    // by an earlier listener before the runtime's own listener has run.
    child.exitCode = 0;
    child.connected = false;
    const schedule = vi.spyOn(globalThis, "setTimeout");
    try {
      await runtime.stopPluginById("already-exited");
      expect(schedule).not.toHaveBeenCalled();
      expect(child.killed).toBe(false);
      expect(runtime.catalog()).toEqual([]);
    } finally {
      schedule.mockRestore();
      await runtime.stopAll();
    }
  });

  it("frames stdout and stderr, normalizes CRLF, and flushes final fragments once", async () => {
    const directory = await createPlugin(
      "output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("output", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("output", directory);

    child.stdout.write("first\r");
    child.stdout.write("\n");
    child.stderr.write("problem\nfinal stderr");
    child.stdout.write("final stdout");
    await runtime.stopPluginById("output");

    const logs = runtime.getLogs("output");
    expect(
      logs
        .filter((entry) => !entry.message.startsWith("[paseo]"))
        .map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "first" },
      { stream: "stderr", message: "problem" },
      { stream: "stderr", message: "final stderr" },
      { stream: "stdout", message: "final stdout" },
    ]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  });

  it("writes plugin output through the daemon logger with structured identity fields", async () => {
    const directory = await createPlugin(
      "tagged-output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("tagged-output", []);
    const records: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => records.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const runtime = createTestRuntime({ spawnChild: () => child }, logger);
    await runtime.startPlugin("tagged-output", directory);

    child.stderr.write("connection failed\n");

    expect(records.find((record) => record.message === "connection failed")).toMatchObject({
      module: "plugins",
      pluginId: "tagged-output",
      sequence: 3,
      stream: "stderr",
      message: "connection failed",
    });
    expect(records.find((record) => record.message === "connection failed")?.timestamp).toEqual(
      expect.any(String),
    );
    await runtime.stopAll();
  });

  it("bounds retained output by entry count, total bytes, and individual line bytes", async () => {
    const directory = await createPlugin(
      "noisy",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("noisy", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("noisy", directory);

    child.stdout.write(
      `${Array.from({ length: 510 }, (_, index) => `line-${index}`).join("\n")}\n`,
    );
    expect(runtime.getLogs("noisy")).toHaveLength(500);
    expect(runtime.getLogs("noisy")[0]?.message).toBe("line-10");

    child.stdout.write(`${Array.from({ length: 20 }, () => "x".repeat(16 * 1024)).join("\n")}\n`);
    expect(runtime.getLogs("noisy")).toHaveLength(16);

    child.stderr.write("y".repeat(20 * 1024));
    await runtime.stopPluginById("noisy");
    const logs = runtime.getLogs("noisy");
    expect(logs.length).toBeLessThanOrEqual(500);
    expect(
      logs.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.message), 0),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(logs.every((entry) => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({ stream: "stderr", message: "y".repeat(16 * 1024) }),
    );
  });

  it("captures output emitted during initialization and cleanup across reloads", async () => {
    const directory = await createPlugin(
      "lifecycle-output",
      `export default function contribute(plugin: unknown) {
  void plugin;
  console.log("initialized");
  console.error("initialization warning");
  return () => process.stdout.write("cleanup fragment");
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("lifecycle-output", directory);
    await expect
      .poll(() => lifecycleMessages(runtime))
      .toEqual(["initialization warning", "initialized"]);
    await runtime.stopPluginById("lifecycle-output");
    await runtime.startPlugin("lifecycle-output", directory);
    await runtime.stopPluginById("lifecycle-output");

    const logs = runtime.getLogs("lifecycle-output");
    expect(
      logs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .filter((message) => message === "initialized" || message === "cleanup fragment"),
    ).toEqual(["initialized", "cleanup fragment", "initialized", "cleanup fragment"]);
    expect(
      logs
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .filter((message) => message === "initialization warning"),
    ).toEqual(["initialization warning", "initialization warning"]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  });

  it("retains compilation failures in the plugin stderr tail", async () => {
    const directory = await createPlugin("broken-compile", `export default function contribute( {`);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("broken-compile", directory)).rejects.toThrow();

    expect(
      runtime.getLogs("broken-compile").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      {
        stream: "stdout",
        message: "[paseo] Loading plugin",
      },
      {
        stream: "stderr",
        message: expect.stringContaining("Plugin failed to load:"),
      },
    ]);
    await runtime.stopAll();
  });

  it("waits for the old subprocess to exit before starting its replacement", async () => {
    const directory = await createPlugin(
      "reloadable",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const children = [createReloadChild("old", events), createReloadChild("new", events)];
    const runtime = createTestRuntime({
      spawnChild: () => {
        const child = children.shift();
        if (!child) throw new Error("Unexpected extra child");
        return child;
      },
    });
    await runtime.startPlugin("configured-id", directory);

    await runtime.stopPluginById("configured-id");
    await runtime.startPlugin("configured-id", directory);

    expect(events).toEqual(["start:old", "shutdown:old", "exit:old", "start:new"]);
    await runtime.stopAll();
  });

  it("rejects pending RPCs when the plugin stops", async () => {
    const directory = await createPlugin(
      "pending",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("pending", [], ["wait"]);
    const runtime = createTestRuntime({
      spawnChild: () => child,
    });
    await runtime.startPlugin("pending", directory);

    const rejection = expect(runtime.invoke("pending", "wait", {})).rejects.toThrow(
      "Plugin stopped: pending",
    );
    await runtime.stopPluginById("pending");

    await rejection;
  });

  it("waits for asynchronous plugin cleanup before stopping", async () => {
    const cleanupFile = path.join(tmpdir(), `paseo-plugin-cleanup-${Date.now()}`);
    const directory = await createPlugin(
      "async-cleanup",
      `import { writeFile } from "node:fs/promises";
export default function contribute(plugin: unknown) {
  void plugin;
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(${JSON.stringify(cleanupFile)}, "cleaned");
  };
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("async-cleanup", directory);

    await runtime.stopPluginById("async-cleanup");

    await expect(readFile(cleanupFile, "utf8")).resolves.toBe("cleaned");
    await rm(cleanupFile, { force: true });
  });

  it("offers graceful cleanup and bounds a service that never finishes it", async () => {
    const directory = await createPlugin(
      "held-cleanup",
      `export default function contribute(plugin: unknown) {
  return async () => {
    console.log("cleanup-entered");
    await new Promise(() => {});
  };
}`,
    );
    const tracked = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: tracked.host });
    try {
      await runtime.startPlugin("held-cleanup", directory);
      expect(tracked.active.size).toBe(1);
      await expect(runtime.stopPluginById("held-cleanup")).resolves.toBe(true);
      expect(runtime.catalog()).toEqual([]);
      expect(tracked.active.size).toBe(0);
      expect(runtime.getLogs("held-cleanup").some(entry => entry.message === "cleanup-entered")).toBe(true);
    } finally {
      await runtime.stopAll();
    }
  }, 10_000);

  it("cancels pending setup before cleanup and releases resources returned after cancellation", async () => {
    const directory = await createPlugin("cancel-setup", `import {appendFile} from 'node:fs/promises';
import type {PluginServiceContext} from '@omp-desktop/plugin/server';
export default async function contribute(plugin: PluginServiceContext) {
  const output = new URL('./released.txt', import.meta.url);
  plugin.own(() => appendFile(output, 'owned:' + plugin.signal.aborted + '\\n'));
  console.log('setup-waiting');
  const cancelled = Promise.withResolvers<void>();
  plugin.signal.addEventListener('abort', () => cancelled.resolve(), {once:true});
  await cancelled.promise;
  return () => appendFile(output, 'returned:' + plugin.signal.aborted + '\\n');
}`);
    const tracked = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: tracked.host });
    const starting = runtime.startPlugin("cancel-setup", directory);
    const rejected = expect(starting).rejects.toThrow("Plugin start cancelled: cancel-setup");
    try {
      await expect.poll(() => runtime.getLogs("cancel-setup").some(entry => entry.message === "setup-waiting")).toBe(true);
      await expect(runtime.stopPluginById("cancel-setup")).resolves.toBe(true);
      await rejected;
      expect((await readFile(path.join(directory, "released.txt"), "utf8")).trim().split("\n").sort()).toEqual(["owned:true", "returned:true"]);
      expect(runtime.catalog()).toEqual([]);
      expect(tracked.active.size).toBe(0);
    } finally {
      await runtime.stopAll();
    }
  }, 10_000);

  it("kills a plugin child that fails initialization", async () => {
    const directory = await createPlugin(
      "broken",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const listeners = new Map<string, Array<(message: never) => void>>();
    const child = {
      connected: true,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      send(message: { type: string }, callback?: (error: Error | null) => void) {
        callback?.(null);
        if (message.type === "initialize") {
          queueMicrotask(() => {
            for (const listener of listeners.get("message") ?? []) {
              listener({ type: "fatal", error: "broken plugin" } as never);
            }
          });
        }
        return true;
      },
      kill() {
        this.killed = true;
        this.connected = false;
        this.signalCode = "SIGKILL";
        return true;
      },
      disconnect() {
        this.connected = false;
      },
      on(event: string, listener: (message: never) => void) {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
        return this;
      },
    };
    const runtime = createTestRuntime({
      spawnChild: () => child,
    });

    await expect(runtime.startPlugin("broken", directory)).rejects.toThrow("broken plugin");

    expect(child.killed).toBe(true);
    await runtime.stopAll();
  });

  it("rejects a server contribution without cleanup", async () => {
    const directory = await createPlugin(
      "missing-cleanup",
      `export default function contribute(plugin: unknown) { void plugin; }`,
    );
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("missing-cleanup", directory)).rejects.toThrow(
      "must return a cleanup function",
    );
    expect(runtime.catalog()).toEqual([]);
    await runtime.stopAll();
  });

  it("does not grant package versions named legacy the historical global facade", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "package-version-legacy-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "package-version-legacy", version: "legacy",
      ompDesktop: { apiVersion: 1, id: "package-version-legacy", owner: "daemon", entries: { service: "./service.mjs" }, capabilities: [] },
    }));
    await writeFile(path.join(directory, "service.mjs"), `export default ctx => ctx.paseo.config.get();`);
    const runtime = createTestRuntime();
    await expect(runtime.startPlugin("package-version-legacy", directory)).rejects.toThrow("Global host API is unavailable to plugin: config");
    expect(runtime.catalog()).toEqual([]);
    await runtime.stopAll();
  });

  it("loads the official Linear attachment extension", async () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../plugin-examples/linear",
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("linear", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stopAll();
  });

  it("loads one index.tsx, exposes its client bundle, and invokes its server RPC", async () => {
    const directory = await createPlugin(
      "hello",
      `import React from "react";
import { platform } from "node:os";
import { Text } from "react-native";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "@omp-desktop/plugin";

const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string(), platform: z.string() }),
});

const attachments = defineAttachmentSource({
  id: "issues",
  title: "Example issue",
  icon: "CircleDot",
  pickerTitle: "Attach example issue",
  searchPlaceholder: "Search issues",
  search: greetRpc,
});

function HelloSurface() {
  return <Text>Hello from native UI</Text>;
}

function ReviewPanel() {
  return <Text>Workspace review panel</Text>;
}

export default function contribute(plugin: any) {
  plugin.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  plugin.addSurface("main", HelloSurface);
  plugin.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  plugin.addWorkspacePanel({ id: "review", title: "Review", icon: "Scan", context: "workspace", Component: ReviewPanel });
  plugin.addCommandCenterItem({ id: "open-review", title: "Open review", icon: "Scan", context: "workspace", onSelect() {} });
  plugin.addAttachmentSource(attachments);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("hello", directory);

    const catalog = runtime.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("hello");
    expect(catalog[0]?.clientBundle).toContain("Hello from native UI");
    expect(catalog[0]?.clientBundle).toContain("Attach example issue");
    expect(catalog[0]?.clientBundle).toContain("Workspace review panel");
    expect(catalog[0]?.clientBundle).toContain("Open review");
    expect(catalog[0]?.clientBundle).not.toContain("node:os");
    expect(catalog[0]?.clientBundle).not.toContain("get: () => from[key]");
    await expect(runtime.invoke("hello", "greet", { name: "Paseo" })).resolves.toMatchObject({
      message: "Hello, Paseo",
    });
    await expect(runtime.invoke("hello", "greet", { name: 7 })).rejects.toThrow();

    await runtime.stopAll();
  });

  // COMPAT(plugin-sdk-scope): plugins scaffolded through 0.5.0-beta.1 import the unpublished
  // @paseo/plugin name. Drop with the specifiers in plugin-sdk-specifiers.ts.
  it("loads a plugin that imports the pre-rename @paseo/plugin specifier", async () => {
    const directory = await createPlugin(
      "legacy-sdk",
      `import { z } from "zod";
import { defineRpc } from "@paseo/plugin/server";

const pingRpc = defineRpc({
  name: "ping",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export default function contribute(plugin: any) {
  plugin.handle(pingRpc, async () => ({ ok: true }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("legacy-sdk", directory);

    await expect(runtime.invoke("legacy-sdk", "ping", {})).resolves.toMatchObject({ ok: true });

    await runtime.stopAll();
  });

  it("keeps client and server modules in their target runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "split-runtime" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@omp-desktop/plugin";
import { Surface } from "./surface.client";
import { inspectRpc } from "./inspect.shared";
import { inspectHost } from "./inspect.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspectRpc, inspectHost);
  plugin.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
        `import React from "react";
import { StyleSheet, Text } from "react-native";

const styles = StyleSheet.create({ label: { fontWeight: "600" } });

export function Surface() {
  return <Text style={styles.label}>Client-only surface</Text>;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.shared.ts"),
        `import { defineRpc } from "@omp-desktop/plugin/server";
import { z } from "zod";

export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ platform: z.string() }),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.server.ts"),
        `import { platform } from "node:os";
import type { z } from "zod";
import { inspectRpc } from "./inspect.shared";

export function inspectHost(_input: z.input<typeof inspectRpc.input>) {
  return { platform: platform() };
}`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await runtime.startPlugin("split-runtime", directory);

    const plugin = runtime.catalog()[0];
    expect(plugin?.clientBundle).toContain("Client-only surface");
    expect(plugin?.clientBundle).not.toContain("node:os");
    await expect(runtime.invoke("split-runtime", "inspect", {})).resolves.toMatchObject({
      platform: expect.any(String),
    });
    await runtime.stopAll();
  });

  it("rejects server imports from client-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@omp-desktop/plugin";
import { Surface } from "./surface.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
        `import { readSecret } from "./secret.server";
export function Surface() { return readSecret(); }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "secret.server.ts"),
        `export function readSecret() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
    await runtime.stopAll();
  });

  it("rejects client imports from server-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.ts"),
        `import type { PluginContext } from "@omp-desktop/plugin";
import { inspect } from "./inspect.server";
import { inspectRpc } from "./inspect.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(inspectRpc, inspect);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.shared.ts"),
        `import { defineRpc } from "@omp-desktop/plugin";
import { z } from "zod";
export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({}),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "inspect.server.ts"),
        `import { Surface } from "./surface.client";
export function inspect() { void Surface; return {}; }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "surface.client.tsx"),
        `export function Surface() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "client-only module cannot be imported into the plugin server bundle",
    );
    await runtime.stopAll();
  });

  it("rejects a handler result that does not match its RPC output schema", async () => {
    const directory = await createPlugin(
      "invalid-output",
      `import { z } from "zod";
import { defineRpc } from "@omp-desktop/plugin";
const brokenRpc = defineRpc({
  name: "broken",
  input: z.object({}),
  output: z.object({ value: z.number() }),
});
export default function contribute(plugin: any) {
  plugin.handle(brokenRpc, async () => ({ value: "wrong" }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("invalid-output", directory);

    await expect(runtime.invoke("invalid-output", "broken", {})).rejects.toThrow();
    await runtime.stopAll();
  });

  it("uses the config key as runtime identity without comparing the manifest id", async () => {
    const directory = await createPlugin(
      "actual",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("configured", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["configured"]);
    await runtime.stopAll();
  });

  it("isolates two active installation IDs sharing the same source directory", async () => {
    const directory = await createPlugin("shared-package", `import {defineRpc, type PluginServiceContext} from '@getpaseo/plugin/server';
import {z} from 'zod';
const identity=defineRpc({name:'identity',input:z.object({}),output:z.string()});
export default function contribute(plugin: PluginServiceContext) {
  plugin.handle(identity,()=>plugin.installation.id);
  return () => {};
}`);
    const tracked = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: tracked.host });
    try {
      await Promise.all([runtime.startPlugin("first-install", directory), runtime.startPlugin("second-install", directory)]);
      expect(tracked.active.size).toBe(2);
      expect(await runtime.invoke("first-install", "identity", {})).toBe("first-install");
      expect(await runtime.invoke("second-install", "identity", {})).toBe("second-install");
      await runtime.stopPluginById("first-install");
      expect(tracked.active.size).toBe(1);
      expect(await runtime.invoke("second-install", "identity", {})).toBe("second-install");
    } finally {
      await runtime.stopAll();
    }
    expect(tracked.active.size).toBe(0);
  });

  it("cancels before attaching a session or executing a blocked service", async () => {
    const directory = await createPlugin(
      "blocked",
      `export default function contribute(plugin: unknown) { void plugin; console.log("blocked-initialized"); return () => {}; }`,
    );
    const tracked = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: tracked.host });
    await expect(runtime.startPlugin("blocked", directory, () => false)).rejects.toThrow("Plugin start cancelled: blocked");
    expect(runtime.catalog()).toEqual([]);
    expect(tracked.active.size).toBe(0);
    expect(runtime.getLogs("blocked").some(entry => entry.message === "blocked-initialized")).toBe(false);
    await runtime.stopAll();
  });

  it("reports an unexpected subprocess crash and removes its catalog entry", async () => {
    const directory = await createPlugin(
      "crashing",
      `export default function contribute(plugin: unknown) {
  void plugin;
  process.stdout.write("before crash");
  setTimeout(() => process.exit(17), 20);
  return () => undefined;
}`,
    );
    const sessions = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: sessions.host });
    const crashed = new Promise<string>((resolve) => {
      runtime.subscribe((pluginId, error) => {
        if (pluginId === "crashing" && error) resolve(error);
      });
    });
    await runtime.startPlugin("crashing", directory);

    await expect(crashed).resolves.toBe("Plugin process exited: crashing");
    expect(sessions.active.size).toBe(0);
    expect(runtime.catalog()).toEqual([]);
    expect(runtime.getLogs("crashing").map((entry) => entry.message)).toContain("before crash");
    await expect(runtime.invoke("crashing", "anything", {})).rejects.toThrow(
      "Plugin is not available",
    );
  });
});
