import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { mergeOmpDesktopRpcBootstrapIntoModelsYaml } from "./agent.js";
import { startOmpLocalModelGateway, type OmpLocalModelGatewaySource } from "./local-model-gateway.js";
import { OmpSdkRuntime } from "./sdk-runtime.js";
import { ompHistoryRuntimeSettings } from "./test-utils/history-sdk.js";

let root: string | undefined;
let gateway: OmpLocalModelGatewaySource | undefined;
let upstream: http.Server | undefined;

async function openPluginGateway(
  enabled: boolean,
  lateDiscovery = false,
): Promise<OmpLocalModelGatewaySource> {
  root = await fs.mkdtemp(path.join(tmpdir(), "omp-gateway-plugin-"));
  const plugin = path.join(root, ".omp", "plugins", "node_modules", "gateway-fixture");
  await fs.mkdir(plugin, { recursive: true });
  const discovery = Promise.withResolvers<void>();
  const fixtureModel = {
    id: "plugin-model",
    name: "Local plugin model",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  upstream = http.createServer(async (request, response) => {
    if (request.url === "/models") {
      await discovery.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([fixtureModel]));
      return;
    }
    for await (const _chunk of request) {
      // Consume the real provider request before returning its streamed answer.
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        {
          id: "fixture-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "plugin-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "From the local plugin" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "fixture-response",
          object: "chat.completion.chunk",
          created: 1,
          model: "plugin-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("") + "data: [DONE]\n\n",
    );
  });
  const listening = once(upstream, "listening");
  upstream.listen(0, "127.0.0.1");
  await listening;
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "gateway-fixture",
      version: "1.0.0",
      omp: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(plugin, "index.mjs"),
    `export default function (pi) {
      pi.registerProvider("gateway-fixture", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:${address.port}/v1",
        apiKey: "fixture-key",
        ${
          lateDiscovery
            ? `fetchDynamicModels: async () => (await fetch("http://127.0.0.1:${address.port}/models")).json()`
            : `models: ${JSON.stringify([fixtureModel])}`
        }
      });
    }`,
  );
  await fs.writeFile(
    path.join(root, ".omp", "plugins", "omp-plugins.lock.json"),
    JSON.stringify({
      plugins: { "gateway-fixture": { version: "1.0.0", enabled, enabledFeatures: null } },
      settings: {},
    }),
  );
  const agentDir = path.join(root, ".omp", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "models.yml"),
    mergeOmpDesktopRpcBootstrapIntoModelsYaml(""),
  );
  const runtime = new OmpSdkRuntime({
    logger: pino({ level: "silent" }),
    runtimeSettings: {
      ...ompHistoryRuntimeSettings,
      env: {
        HOME: root,
        USERPROFILE: root,
        PI_CONFIG_DIR: ".omp",
        PI_CODING_AGENT_DIR: agentDir,
        OMP_PROFILE: "",
        PI_PROFILE: "",
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
    },
  });
  gateway = await startOmpLocalModelGateway(async (input) => {
    const session = await runtime.startSession({ ...input, cwd: root! });
    if (lateDiscovery) {
      await session.getLocalModelGatewayPort!();
      discovery.resolve();
    }
    return session;
  });
  return gateway;
}

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  if (upstream) {
    upstream.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    upstream.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    upstream = undefined;
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

test.each([
  { registration: "static", lateDiscovery: false },
  { registration: "discovered after gateway startup", lateDiscovery: true },
])("advertises and streams $registration local provider models", async ({ lateDiscovery }) => {
  const source = await openPluginGateway(true, lateDiscovery);
  expect(source.models).toContainEqual(
    expect.objectContaining({ provider: "gateway-fixture", id: "plugin-model" }),
  );
  const catalogUrl = `${source.launchConfig.baseUrl}/models`;
  expect((await fetch(catalogUrl)).status).toBe(403);
  const catalogHeaders = { authorization: `Bearer ${source.launchConfig.token}` };
  expect((await fetch(catalogUrl, { headers: { ...catalogHeaders, origin: "http://localhost" } })).status).toBe(403);
  const catalog = await fetch(catalogUrl, { headers: catalogHeaders });
  expect(await catalog.json()).toEqual(source.models);
  expect(catalog.headers.get("cache-control")).toBe("no-store");
  const response = await source.request(
    {
      modelId: "gateway-fixture/plugin-model",
      context: {
        messages: [{ role: "user", content: "Reply from the configured provider", timestamp: 1 }],
      },
      stream: true,
    },
    AbortSignal.timeout(15_000),
  );
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
  expect(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe("From the local plugin");
  expect(events.find((event) => event.type === "done")?.message.stopReason).toBe("stop");
});

test("does not advertise disabled local provider plugins", async () => {
  const source = await openPluginGateway(false);
  expect(source.models.some((model) => model.provider === "gateway-fixture")).toBe(false);
  await expect(
    source.request({
      modelId: "gateway-fixture/plugin-model",
      context: { messages: [] },
      stream: true,
    }),
  ).rejects.toThrow("Local model is unavailable");
});
