import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { OmpAgentSession } from "./agent.js";
import { OmpHistoryMapper } from "./message-history.js";
import {
  OmpCliRuntime,
  hasOmpUltrafastCommand,
  resolveOmpCodexCatalogPreloadPath,
  resolveOmpServiceTierExtensionPath,
  startOmpRpcSession,
} from "./cli-runtime.js";
import type { OmpRuntimeLaunch, OmpRuntimeRetirement } from "./runtime.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { streamOmpHistory } from "./history.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";
import desktopServiceTier, { type NativeServiceTierApi } from "./service-tier-extension.js";

import { JsonlRpcProcess } from "../jsonl-rpc-process.js";
type OmpChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: Array<NodeJS.Signals | number | undefined>;
};

function createOmpChild(options?: {
  supportedProtocolVersions?: number[];
  emitReady?: boolean;
  maxFrameBytes?: number;
}): OmpChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killedSignals: [],
  }) as OmpChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal);
    queueMicrotask(() => finishOmpChild(child, null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  // Real OMP writes a `ready` frame immediately after launch; the runtime waits
  // for it before negotiating the RPC protocol. Advertise v1-only by default so
  // the session stays on protocol v1 and command streams are unaffected.
  if (options?.emitReady !== false) {
    child.stdout.write(
      `${JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: options?.supportedProtocolVersions ?? [1],
        maxFrameBytes: options?.maxFrameBytes ?? 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      })}\n`,
    );
  }
  return child;
}

function finishOmpChild(
  child: OmpChild,
  code: number | null,
  signal: NodeJS.Signals | number | null = null,
): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit("exit", code, signal);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, signal);
}

function createRuntime(
  child: OmpChild,
  launches: OmpRuntimeLaunch[] = [],
  runtimeSettings?: ProviderRuntimeSettings,
  disabledBuiltInTools?: readonly string[],
): OmpCliRuntime {
  return new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["omp"],
    runtimeSettings,
    disabledBuiltInTools,
    commandsRpcName: "get_available_commands",
    spawnProcess: (launch) => {
      launches.push(launch);
      return child;
    },
  });
}

