import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
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
} from "./cli-runtime.js";
import type { OmpRuntimeLaunch } from "./runtime.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import * as bundledPlugins from "../../../bundled-omp-plugins.js";
import { subscribeBundledOmpInitialization } from "../../../bundled-omp-initialization.js";

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
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
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

describe("OMP CLI runtime", () => {
  test("chat initialization ends after provisioning, before RPC spawn", async () => {
    const phases: Array<string | null> = [];
    const unsubscribe = subscribeBundledOmpInitialization("runtime-progress-agent", (phase) =>
      phases.push(phase),
    );
    const seed = vi
      .spyOn(bundledPlugins, "provisionBundledOmpPlugins")
      .mockImplementation(async (input) => {
        input?.onProgress?.("verifying");
        await Promise.resolve();
        input?.onProgress?.("installing");
        return { plugins: [] };
      });
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess: () => {
        expect(phases).toEqual(["verifying", "installing", null]);
        const replay: Array<string | null> = [];
        const unsubscribeReplay = subscribeBundledOmpInitialization(
          "runtime-progress-agent",
          (phase) => replay.push(phase),
        );
        expect(replay).toEqual([]);
        unsubscribeReplay();
        return createOmpChild();
      },
    });
    try {
      const session = await runtime.startSession({
        cwd: "/workspace",
        env: { PASEO_AGENT_ID: "runtime-progress-agent" },
      });
      await session.close();
      expect(phases).toEqual(["verifying", "installing", null]);
    } finally {
      seed.mockRestore();
      unsubscribe();
    }
  });

  test("provisioning failure closes chat progress without spawning", async () => {
    const phases: Array<string | null> = [];
    const unsubscribe = subscribeBundledOmpInitialization("runtime-failed-agent", (phase) =>
      phases.push(phase),
    );
    const seed = vi
      .spyOn(bundledPlugins, "provisionBundledOmpPlugins")
      .mockImplementation(async (input) => {
        input?.onProgress?.("verifying");
        throw new Error("payload changed");
      });
    const spawnProcess = vi.fn(() => createOmpChild());
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess,
    });
    try {
      await expect(
        runtime.startSession({
          cwd: "/workspace",
          env: { PASEO_AGENT_ID: "runtime-failed-agent" },
        }),
      ).rejects.toThrow("payload changed");
      expect(phases).toEqual(["verifying", null]);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      seed.mockRestore();
      unsubscribe();
    }
  });

  test("ambient agent identity does not attribute management launches to chat", async () => {
    const previousAgentId = process.env.PASEO_AGENT_ID;
    process.env.PASEO_AGENT_ID = "ambient-agent";
    const phases: Array<string | null> = [];
    const unsubscribe = subscribeBundledOmpInitialization("ambient-agent", (phase) =>
      phases.push(phase),
    );
    const seed = vi
      .spyOn(bundledPlugins, "provisionBundledOmpPlugins")
      .mockImplementation(async (input) => {
        expect(input?.onProgress).toBeUndefined();
        return { plugins: [] };
      });
    try {
      const runtime = createRuntime(createOmpChild());
      const session = await runtime.startSession({ cwd: "/workspace" });
      await session.close();
      expect(phases).toEqual([]);
    } finally {
      seed.mockRestore();
      unsubscribe();
      if (previousAgentId === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = previousAgentId;
    }
  });

  test("provisions each launch with its actual provider prefix, cwd and session env before spawning", async () => {
    const seed = vi
      .spyOn(bundledPlugins, "provisionBundledOmpPlugins")
      .mockResolvedValue({ plugins: [] });
    const events: string[] = [];
    seed.mockImplementation(async () => {
      events.push("seed");
      return { plugins: [] };
    });
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      runtimeSettings: {
        command: { mode: "append", args: ["--profile", "work"] },
        env: { OMP_PROFILE: "provider" },
      },
      spawnProcess: () => {
        events.push("spawn");
        return createOmpChild();
      },
    });
    try {
      for (const cwd of ["/workspace/first", "/workspace/second"]) {
        const session = await runtime.startSession({
          cwd,
          env: { OMP_PROFILE: "session" },
          extraArgs: ["--approval-mode", "yolo"],
        });
        await session.close();
      }
      expect(
        seed.mock.calls.map(([input]) => ({
          command: input?.command,
          cwd: input?.cwd,
          profile: input?.env?.OMP_PROFILE,
        })),
      ).toEqual([
        { command: ["omp", "--profile", "work"], cwd: "/workspace/first", profile: "session" },
        { command: ["omp", "--profile", "work"], cwd: "/workspace/second", profile: "session" },
      ]);
      expect(events).toEqual(["seed", "spawn", "seed", "spawn"]);
    } finally {
      seed.mockRestore();
    }
  });

  test("never spawns a provider when authoritative provisioning fails", async () => {
    const seed = vi
      .spyOn(bundledPlugins, "provisionBundledOmpPlugins")
      .mockRejectedValue(new Error("incompatible private host"));
    const spawnProcess = vi.fn(() => createOmpChild());
    const runtime = new OmpCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      spawnProcess,
    });
    try {
      await expect(runtime.startSession({ cwd: "/workspace/project" })).rejects.toThrow(
        "incompatible private host",
      );
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      seed.mockRestore();
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

  test("loads a private tier extension and reads native Ultra without losing model metadata", async () => {
    const child = createOmpChild();
    const launches: OmpRuntimeLaunch[] = [];
    const model = {
      provider: "openai-codex",
      id: "gpt-6.1-sol",
      api: "openai-codex-responses",
      serviceTiers: ["priority", "ultrafast"],
      nativeExtra: { retained: true },
    };
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

  test("does not arm the short control-plane timeout for LLM-backed compaction", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({}));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await expect(session.compact()).resolves.toBeUndefined();
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
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
    child.emit("exit", 7, null);

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
      child.emit("exit", 8, null);
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
