import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import { mergeOmpDesktopRpcBootstrapIntoModelsYaml } from "./agent.js";
import type { OmpRuntimeSession } from "./runtime.js";
import { OmpSdkRuntime } from "./sdk-runtime.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

const selected = { provider: "sandbox-provider-fixture", id: "custom/model@cn" };
let root: string | undefined;
let workspace: string | undefined;
let captureServer: Server | undefined;
const sessions: OmpRuntimeSession[] = [];
const captures: Array<{ model: typeof selected; context: { systemPrompt?: string | string[]; tools?: Array<{ name: string }> }; options: Record<string, unknown> }> = [];
const sources: Array<{ session: OmpRuntimeSession; port: number; cwd: string; close: MockInstance<OmpRuntimeSession["close"]> }> = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(sources.splice(0).map(source => source.session.close()));
  if (captureServer) {
    captureServer.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    captureServer.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    captureServer = undefined;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
  workspace = undefined;
  captures.splice(0);
  vi.restoreAllMocks();
});

async function fixture(enabled = true): Promise<OmpSdkRuntime> {
  root = await fs.mkdtemp(path.join(tmpdir(), "omp-sandbox-provider-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const plugin = path.join(root, ".omp", "plugins", "node_modules", "sandbox-provider-fixture");
  const agentDir = path.join(root, ".omp", "agent");
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "models.yml"), mergeOmpDesktopRpcBootstrapIntoModelsYaml(""));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "AMBIENT_PROVIDER_CONTEXT");
  captureServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captures.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.end("captured");
  });
  const listening = once(captureServer, "listening");
  captureServer.listen(0, "127.0.0.1");
  await listening;
  const address = captureServer.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture capture listener");
  await fs.writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "sandbox-provider-fixture", version: "1.0.0", omp: { extensions: ["./index.mjs"] } }));
  await fs.writeFile(path.join(plugin, "index.mjs"), `export default function (pi) {
    pi.registerTool({ name: "ambient_provider_tool", description: "AMBIENT_PROVIDER_TOOL", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
    pi.on("before_agent_start", () => ({ systemPrompt: "AMBIENT_PROVIDER_PROMPT" }));
    pi.registerProvider("${selected.provider}", {
      api: "sandbox-fixture-custom-api", apiKey: "fixture-only-key", baseUrl: "http://127.0.0.1:${address.port}",
      models: [{ id: "${selected.id}", name: "Custom fixture", api: "sandbox-fixture-custom-api", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context, options) {
        const result = (async () => {
          await fetch("http://127.0.0.1:${address.port}/capture", { method: "POST", body: JSON.stringify({ model: { provider: model.provider, id: model.id }, context, options: { reasoning: options?.reasoning, sessionId: options?.sessionId } }), signal: options?.signal });
          return { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{ type: "text", text: "CUSTOM_PROVIDER_REPLY" }], stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        })();
        return { result: () => result, async *[Symbol.asyncIterator]() {
          const message = await result;
          yield { type: "start", partial: { ...message, content: [] } };
          yield { type: "text_start", contentIndex: 0, partial: message };
          yield { type: "text_delta", contentIndex: 0, delta: "CUSTOM_PROVIDER_REPLY", partial: message };
          yield { type: "text_end", contentIndex: 0, content: "CUSTOM_PROVIDER_REPLY", partial: message };
          yield { type: "done", reason: "stop", message };
        } };
      }
    });
  }`);
  await fs.writeFile(path.join(root, ".omp", "plugins", "omp-plugins.lock.json"), JSON.stringify({ plugins: { "sandbox-provider-fixture": { version: "1.0.0", enabled, enabledFeatures: null } }, settings: {} }));
  const runtime = new OmpSdkRuntime({
    logger: pino({ level: "silent" }),
    runtimeSettings: { ...ompHistoryRuntimeSettings, env: { HOME: root, USERPROFILE: root, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "", XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache") } },
  });
  const startSession = runtime.startSession.bind(runtime);
  vi.spyOn(runtime, "startSession").mockImplementation(async input => {
    const session = await startSession(input);
    if (input.localModelGateway) sources.push({ session, port: await session.getLocalModelGatewayPort!(), cwd: input.cwd, close: vi.spyOn(session, "close") });
    else sessions.push(session);
    return session;
  });
  return runtime;
}

async function prompt(session: OmpRuntimeSession, text: string): Promise<void> {
  const ended = Promise.withResolvers<void>();
  const unsubscribe = session.onEvent(event => { if (event.type === "agent_end") ended.resolve(); });
  try {
    await session.prompt(text);
    await ended.promise;
  } finally { unsubscribe(); }
  expect(JSON.stringify(await session.getMessages())).toContain("CUSTOM_PROVIDER_REPLY");
}

test("preserves custom provider selection, sandbox capabilities, resume and source lifetime", async () => {
  const runtime = await fixture();
  const input = { cwd: workspace!, sandbox: { root: workspace! }, model: `${selected.provider}/${selected.id}`, systemPrompt: "TRUSTED_PROVIDER_PROMPT", extraArgs: ["--tools", "bash,eval,task", "--append-system-prompt", "UNSAFE_PROVIDER_APPEND"] };
  const session = await runtime.startSession(input);
  expect(sources[0]!.cwd).toBe(root);
  const state = await session.getState();
  expect(state.model).toMatchObject(selected);
  expect(Array.isArray(state.dumpTools) ? state.dumpTools.map(tool => tool.name).sort() : undefined).toEqual(["sandbox_list", "sandbox_read", "sandbox_write"]);
  expect(await session.getCommands()).toEqual([]);
  await expect(session.setHostTools([{ name: "host_escape", description: "Forbidden", parameters: { type: "object", properties: {} } }])).rejects.toThrow(/sandbox/i);
  expect(await session.setModel(selected.provider, selected.id)).toMatchObject(selected);
  await expect(session.setModel(selected.provider, "missing")).rejects.toThrow();
  await prompt(session, "first fixture prompt");
  await prompt(session, "second fixture prompt");
  expect(sources).toHaveLength(1);
  expect(captures).toHaveLength(2);
  for (const capture of captures) {
    expect(capture.model).toEqual(selected);
    expect(capture.context.tools?.map(tool => tool.name).sort()).toEqual(["sandbox_list", "sandbox_read", "sandbox_write"]);
    const serialized = JSON.stringify(capture.context);
    expect(serialized).toContain("TRUSTED_PROVIDER_PROMPT");
    for (const sentinel of ["AMBIENT_PROVIDER_CONTEXT", "AMBIENT_PROVIDER_TOOL", "AMBIENT_PROVIDER_PROMPT", "UNSAFE_PROVIDER_APPEND", root!]) expect(serialized).not.toContain(sentinel);
  }
  if (!state.sessionFile) throw new Error("Fixture sandbox must persist a session");
  expect(await fs.readFile(state.sessionFile, "utf8")).not.toContain("desktop-local");
  await session.close();
  expect(sources[0]!.close).toHaveBeenCalledTimes(1);
  await expect(fetch(`http://127.0.0.1:${sources[0]!.port}/v1/pi/stream`)).rejects.toThrow();
  const resumed = await runtime.startSession({ ...input, model: undefined, session: state.sessionFile });
  expect((await resumed.getState()).model).toMatchObject(selected);
  expect((await resumed.getState()).sessionId).toBe(state.sessionId);
  await prompt(resumed, "resumed fixture prompt");
  expect(sources).toHaveLength(2);
});

test.each([false, true])("fails explicitly and closes its source for unavailable provider selection (enabled=%s)", async enabled => {
  const runtime = await fixture(enabled);
  await expect(runtime.startSession({ cwd: workspace!, sandbox: { root: workspace! }, model: enabled ? `${selected.provider}/missing` : `${selected.provider}/${selected.id}` })).rejects.toThrow("Sandbox model is unavailable");
  expect(sources).toHaveLength(1);
  expect(sources[0]!.close).toHaveBeenCalledTimes(1);
  expect(captures).toEqual([]);
  await expect(fetch(`http://127.0.0.1:${sources[0]!.port}/v1/pi/stream`)).rejects.toThrow();
});

test("startup failure closes the provider endpoint before rejecting the sandbox session", async () => {
  const runtime = await fixture();
  await expect(runtime.startSession({ cwd: workspace!, sandbox: { root: path.join(root!, "missing-sandbox") }, model: `${selected.provider}/${selected.id}` })).rejects.toThrow();
  expect(sources).toHaveLength(1);
  expect(sources[0]!.close).toHaveBeenCalledTimes(1);
  expect(captures).toEqual([]);
  await expect(fetch(`http://127.0.0.1:${sources[0]!.port}/v1/pi/stream`)).rejects.toThrow();
});

test("caller cancellation closes the owned provider source", async () => {
  const runtime = await fixture();
  const controller = new AbortController();
  await runtime.startSession({ cwd: workspace!, sandbox: { root: workspace! }, model: `${selected.provider}/${selected.id}`, signal: controller.signal });
  controller.abort(new Error("fixture cancellation"));
  expect(sources[0]!.close).toHaveBeenCalledTimes(1);
  await sources[0]!.close.mock.results[0]!.value;
  await expect(fetch(`http://127.0.0.1:${sources[0]!.port}/v1/pi/stream`)).rejects.toThrow();
  expect(captures).toEqual([]);
});