function replyToCommands(
  child: OmpChild,
  handler: (command: Record<string, unknown>) => unknown,
): void {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const command = JSON.parse(line) as Record<string, unknown>;
      const result = handler(command);
      child.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: result,
        })}\n`,
      );
    }
  });
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command;
  return rest;
}

async function backgroundJobsServer(processes: unknown[] = []) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ processes }));
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    port: address.port,
    requests,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

const recoveryCommand = "desktop-background-jobs-12345678-abcd";
function announceBackgroundJobs(child: OmpChild, port: number, generation: number) {
  child.stdout.write(
    `${JSON.stringify({
      type: "desktop_background_jobs_ready",
      port,
      generation,
      token: `secret-${generation}`,
      recoveryCommand,
    })}\n`,
  );
}

describe("OMP CLI runtime", () => {
  test("keeps startup inventory unknown until an authenticated bridge can confirm empty", async () => {
    const child = createOmpChild();
    const commands: string[] = [];
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      return { commands: [] };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const bridge = await backgroundJobsServer();
    try {
      await expect(session.listBackgroundJobs!()).rejects.toThrow("not ready");
      expect(commands).not.toContain("prompt");
      expect(bridge.requests).toEqual([]);
      announceBackgroundJobs(child, bridge.port, 1);
      expect(await session.listBackgroundJobs!()).toEqual([]);
      expect(bridge.requests).toEqual(["Bearer secret-1"]);
    } finally {
      await session.close();
      await bridge.close();
    }
  });

  test("recovers a refused cached bridge in a living child without losing active jobs or native kernels", async () => {
    const dead = await backgroundJobsServer();
    await dead.close();
    const jobs = [
      {
        id: "omp-job:owned:bg_1",
        name: "calculation",
        command: "calculation",
        cwd: "/workspace/project",
        ownerAgentId: null,
        scope: "agent",
        source: "omp-job",
        status: "running",
        startedAt: 1,
        endedAt: null,
        exitCode: null,
        terminalId: null,
      },
    ];
    const bridge = await backgroundJobsServer(jobs);
    const child = createOmpChild();
    const requests: string[] = [];
    const resources = [
      {
        id: "eval:kernel",
        kind: "javascript_kernel",
        ownerSessionId: "owner",
        state: "retained",
        retentionReasons: ["variables"],
        liveHandles: 0,
        releasable: true,
      },
    ];
    replyToCommands(child, (command) => {
      requests.push(String(command.type));
      if (command.type === "get_available_commands")
        return { commands: [{ name: recoveryCommand, source: "extension" }] };
      if (command.type === "execute_extension_command") {
        announceBackgroundJobs(child, bridge.port, 2);
        return { executed: true };
      }
      if (command.type === "get_runtime_resources") return { resources };
      return {};
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    try {
      announceBackgroundJobs(child, dead.port, 1);
      expect(
        await Promise.all([session.listBackgroundJobs!(), session.listBackgroundJobs!()]),
      ).toEqual([jobs, jobs]);
      expect(requests.filter((type) => type === "execute_extension_command")).toHaveLength(1);
      expect(await session.getRuntimeResources!()).toEqual(resources);
      expect(await session.getCommands()).toEqual([]);
      expect(requests).not.toContain("prompt");
      expect(child.killedSignals).toEqual([]);
      expect(bridge.requests).toEqual(["Bearer secret-2", "Bearer secret-2"]);
    } finally {
      await session.close();
      await bridge.close();
    }
  });

  test("ignores old-generation cleanup and fails closed on shutdown or confirmed process exit", async () => {
    const bridge = await backgroundJobsServer();
    const child = createOmpChild();
    const commands: string[] = [];
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      if (command.type === "get_available_commands")
        return { commands: [{ name: recoveryCommand, source: "extension" }] };
      return { executed: true };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const invalidate = (generation: number) =>
      child.stdout.write(
        `${JSON.stringify({
          type: "desktop_background_jobs_invalidated",
          generation,
        })}\n`,
      );
    try {
      announceBackgroundJobs(child, bridge.port, 3);
      invalidate(1);
      announceBackgroundJobs(child, bridge.port, 2);
      expect(await session.listBackgroundJobs!()).toEqual([]);
      expect(bridge.requests).toEqual(["Bearer secret-3"]);
      invalidate(3);
      await expect(session.listBackgroundJobs!()).rejects.toThrow("did not advertise readiness");
      expect(bridge.requests).toHaveLength(1);
      finishOmpChild(child, 0);
      child.stdout.emit(
        "data",
        `${JSON.stringify({
          type: "desktop_background_jobs_ready",
          port: bridge.port,
          generation: 4,
          token: "secret-4",
          recoveryCommand,
        })}\n`,
      );
      await expect(session.listBackgroundJobs!()).rejects.toThrow("runtime has exited");
      expect(bridge.requests).toHaveLength(1);
      expect(commands).not.toContain("prompt");
    } finally {
      await session.close();
      await bridge.close();
    }
  });

  test("replays the retained ancestry after branch removes its selected user checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-branch-replay-"));
    const sessionFile = join(dir, "session.jsonl");
    const prefix = [
      { type: "session", id: "root", cwd: dir },
      {
        type: "message",
        id: "kept",
        parentId: "root",
        message: { role: "user", content: "Kept prompt" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "kept",
        message: { role: "assistant", content: [{ type: "text", text: "Kept answer" }] },
      },
    ];
    const serialize = (entries: unknown[]) =>
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(
      sessionFile,
      serialize([
        ...prefix,
        {
          type: "message",
          id: "revoked",
          parentId: "answer",
          message: { role: "user", content: "Revoked checkpoint" },
        },
      ]),
    );
    const child = createOmpChild();
    replyToCommands(child, (command) => {
      if (command.type === "branch") {
        const replacement = join(dir, "replacement.jsonl");
        writeFileSync(replacement, serialize(prefix));
        renameSync(replacement, sessionFile);
        return { text: "Revoked checkpoint" };
      }
      return {
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "root",
        sessionFile,
        messageCount: 3,
        queuedMessageCount: 0,
      };
    });
    const session = await createRuntime(child).startSession({ cwd: dir });
    try {
      await session.branch("revoked");
      const items: AgentStreamEvent[] = [];
      for await (const event of streamOmpHistory({
        sessionFile,
        runtimeSession: session,
        runtimeSettings: ompHistoryRuntimeSettings,
        provider: "omp",
      }))
        items.push(event);
      expect(
        items.flatMap((event) =>
          event.type === "timeline" && event.item.type === "user_message" ? [event.item.text] : [],
        ),
      ).toEqual(["Kept prompt"]);
      expect(
        items.flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        ),
      ).toEqual(["Kept answer"]);
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts SDK extension_error frames and shows source/category without credentials or local paths", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({}));
    const runtimeSession = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const session = new OmpAgentSession({
      runtimeSession,
      initialState: {
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "extension-errors",
        messageCount: 0,
        queuedMessageCount: 0,
      },
      config: { provider: "omp", cwd: "/workspace/project" },
      logger: pino({ level: "silent" }),
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      for (const event of ["session_start", "tool_registration"]) {
        child.stdout.write(
          `${JSON.stringify({
            type: "extension_error",
            extensionPath: "C:\\Users\\private-user\\private-project\\figma-plugin.ts",
            event,
            error:
              "Registration failed: apiKey=private-key\nAuthorization: Bearer private-token\nat C:\\Users\\private-user\\private-project\\plugin.ts:9\nat /home/private-user/private-project/plugin.ts:9\nhttps://name:password@example.test/path?token=private-query",
          })}\n`,
        );
      }
      await waitForImmediate();
      const notices = events.flatMap((event) =>
        event.type === "timeline" && event.item.type === "extension_notification"
          ? [event.item]
          : [],
      );
      expect(notices).toHaveLength(2);
      expect(notices[0]).toMatchObject({
        level: "error",
        message: expect.stringContaining("[figma-plugin.ts: session_start] Registration failed"),
      });
      expect(notices[1]).toMatchObject({
        level: "error",
        message: expect.stringContaining(
          "[figma-plugin.ts: tool_registration] Registration failed",
        ),
      });
      const visible = JSON.stringify(notices);
      for (const secret of [
        "private-user",
        "private-project",
        "private-key",
        "private-token",
        "private-query",
        "password",
        "C:\\",
        "/home/",
      ]) {
        expect(visible).not.toContain(secret);
      }
    } finally {
      await session.close();
    }
  });

  test("keeps a packaged preload path out of whitespace-tokenized BUN_OPTIONS", async () => {
    const child = createOmpChild();
    const launches: OmpRuntimeLaunch[] = [];
    const session = await createRuntime(child, launches).startSession({
      cwd: "/workspace/project",
      env: { BUN_OPTIONS: "--inspect" },
    });

    const launch = launches[0]!;
    const preloadPath = resolveOmpCodexCatalogPreloadPath();
    expect(launch.env).toMatchObject({
      BUN_OPTIONS:
        "--inspect --preload=data:text/javascript,await%20import(process%2Eenv%2EOMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL)",
      OMP_DESKTOP_CODEX_CATALOG_PRELOAD_URL: pathToFileURL(preloadPath).href,
    });
    expect(launch.env?.BUN_OPTIONS).not.toContain(preloadPath);

    await session.close();
  });

  test("rejects custom tool flags in command and session options while a policy is set", async () => {
    const child = createOmpChild();
    const runtime = createRuntime(
      child,
      [],
      { command: { mode: "append", args: ["--tools=read"] } },
      ["write"],
    );
    await expect(runtime.startSession({ cwd: "/workspace/project" })).rejects.toThrow("conflict");
    const optionsRuntime = createRuntime(child, [], undefined, ["write"]);
    await expect(
      optionsRuntime.startSession({
        cwd: "/workspace/project",
        extraArgs: ["--no-tools"],
      }),
    ).rejects.toThrow("conflict");
  });

  test("starts with a release build whose registered tools are a subset of the version catalog", async () => {
    const binary = `
      const args = process.argv.slice(1);
      if (args.includes("--version")) {
        process.stdout.write("omp/18.4.4");
        process.exit();
      }
      if (args.includes("--help")) {
        process.stdout.write("--tools <names> --no-tools");
        process.exit();
      }
      const selection = args.indexOf("--tools");
      if (selection >= 0 && args[selection + 1] !== "read") {
        process.stderr.write("Unknown tools in --tools");
        process.exit(2);
      }
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1 }) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\\n")) >= 0) {
          const command = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          process.stdout.write(JSON.stringify({
            type: "response", id: command.id, command: command.type, success: true,
            data: {
              model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false,
              sessionId: selection >= 0 ? "selected-release-build" : "inventory-only",
              messageCount: 0, queuedMessageCount: 0,
              dumpTools: [{ name: "read" }, { name: "write" }],
            },
          }) + "\\n");
        }
      });
    `;
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: [process.execPath, "-e", binary, "--"],
      disabledBuiltInTools: ["write"],
    });
    const session = await runtime.startSession({ cwd: process.cwd() });
    try {
      await expect(session.getState()).resolves.toMatchObject({
        sessionId: "selected-release-build",
      });
    } finally {
      await session.close();
    }
  });

  test("validates session state with the documented queued message count", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    });
  });

  test("sends live fast-mode RPC commands and validates their result", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(withoutRequestId(command));
      return { enabled: command.enabled, active: command.enabled };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.setFastMode(true)).resolves.toEqual({ enabled: true, active: true });
    expect(commands).toEqual([{ type: "set_fast_mode", enabled: true }]);
  });

  test.each([
    { source: "builtin", input: { hint: "[on|ultra|off|status]" }, supported: true },
    { source: "builtin", subcommands: [{ name: "ultra" }], supported: true },
    { source: "extension", input: { hint: "[on|ultra|off|status]" }, supported: false },
    { source: "builtin", input: { hint: "[on|off|status]" }, supported: false },
    { source: undefined, input: { hint: "[on|ultra|off|status]" }, supported: false },
  ])("gates Ultra on a builtin fast command: $source $supported", ({ supported, ...command }) => {
    expect(hasOmpUltrafastCommand([{ name: "fast", ...command }])).toBe(supported);
    expect(hasOmpUltrafastCommand([{ name: "not-fast", ...command }])).toBe(false);
  });

  test.each([
    {
      provider: "openai-codex",
      id: "gpt-6.1-sol",
      api: "openai-codex-responses",
      serviceTiers: ["priority", "ultrafast"],
    },
    {
      provider: "custom-openai",
      id: "gpt-api",
      identity: { class: "openai" },
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      provider: "custom-openai",
      id: "gpt-api",
      identity: { class: "openai" },
      api: "openai-completions",
      baseUrl: "https://api.openai.com:443/v1",
    },
    {
      provider: "custom-openai",
      id: "gpt-api",
      identity: { class: "openai" },
      api: "openai-responses",
      baseUrl: "https://gateway.example/v1",
      serviceTiers: ["ultrafast"],
    },
  ])("reads native Ultra without losing model metadata: $provider/$api", async (candidate) => {
    const child = createOmpChild();
    const launches: OmpRuntimeLaunch[] = [];
    const model = { ...candidate, nativeExtra: { retained: true } };
    const commands: string[] = [];
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      return command.type === "get_available_commands"
        ? { commands: [{ name: "fast", source: "builtin", subcommands: [{ name: "ultra" }] }] }
        : {
            model,
            isStreaming: false,
            isCompacting: false,
            sessionId: "ultra-session",
            fastModeEnabled: true,
            fastModeActive: true,
            messageCount: 0,
            queuedMessageCount: 0,
          };
    });
    const session = await createRuntime(child, launches).startSession({
      cwd: "/workspace/project",
    });
    child.stdout.write(`${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`);
    const native = {
      available: true,
      model: { provider: model.provider, id: model.id },
      openaiFamily: true,
      tier: "ultrafast",
      ultrafastAvailable: true,
    };
    const fetchApi = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(native)));
    try {
      expect(launches[0]!.argv).toContain(resolveOmpServiceTierExtensionPath());
      expect(launches[0]!.env?.OMP_DESKTOP_SERVICE_TIER_TOKEN).toBeTruthy();
      await expect(session.getState()).resolves.toMatchObject({
        fastModeTier: "ultrafast",
        ultrafastSupported: true,
        model,
      });
      expect(commands).toEqual(["get_state", "get_available_commands"]);
      expect(fetchApi).toHaveBeenCalledWith(
        "http://127.0.0.1:12345/tier",
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${launches[0]!.env!.OMP_DESKTOP_SERVICE_TIER_TOKEN}` },
        }),
      );
    } finally {
      fetchApi.mockRestore();
      await session.close();
    }
  });

  test.each([
    { available: true, source: "builtin", ultrafast: true },
    { available: false, source: "builtin", ultrafast: false },
    { available: true, source: "extension", ultrafast: false },
  ])(
    "discovers catalog tier controls independently of the selected model: $available/$source",
    async ({ available, source, ultrafast }) => {
      const child = createOmpChild();
      const commands: string[] = [];
      replyToCommands(child, (command) => {
        commands.push(String(command.type));
        return command.type === "get_available_commands"
          ? { commands: [{ name: "fast", source, subcommands: [{ name: "ultra" }] }] }
          : {
              model: { provider: "anthropic", id: "catalog-default" },
              isStreaming: false,
              isCompacting: false,
              sessionId: "catalog-session",
              fastModeEnabled: false,
              fastModeActive: false,
              messageCount: 0,
              queuedMessageCount: 0,
            };
      });
      const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
      child.stdout.write(
        `${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`,
      );
      const fetchApi = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            available,
            model: { provider: "anthropic", id: "catalog-default" },
            openaiFamily: false,
            tier: null,
            ultrafastAvailable: false,
          }),
        ),
      );
      try {
        await expect(session.getServiceTierCapabilities?.()).resolves.toEqual({
          fastMode: true,
          ultrafast,
        });
        expect(commands).toEqual(
          available ? ["get_state", "get_available_commands"] : ["get_state"],
        );
      } finally {
        fetchApi.mockRestore();
        await session.close();
      }
    },
  );

  test.each([
    { advertised: false, available: true, source: "builtin" },
    { advertised: true, available: false, source: "builtin" },
    { advertised: true, available: true, source: "extension" },
  ])(
    "hides Ultra without both native capabilities and model advertisement: $advertised/$available/$source",
    async ({ advertised, available, source }) => {
      const child = createOmpChild();
      const model = {
        provider: "openai-codex",
        id: "gpt-6.1-sol",
        api: "openai-codex-responses",
        serviceTiers: advertised ? ["priority", "ultrafast"] : ["priority"],
      };
      replyToCommands(child, (command) =>
        command.type === "get_available_commands"
          ? { commands: [{ name: "fast", source, input: { hint: "[on|ultra|off|status]" } }] }
          : {
              model,
              isStreaming: false,
              isCompacting: false,
              sessionId: "session",
              fastModeEnabled: true,
              fastModeActive: false,
              messageCount: 0,
              queuedMessageCount: 0,
            },
      );
      const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
      child.stdout.write(
        `${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`,
      );
      const fetchApi = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            available,
            model,
            openaiFamily: true,
            tier: "ultrafast",
            ultrafastAvailable: available && advertised,
          }),
        ),
      );
      try {
        await expect(session.getState()).resolves.toMatchObject({
          ultrafastSupported: false,
          ...(available ? { fastModeTier: "ultrafast" } : {}),
        });
      } finally {
        fetchApi.mockRestore();
        await session.close();
      }
    },
  );
  test.each([
    { baseUrl: "https://api.openai.com/v1", serviceTiers: [] },
    { baseUrl: "https://gateway.example/v1", serviceTiers: undefined },
    { baseUrl: "https://api.openai.com.evil.example/v1", serviceTiers: undefined },
    { baseUrl: "https://api.openai.com/v1", serviceTiers: ["priority"] },
  ])(
    "does not trust native Ultra on an ineligible API model: $baseUrl/$serviceTiers",
    async (declaration) => {
      const child = createOmpChild();
      const model = {
        provider: "custom-openai",
        id: "gpt-api",
        identity: { class: "openai" },
        api: "openai-responses",
        ...declaration,
      };
      replyToCommands(child, (command) =>
        command.type === "get_available_commands"
          ? { commands: [{ name: "fast", source: "builtin", subcommands: [{ name: "ultra" }] }] }
          : {
              model,
              isStreaming: false,
              isCompacting: false,
              sessionId: "ineligible-api",
              fastModeEnabled: true,
              fastModeActive: true,
              messageCount: 0,
              queuedMessageCount: 0,
            },
      );
      const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
      child.stdout.write(
        `${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`,
      );
      const fetchApi = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            available: true,
            model,
            openaiFamily: true,
            tier: "ultrafast",
            ultrafastAvailable: true,
          }),
        ),
      );
      try {
        await expect(session.getState()).resolves.toMatchObject({
          ultrafastSupported: false,
          fastModeTier: "ultrafast",
        });
      } finally {
        fetchApi.mockRestore();
        await session.close();
      }
    },
  );
  test("requires the private native bridge even if get_state claims API Ultra support", async () => {
    const child = createOmpChild();
    const commands: string[] = [];
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      return {
        model: {
          provider: "custom-openai",
          id: "gpt-api",
          identity: { class: "openai" },
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
        ultrafastSupported: true,
        fastModeEnabled: false,
        fastModeActive: false,
        isStreaming: false,
        isCompacting: false,
        sessionId: "legacy-api",
        messageCount: 0,
        queuedMessageCount: 0,
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    try {
      await expect(session.getState()).resolves.toMatchObject({ ultrafastSupported: false });
      await expect(session.getServiceTierCapabilities?.()).resolves.toEqual({
        fastMode: true,
        ultrafast: false,
      });
      expect(commands).toEqual(["get_state", "get_state"]);
    } finally {
      await session.close();
    }
  });

  test.each(["openai-responses", "openai-completions"])(
    "selects API Ultra from an active session through the real native bridge: %s",
    async (api) => {
      const child = createOmpChild();
      const model = {
        provider: "custom-openai",
        id: "gpt-api",
        identity: { class: "openai" },
        api,
        baseUrl: "https://api.openai.com/v1",
      };
      const tiers: Record<string, string | undefined> = { anthropic: "priority" };
      const commands: string[] = [];
      replyToCommands(child, (command) => {
        commands.push(String(command.type));
        if (command.type === "get_available_commands")
          return {
            commands: [{ name: "fast", source: "builtin", subcommands: [{ name: "ultra" }] }],
          };
        if (command.type === "get_state")
          return {
            model,
            isStreaming: false,
            isCompacting: false,
            sessionId: "api-native-bridge",
            fastModeEnabled: tiers.openai === "priority" || tiers.openai === "ultrafast",
            fastModeActive: tiers.openai === "priority" || tiers.openai === "ultrafast",
            messageCount: 0,
            queuedMessageCount: 0,
          };
        return {};
      });
      const launches: OmpRuntimeLaunch[] = [];
      const runtime = await createRuntime(child, launches).startSession({
        cwd: "/workspace/project",
      });
      const context = { model };
      let start!: (event: unknown, ctx: typeof context) => Promise<void>;
      let shutdown: (() => void) | undefined;
      const native: NativeServiceTierApi = {
        on: (event, handler) => {
          if (event === "session_start") start = handler as typeof start;
          else shutdown = handler as () => void;
        },
        getServiceTiers: () => ({ ...tiers }),
        setServiceTier: (family, tier) => {
          tiers[family] = tier;
        },
      };
      let session: OmpAgentSession | undefined;
      vi.stubEnv(
        "OMP_DESKTOP_SERVICE_TIER_TOKEN",
        launches[0]!.env!.OMP_DESKTOP_SERVICE_TIER_TOKEN!,
      );
      try {
        const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          child.stdout.write(String(chunk));
          return true;
        });
        try {
          desktopServiceTier(native);
          await start(undefined, context);
        } finally {
          output.mockRestore();
        }
        session = new OmpAgentSession({
          runtimeSession: runtime,
          initialState: await runtime.getState(),
          config: {
            provider: "omp",
            cwd: "/workspace/project",
            model: `${model.provider}/${model.id}`,
          },
          logger: pino({ level: "silent" }),
        });
        expect(session.features.find((feature) => feature.id === "fast_mode")).toMatchObject({
          type: "select",
          value: "off",
        });
        for (const [value, tier] of [
          ["ultrafast", "ultrafast"],
          ["on", "priority"],
          ["off", null],
        ] as const) {
          await session.setFeature("fast_mode", value);
          expect(session.features.find((feature) => feature.id === "fast_mode")).toMatchObject({
            type: "select",
            value,
          });
          await expect(runtime.getState()).resolves.toMatchObject({
            fastModeTier: tier,
            ultrafastSupported: true,
          });
          expect(tiers.anthropic).toBe("priority");
        }
        expect(commands).not.toContain("prompt");
        expect(commands).not.toContain("set_fast_mode");
      } finally {
        shutdown?.();
        vi.unstubAllEnvs();
        if (session) await session.close();
        else await runtime.close();
      }
    },
  );

  test("changes native tiers atomically over the private bridge without prompt or boolean RPC aliases", async () => {
    const child = createOmpChild();
    const commands: string[] = [];
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      return {
        commands: [{ name: "fast", source: "builtin", input: { hint: "[on|ultra|off|status]" } }],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    child.stdout.write(`${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`);
    const model = {
      provider: "openai-codex",
      id: "gpt-6.1-sol",
      name: "Large catalog metadata".repeat(200),
    };
    const updates: string[] = [];
    const fetchApi = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (Buffer.byteLength(String(init?.body)) > 1024) {
        return new Response(JSON.stringify({ error: "OMP service tier request is too large" }), {
          status: 400,
        });
      }
      const update = JSON.parse(String(init?.body)) as { value: string; model: typeof model };
      expect(update.model).toEqual({ provider: model.provider, id: model.id });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      updates.push(update.value);
      const selectedTier = update.value === "on" ? "priority" : update.value;
      return new Response(
        JSON.stringify({
          available: true,
          model,
          openaiFamily: true,
          ultrafastAvailable: true,
          tier: selectedTier === "off" ? null : selectedTier,
        }),
      );
    });
    try {
      for (const value of ["ultrafast", "on", "off"] as const) {
        const selectedTier = value === "on" ? "priority" : value;
        await expect(session.setFastModeTier(value, model)).resolves.toMatchObject({
          enabled: value !== "off",
          tier: selectedTier === "off" ? null : selectedTier,
        });
      }
      expect(updates).toEqual(["ultrafast", "on", "off"]);
      expect(commands).toEqual(["get_available_commands"]);
    } finally {
      fetchApi.mockRestore();
      await session.close();
    }
  });

  test("rejects failed, ignored, or model-raced private native updates", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      commands: [{ name: "fast", source: "builtin", input: { hint: "[on|ultra|off|status]" } }],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    child.stdout.write(`${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`);
    const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const native = {
      available: true,
      model,
      openaiFamily: true,
      ultrafastAvailable: true,
      tier: "priority",
    };
    const fetchApi = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "OMP native selection rejected" }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(native)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...native, model: { ...model, id: "changed" }, tier: "ultrafast" }),
        ),
      );
    try {
      await expect(session.setFastModeTier("ultrafast", model)).rejects.toThrow(
        "native selection rejected",
      );
      await expect(session.setFastModeTier("ultrafast", model)).rejects.toThrow("did not apply");
      await expect(session.setFastModeTier("ultrafast", model)).rejects.toThrow("did not apply");
      expect(fetchApi).toHaveBeenCalledTimes(3);
    } finally {
      fetchApi.mockRestore();
      await session.close();
    }
  });

  test("serializes tier writes with model RPCs until native readback completes", async () => {
    const child = createOmpChild();
    const commands: string[] = [];
    const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
    replyToCommands(child, (command) => {
      commands.push(String(command.type));
      return command.type === "set_model"
        ? { ...model, id: "other" }
        : { commands: [{ name: "fast", source: "builtin", subcommands: [{ name: "ultra" }] }] };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    child.stdout.write(`${JSON.stringify({ type: "desktop_service_tier_ready", port: 12345 })}\n`);
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetchApi = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const select = session.setFastModeTier("ultrafast", model);
    await started.promise;
    const switchModel = session.setModel(model.provider, "other");
    await waitForImmediate();
    expect(commands).toEqual(["get_available_commands"]);
    held.resolve(
      new Response(
        JSON.stringify({
          available: true,
          model,
          openaiFamily: true,
          ultrafastAvailable: true,
          tier: "ultrafast",
        }),
      ),
    );
    try {
      await select;
      await switchModel;
      expect(commands).toEqual(["get_available_commands", "set_model"]);
    } finally {
      fetchApi.mockRestore();
      await session.close();
    }
  });

  test("waits for OMP to acknowledge steering and reports delivery failures", async () => {
    const child = createOmpChild();
    child.stdin.once("data", (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString()) as { id?: string; type: string };
      child.stdout.write(
        `${JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          success: false,
          error: "steering unavailable",
        })}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    try {
      const delivery = Reflect.apply(session.steer, session, ["change direction"]) as unknown;
      expect(delivery).toBeInstanceOf(Promise);
      await expect(delivery).rejects.toThrow("steering unavailable");
    } finally {
      await session.close();
    }
  });

  test("reports an unsupported native-subagent stop instead of treating an RPC refusal as success", async () => {
    const child = createOmpChild();
    child.stdin.once("data", (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString()) as { id: string; type: string };
      child.stdout.write(
        `${JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          success: false,
          error: "Unknown command: cancel_subagent",
        })}\n`,
      );
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    try {
      await expect(session.cancelSubagent?.("child-1")).rejects.toThrow(
        "update OMP to v18.4.9 or newer",
      );
    } finally {
      await session.close();
    }
  });

  test("keeps compaction and its waiting prompt pending beyond the control-plane deadline", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) commands.push(JSON.parse(line));
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const settled: string[] = [];
    vi.useFakeTimers();
    try {
      const compaction = session.compact();
      const prompt = session.prompt("continue after compaction");
      void compaction.then(
        () => settled.push("compact"),
        () => settled.push("compact failed"),
      );
      void prompt.then(
        () => settled.push("prompt"),
        () => settled.push("prompt failed"),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toEqual([]);
      expect(commands.map((command) => command.type)).toEqual(["compact", "prompt"]);
      for (const command of commands) {
        child.stdout.write(
          `${JSON.stringify({
            type: "response",
            id: command.id,
            command: command.type,
            success: true,
            data: command.type === "prompt" ? { agentInvoked: true } : {},
          })}\n`,
        );
      }
      await expect(compaction).resolves.toBeUndefined();
      await expect(prompt).resolves.toEqual({ requestId: commands[1]!.id, agentInvoked: true });
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("rejects an unacknowledged prompt when its runtime exits", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    try {
      const prompt = session.prompt("waiting for admission");
      const failure = expect(prompt).rejects.toThrow("process exited");
      await waitForImmediate();
      finishOmpChild(child, 1);
      await failure;
    } finally {
      await session.close();
    }
  });

  test("accepts session state without thinkingLevel for non-reasoning models", async () => {
    const child = createOmpChild();
    // Models like cursor-grok-4.5-high-fast encode effort in the model ID, so
    // OMP marks them reasoning: false and omits thinkingLevel from get_state.
    replyToCommands(child, () => ({
      model: null,
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
  });

  test("rejects malformed RPC results instead of trusting transport data", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      thinkingLevel: "medium",
      isStreaming: "no",
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).rejects.toThrow();
  });

  test("emits validated known events and drops unknown frames", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    child.stdout.write(`${JSON.stringify({ type: "future_control", enabled: true })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "notice", level: "info", message: "ready" })}\n`);

    expect(eventTypes).toEqual(["notice"]);
  });

  test.each(["string", "blocks"] as const)(
    "completes a turn and restores replies when developer content uses %s",
    async (format) => {
      const child = createOmpChild();
      const userMessage = { role: "user", content: "finish the task", entryId: "user-1" };
      const developerMessage = {
        role: "developer",
        content:
          format === "string"
            ? "Internal rule reminder"
            : [{ type: "text", text: "Internal rule reminder" }],
        attribution: "agent",
        timestamp: 1,
      };
      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "task completed" }],
        responseId: "assistant-1",
        stopReason: "stop",
      };
      const messages = [userMessage, developerMessage, assistantMessage];
      const state = {
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "session-1",
        messageCount: messages.length,
        queuedMessageCount: 0,
      };
      replyToCommands(child, (command) => {
        switch (command.type) {
          case "prompt":
            return { agentInvoked: true };
          case "get_state":
            return state;
          case "get_messages":
            return { messages };
          case "get_session_stats":
            return {
              tokens: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, total: 1 },
              cost: 0,
            };
          default:
            return {};
        }
      });
      const runtimeSession = await createRuntime(child).startSession({
        cwd: "/workspace/project",
      });
      const session = new OmpAgentSession({
        runtimeSession,
        initialState: state,
        config: { provider: "omp", cwd: "/workspace/project" },
        logger: pino({ level: "silent" }),
      });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        const completion = session.run(userMessage.content);
        void completion.catch(() => undefined);
        await waitForImmediate();
        for (const event of [
          { type: "agent_start" },
          { type: "message_end", message: userMessage },
          { type: "message_start", message: developerMessage },
          { type: "message_end", message: developerMessage },
          { type: "message_start", message: assistantMessage },
          {
            type: "message_update",
            message: assistantMessage,
            assistantMessageEvent: { type: "text_delta", delta: "task completed" },
          },
          { type: "message_end", message: assistantMessage },
          { type: "agent_end", messages },
        ]) {
          child.stdout.write(`${JSON.stringify(event)}\n`);
        }
        await waitForImmediate();

        expect(
          events.filter(
            (event) =>
              event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_canceled",
          ),
        ).toEqual([expect.objectContaining({ type: "turn_completed" })]);
        await expect(completion).resolves.toMatchObject({ finalText: "task completed" });
        expect(events.flatMap((event) => (event.type === "timeline" ? [event.item] : []))).toEqual([
          { type: "user_message", text: "finish the task", messageId: "user-1" },
          { type: "assistant_message", text: "task completed", messageId: "assistant-1" },
        ]);

        const history = new OmpHistoryMapper("omp").mapMessages(await runtimeSession.getMessages());
        expect(history.map((event) => event.item)).toEqual([
          { type: "user_message", text: "finish the task" },
          { type: "assistant_message", text: "task completed", messageId: "assistant-1" },
        ]);
      } finally {
        await session.close();
      }
    },
  );

  test("lists commands through get_available_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [
          { name: "prewalk", description: "Prewalk at the next action", source: "builtin" },
        ],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      {
        name: "prewalk",
        description: "Prewalk at the next action",
        source: "builtin",
      },
    ]);
    expect(commandTypes).toEqual(["get_available_commands"]);
  });

  test("accepts model catalogs with null maxTokens from newer OMP binaries", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          maxTokens: null,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        maxTokens: null,
      }),
    ]);
  });

  test("accepts model catalogs with null contextWindow from NVIDIA", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "nvidia",
          id: "minimaxai/minimax-m3",
          name: "MiniMax-M3",
          contextWindow: null,
        },
        {
          provider: "zai",
          id: "glm-5.2",
          name: "GLM-5.2",
          contextWindow: 131_072,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "nvidia",
        id: "minimaxai/minimax-m3",
        contextWindow: null,
      }),
      expect.objectContaining({
        provider: "zai",
        id: "glm-5.2",
        contextWindow: 131_072,
      }),
    ]);
  });

  test("wraps OMP subagent RPC commands", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.setSubagentSubscription("events");

    expect(commands.map(withoutRequestId)).toEqual([
      { type: "set_subagent_subscription", level: "events" },
    ]);
  });

  test("accepts the empty prompt acknowledgement emitted by OMP 17", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => undefined);
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });
  });

  test("sends prompts with steer streaming behavior so a busy session admits them", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.prompt("hello");

    expect(commands.map(withoutRequestId)).toContainEqual({
      type: "prompt",
      message: "hello",
      streamingBehavior: "steer",
    });
  });

  test("keeps an owned retirement handle when protocol negotiation and its first process close fail", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    let owned: OmpRuntimeRetirement | undefined;
    let ownedAtNegotiation = false;
    replyToCommands(child, () => {
      ownedAtNegotiation = owned !== undefined;
      return { protocolVersion: 1 };
    });
    const closeError = new Error("process exit not confirmed");
    const failedClose = vi
      .spyOn(JsonlRpcProcess.prototype, "close")
      .mockRejectedValueOnce(closeError);
    try {
      await expect(
        startOmpRpcSession({
          launch: { cwd: tmpdir(), argv: [process.execPath] },
          logger: pino({ level: "silent" }),
          spawnProcess: () => child,
          onRetirementCreated: (session) => {
            owned = session;
          },
        }),
      ).rejects.toBe(closeError);
      expect(ownedAtNegotiation).toBe(true);
      expect(child.killedSignals).toEqual([]);
      failedClose.mockRestore();
      await owned!.close();
      expect(child.killedSignals).toContain("SIGTERM");
    } finally {
      failedClose.mockRestore();
      await owned?.close();
    }
  });

  test.each([false, undefined])(
    "closes the newly owned host when grouped ask enablement returns %s",
    async (enabled) => {
      const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
      const commands: string[] = [];
      replyToCommands(child, (command) => {
        commands.push(command.type as string);
        if (command.type === "negotiate_protocol") return { protocolVersion: 2 };
        return { enabled };
      });

      await expect(
        startOmpRpcSession({
          launch: { cwd: tmpdir(), argv: [process.execPath] },
          logger: pino({ level: "silent" }),
          spawnProcess: () => child,
          enableAskDialog: true,
        }),
      ).rejects.toThrow("OMP did not enable grouped ask dialogs");

      expect(commands).toEqual(["negotiate_protocol", "set_ask_dialog"]);
      expect(child.killedSignals).toEqual(["SIGTERM"]);
    },
  );

  test("awaits owned source cleanup once across process exit and repeated session close", async () => {
    const child = createOmpChild();
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const cleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    const session = await startOmpRpcSession({
      launch: { cwd: tmpdir(), argv: [process.execPath] },
      logger: pino({ level: "silent" }),
      spawnProcess: () => child,
      cleanup,
    });
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await cleanupStarted.promise;
    expect(closed).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    releaseCleanup.resolve();
    await closing;
    await session.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("negotiates RPC protocol v2 when OMP advertises it", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        return { protocolVersion: command.protocolVersion };
      }
      if (command.type === "get_available_models") {
        return {
          models: [{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        };
      }
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({ provider: "opencode-go", id: "deepseek-v4-flash" }),
    ]);
    expect(commands.map(withoutRequestId)).toContainEqual({
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
  });

  test("stays on protocol v1 when OMP advertises incompatible framing limits", async () => {
    const child = createOmpChild({
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 512 * 1024,
    });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return { models: [] };
    });

    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    await session.getAvailableModels();

    expect(commands.map(withoutRequestId)).toEqual([{ type: "get_available_models" }]);
    await session.close();
  });

  test("rejects startup when OMP exits before advertising readiness", async () => {
    const child = createOmpChild({ emitReady: false });
    const launches: OmpRuntimeLaunch[] = [];
    const startup = createRuntime(child, launches).startSession({ cwd: "/workspace/project" });
    const rejection = expect(startup).rejects.toThrow("startup exploded");
    await vi.waitUntil(() => launches.length === 1);

    child.stderr.write("startup exploded");
    finishOmpChild(child, 7);

    await rejection;
  });

  test("allows cold startup for 30 seconds and reports an actionable timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = createOmpChild({ emitReady: false });
      const startup = createRuntime(child).startSession({ cwd: "/workspace/project" });
      const rejection = expect(startup).rejects.toThrow(
        "OMP did not become ready within 30 seconds. Retry the operation; if it keeps failing, restart OMP.",
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(child.killedSignals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(child.killedSignals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects startup when OMP exits during protocol negotiation", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    child.stdin.on("data", () => {
      child.stderr.write("negotiation exploded");
      finishOmpChild(child, 8);
    });

    await expect(createRuntime(child).startSession({ cwd: "/workspace/project" })).rejects.toThrow(
      "negotiation exploded",
    );
  });

  test("reassembles chunked protocol v2 responses for large payloads", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const models = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "p",
      id: `model-${index}`,
      name: `model-${index}-${"x".repeat(512)}`,
    }));
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "negotiate_protocol") {
          child.stdout.write(
            `${JSON.stringify({
              id: command.id,
              type: "response",
              command: command.type,
              success: true,
              data: { protocolVersion: 2 },
            })}\n`,
          );
          continue;
        }
        if (command.type === "get_available_models") {
          // Emit a logical response larger than the 1 MiB protocol-v1 cap as a
          // chunked (protocol v2) frame sequence, like real OMP does.
          const logical = JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: { models },
          });
          const bytes = Buffer.from(logical, "utf8");
          expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
          const chunkPayload = 256 * 1024;
          const count = Math.ceil(bytes.length / chunkPayload);
          for (let index = 0; index < count; index++) {
            child.stdout.write(
              `${JSON.stringify({
                type: "rpc_chunk",
                chunkId: "c1",
                index,
                count,
                byteLength: bytes.length,
                data: bytes
                  .subarray(index * chunkPayload, (index + 1) * chunkPayload)
                  .toString("base64"),
              })}\n`,
            );
          }
        }
      }
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const result = await session.getAvailableModels();
    expect(result).toHaveLength(2_000);
    expect(result[0]).toEqual(expect.objectContaining({ id: "model-0" }));
  });
});
