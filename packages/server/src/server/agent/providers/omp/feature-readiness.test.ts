import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmpAgentClient } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import type { AgentFeature, AgentSessionConfig } from "../../agent-sdk-types.js";
import type { OmpStartSessionInput } from "./runtime.js";
import * as featureContext from "./feature-context.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6.1-sol",
  name: "GPT 6.1 Sol",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 500000,
  maxTokens: 128000,
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  serviceTiers: ["priority", "ultrafast"],
};
const priorityModel = { ...model, serviceTiers: ["priority"] };
const modelPayload = JSON.stringify([model]);
const priorityPayload = JSON.stringify([priorityModel]);
const customModel = {
  ...model,
  provider: "custom-provider",
  baseUrl: "https://custom-provider.test/v1",
  identity: { class: "openai" },
};
let directory: string;
let binary: string;
let clients: OmpAgentClient[];

beforeEach(async () => {
  vi.stubEnv("OMP_PROFILE", "default");
  directory = await mkdtemp(join(tmpdir(), "omp-feature-readiness-"));
  binary = join(directory, "runtime.exe");
  await writeFile(binary, "runtime installation A", { mode: 0o755 });
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.shutdown()));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function setup(runtime = new FakeOmp(), commandArgs: string[] = []) {
  runtime.setInitialModel(model);
  runtime.setUltrafastSupported(true);
  const client = new OmpAgentClient({
    logger: pino({ level: "silent" }),
    runtime,
    runtimeSettings: {
      ompBackend: "cli",
      command: { mode: "replace", argv: [binary, ...commandArgs] },
      env: {
        PI_CODING_AGENT_DIR: join(directory, "profile"),
        PI_CONFIG_DIR: relative(homedir(), join(directory, "config")),
      },
    },
  });
  clients.push(client);
  const config: AgentSessionConfig = {
    provider: "omp",
    cwd: directory,
    model: "openai-codex/gpt-6.1-sol",
    featureValues: { fast_mode: "ultrafast" },
  };
  return { client, runtime, config };
}
function speed(features: AgentFeature[]) {
  return features.find((feature) => feature.id === "fast_mode");
}

async function createModelCache(populated = false, withHash = false) {
  await mkdir(join(directory, "profile"), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
  };
  const database = new DatabaseSync(join(directory, "profile", "models.db"));
  database.exec(
    `CREATE TABLE model_cache(provider_id TEXT PRIMARY KEY, updated_at INTEGER, models TEXT${withHash ? ", models_hash TEXT NOT NULL DEFAULT ''" : ""})`,
  );
  if (populated)
    database.exec(
      `INSERT INTO model_cache(provider_id, updated_at, models) VALUES('openai-codex:0.159.0', 1, '${modelPayload}')`,
    );
  return database;
}

async function expectRetiredProbes(runtime: FakeOmp, sessions = [runtime.latestSession()]) {
  for (const session of sessions) {
    expect(session.closed).toBe(true);
    expect(session.prompts).toEqual([]);
    expect(session.setModelRequests).toEqual([]);
    expect(session.setFastModeRequests).toEqual([]);
    expect(session.setFastModeTierRequests).toEqual([]);
  }
  for (const launch of runtime.recordedLaunches) {
    const args = launch.argv;
    await expect(access(args[args.indexOf("--config") + 1]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
}

describe("draft native feature readiness", () => {
  it("coalesces concurrent consumers, retires the process and reuses definitions, not selected values", async () => {
    const { client, runtime, config } = setup();
    const [first, second] = await Promise.all([
      client.listFeatures(config),
      client.listFeatures(config),
    ]);
    expect(speed(first)).toMatchObject({ type: "select", value: "ultrafast" });
    expect(speed(second)).toMatchObject({ type: "select", value: "ultrafast" });
    expect(runtime.recordedLaunches).toHaveLength(1);
    expect(runtime.latestSession().closed).toBe(true);
    const standard = await client.listFeatures({ ...config, featureValues: { fast_mode: "off" } });
    expect(speed(standard)).toMatchObject({ type: "select", value: "off" });
    expect(runtime.recordedLaunches).toHaveLength(1);
    expect(runtime.latestSession().prompts).toEqual([]);
    expect(runtime.latestSession().setFastModeTierRequests).toEqual([]);
  });

  it("reconfirms model, selected account, effective configuration and runtime installation changes", async () => {
    const { client, runtime, config } = setup();
    await client.listFeatures(config);
    await client.listFeatures({ ...config, featureValues: { oauth_account_credential: "42" } });
    expect(runtime.recordedLaunches).toHaveLength(2);
    const nextModel = { ...model, id: "gpt-next" };
    runtime.setInitialModel(nextModel);
    const nextConfig = { ...config, model: "openai-codex/gpt-next" };
    await client.listFeatures(nextConfig);
    expect(runtime.recordedLaunches).toHaveLength(3);
    await mkdir(join(directory, ".omp"));
    await writeFile(join(directory, ".omp", "config.yml"), "model: changed\n");
    await client.listFeatures(nextConfig);
    expect(runtime.recordedLaunches).toHaveLength(4);
    await writeFile(binary, "runtime installation changed to B");
    await client.listFeatures(nextConfig);
    expect(runtime.recordedLaunches).toHaveLength(5);
    expect(runtime.latestSession().closed).toBe(true);
    vi.stubEnv("OMP_PROFILE", "another-profile");
    await client.listFeatures(nextConfig);
    expect(runtime.recordedLaunches).toHaveLength(6);
  });

  it("reconfirms native evidence when credential records change, without polling automatic account display", async () => {
    const { client, runtime, config } = setup();
    await client.listFeatures(config);
    await mkdir(join(directory, "profile"));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
    };
    const database = new DatabaseSync(join(directory, "profile", "agent.db"));
    try {
      database.exec(
        "CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, data TEXT)",
      );
      database.exec(
        "INSERT INTO auth_credentials VALUES(41, 'openai-codex', 'initial credential')",
      );
      await client.listFeatures(config);
      expect(runtime.recordedLaunches).toHaveLength(2);
      database.exec("UPDATE auth_credentials SET data = 'refreshed credential' WHERE id = 41");
      await client.listFeatures(config);
      expect(runtime.recordedLaunches).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it.each([false, true])(
    "accepts first startup creating empty credential/model databases (table=%s)",
    async (withTable) => {
      class InitializingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          await mkdir(join(directory, "profile"), { recursive: true });
          const require = createRequire(import.meta.url);
          const { DatabaseSync } = require("node:sqlite") as {
            DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
          };
          const database = new DatabaseSync(join(directory, "profile", "agent.db"));
          if (withTable)
            database.exec(
              "CREATE TABLE IF NOT EXISTS auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, data TEXT)",
            );
          database.close();
          const models = new DatabaseSync(join(directory, "profile", "models.db"));
          if (withTable)
            models.exec(
              "CREATE TABLE IF NOT EXISTS model_cache(provider_id TEXT PRIMARY KEY, models TEXT)",
            );
          models.close();
          return super.startSession(input);
        }
      }
      const { client, runtime, config } = setup(new InitializingRuntime());
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      expect(runtime.recordedLaunches).toHaveLength(1);
    },
  );

  it.each(["missing", "legacy", "hashed"])(
    "accepts first selected-provider cache materialization and shares consumers across it (schema=%s)",
    async (schema) => {
      if (schema !== "missing") (await createModelCache(false, schema === "hashed")).close();
      const materialized = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      class MaterializingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          await mkdir(join(directory, "profile"), { recursive: true });
          const require = createRequire(import.meta.url);
          const { DatabaseSync } = require("node:sqlite") as {
            DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
          };
          const database = new DatabaseSync(join(directory, "profile", "models.db"));
          try {
            database.exec(
              "CREATE TABLE IF NOT EXISTS model_cache(provider_id TEXT PRIMARY KEY, updated_at INTEGER, models TEXT)",
            );
            database.exec(
              `INSERT OR REPLACE INTO model_cache(provider_id, updated_at, models) VALUES('openai-codex:0.159.0', 1, '${JSON.stringify([{ ...priorityModel, id: "another-model" }, model])}')`,
            );
            if (schema === "hashed")
              database.exec("UPDATE model_cache SET models_hash = 'materialized-models'");
          } finally {
            database.close();
          }
          materialized.resolve();
          await released.promise;
          return session;
        }
      }
      const { client, runtime, config } = setup(new MaterializingRuntime());
      const first = client.listFeatures(config);
      const concurrent = client.listFeatures({ ...config, featureValues: { fast_mode: "off" } });
      await materialized.promise;
      const observed = Promise.withResolvers<void>();
      const fingerprint = featureContext.fingerprintOmpFeatureContext;
      const observation = vi
        .spyOn(featureContext, "fingerprintOmpFeatureContext")
        .mockImplementation(async (input) => {
          const context = await fingerprint(input);
          observed.resolve();
          return context;
        });
      const afterMaterialization = client.listFeatures(config);
      try {
        await observed.promise;
      } finally {
        observation.mockRestore();
        released.resolve();
      }
      const results = await Promise.all([first, concurrent, afterMaterialization]);
      expect(results.map((features) => speed(features)?.value)).toEqual([
        "ultrafast",
        "off",
        "ultrafast",
      ]);
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      expect(runtime.recordedLaunches).toHaveLength(1);
      expect(runtime.latestSession().closed).toBe(true);
      expect(runtime.latestSession().setModelRequests).toEqual([]);
      expect(runtime.latestSession().prompts).toEqual([]);
      const args = runtime.recordedLaunches[0]!.argv;
      await expect(access(args[args.indexOf("--config") + 1]!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([false, true])(
    "rejects stale first materialization for every consumer and reconfirms an adopted declaration on retry (hash=%s)",
    async (withHash) => {
      const database = await createModelCache(false, withHash);
      const materialized = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      class MaterializingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache(provider_id, updated_at, models) VALUES('openai-codex:0.159.0', 1, '${modelPayload}')`,
          );
          if (withHash) database.exec("UPDATE model_cache SET models_hash = 'materialized-models'");
          if (this.recordedLaunches.length === 1) {
            materialized.resolve();
            await released.promise;
          }
          return session;
        }
      }
      const { client, runtime, config } = setup(new MaterializingRuntime());
      runtime.setInitialModel(priorityModel);
      const first = client.listFeatures(config).catch((error: unknown) => error);
      const concurrent = client
        .listFeatures({ ...config, featureValues: { fast_mode: "off" } })
        .catch((error: unknown) => error);
      try {
        await materialized.promise;
        const observed = Promise.withResolvers<void>();
        const fingerprint = featureContext.fingerprintOmpFeatureContext;
        const observation = vi
          .spyOn(featureContext, "fingerprintOmpFeatureContext")
          .mockImplementation(async (input) => {
            const context = await fingerprint(input);
            observed.resolve();
            return context;
          });
        const late = client.listFeatures(config).catch((error: unknown) => error);
        try {
          await observed.promise;
        } finally {
          observation.mockRestore();
          released.resolve();
        }
        const results = await Promise.all([first, concurrent, late]);
        for (const result of results) {
          expect(result).toMatchObject({
            message: "OMP capability model declaration does not match native state; retry",
          });
        }
        expect(runtime.recordedLaunches).toHaveLength(1);
        const sessions = [runtime.latestSession()];
        // Keeping the same stale native model must launch and reject again,
        // not return a warmed false result under the new declaration's key.
        await expect(client.listFeatures(config)).rejects.toThrow("does not match native state");
        expect(runtime.recordedLaunches).toHaveLength(2);
        sessions.push(runtime.latestSession());
        runtime.setInitialModel(model);
        expect(speed(await client.listFeatures(config))).toMatchObject({
          type: "select",
          value: "ultrafast",
        });
        expect(runtime.recordedLaunches).toHaveLength(3);
        sessions.push(runtime.latestSession());
        expect(
          speed(await client.listFeatures({ ...config, featureValues: { fast_mode: "off" } })),
        ).toMatchObject({ type: "select", value: "off" });
        expect(runtime.recordedLaunches).toHaveLength(3);
        for (const session of sessions) {
          expect(session.closed).toBe(true);
          expect(session.prompts).toEqual([]);
          expect(session.setModelRequests).toEqual([]);
          expect(session.setFastModeRequests).toEqual([]);
          expect(session.setFastModeTierRequests).toEqual([]);
        }
        for (const launch of runtime.recordedLaunches) {
          const args = launch.argv;
          await expect(access(args[args.indexOf("--config") + 1]!)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        released.resolve();
        database.close();
      }
    },
  );

  it.each([
    {
      name: "another model",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ ...model, id: "another-model" }],
    },
    {
      name: "another provider",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ ...model, provider: "another-provider" }],
    },
    {
      name: "different API",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ ...model, api: "openai-responses" }],
    },
    {
      name: "different endpoint",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ ...model, baseUrl: "https://another-endpoint.test" }],
    },
    { name: "duplicate model", namespaces: ["openai-codex:0.159.0"], declarations: [model, model] },
    {
      name: "missing identity",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ serviceTiers: model.serviceTiers }],
    },
    {
      name: "duplicate tiers",
      namespaces: ["openai-codex:0.159.0"],
      declarations: [{ ...model, serviceTiers: ["priority", "priority"] }],
    },
  ])(
    "refuses $name evidence instead of borrowing a declaration for the native model",
    async ({ namespaces, declarations }) => {
      const database = await createModelCache();
      let populate = true;
      class MaterializingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          if (populate) {
            populate = false;
            for (const namespace of namespaces) {
              database.exec(
                `INSERT INTO model_cache VALUES('${namespace}', 1, '${JSON.stringify(declarations)}')`,
              );
            }
          }
          return session;
        }
      }
      const { client, runtime, config } = setup(new MaterializingRuntime());
      try {
        await expect(client.listFeatures(config)).rejects.toThrow("does not match native state");
        const rejected = runtime.latestSession();
        expect(rejected.closed).toBe(true);
        expect(rejected.prompts).toEqual([]);
        expect(rejected.setModelRequests).toEqual([]);
        const args = runtime.recordedLaunches[0]!.argv;
        await expect(access(args[args.indexOf("--config") + 1]!)).rejects.toMatchObject({
          code: "ENOENT",
        });
        database.exec("DELETE FROM model_cache");
        database.exec(
          `INSERT INTO model_cache VALUES('openai-codex:0.159.0', 2, '${modelPayload}')`,
        );
        expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
        expect(runtime.recordedLaunches).toHaveLength(2);
        expect(runtime.latestSession().closed).toBe(true);
      } finally {
        database.close();
      }
    },
  );

  it.each(["opaque", "multiple"])(
    "reconfirms %s scopes through one owned native catalog for shared consumers",
    async (scope) => {
      const database = await createModelCache();
      const reading = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      class CatalogRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          const namespaces =
            scope === "multiple"
              ? ["custom-provider", "custom-provider:opaque-account"]
              : ["custom-provider:opaque-account"];
          for (const namespace of namespaces) {
            // Neither another account's payload nor its first model certifies this state.
            database.exec(
              `INSERT INTO model_cache VALUES('${namespace}', 1, '${JSON.stringify([{ ...customModel, id: "another-model", serviceTiers: ["priority"] }])}')`,
            );
          }
          const getModels = session.getAvailableModels.bind(session);
          session.getAvailableModels = async () => {
            reading.resolve();
            await released.promise;
            return getModels();
          };
          return session;
        }
      }
      const { client, runtime, config } = setup(new CatalogRuntime());
      config.model = `${customModel.provider}/${customModel.id}`;
      runtime.setInitialModel(customModel);
      runtime.queueModels([
        { ...customModel, provider: "another-provider" },
        { ...customModel, id: "another-model" },
        customModel,
      ]);
      const first = client.listFeatures(config);
      try {
        await reading.promise;
        const observed = Promise.withResolvers<void>();
        const fingerprint = featureContext.fingerprintOmpFeatureContext;
        const observation = vi
          .spyOn(featureContext, "fingerprintOmpFeatureContext")
          .mockImplementation(async (input) => {
            const context = await fingerprint(input);
            observed.resolve();
            return context;
          });
        const shared = client.listFeatures({ ...config, featureValues: { fast_mode: "off" } });
        try {
          await observed.promise;
        } finally {
          observation.mockRestore();
          released.resolve();
        }
        const [firstFeatures, sharedFeatures] = await Promise.all([first, shared]);
        expect(speed(firstFeatures)).toMatchObject({ type: "select", value: "ultrafast" });
        expect(speed(sharedFeatures)).toMatchObject({ type: "select", value: "off" });
        expect(speed(await client.listFeatures(config))).toMatchObject({
          type: "select",
          value: "ultrafast",
        });
        expect(runtime.recordedLaunches).toHaveLength(1);
        await expectRetiredProbes(runtime);
      } finally {
        released.resolve();
        database.close();
      }
    },
  );

  it.each(["tiers", "identity"])(
    "rejects an opaque native catalog's stale %s state without warming and reconfirms on retry",
    async (changed) => {
      const database = await createModelCache();
      const staleModel =
        changed === "tiers"
          ? { ...customModel, serviceTiers: ["priority"] }
          : { ...customModel, identity: "not-an-object" };
      class CatalogRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache VALUES('custom-provider:opaque-account', 1, '${JSON.stringify([staleModel])}')`,
          );
          return session;
        }
      }
      const { client, runtime, config } = setup(new CatalogRuntime());
      config.model = `${customModel.provider}/${customModel.id}`;
      runtime.setInitialModel(staleModel);
      runtime.queueModels([customModel]);
      try {
        const results = await Promise.all([
          client.listFeatures(config).catch((error: unknown) => error),
          client
            .listFeatures({ ...config, featureValues: { fast_mode: "off" } })
            .catch((error: unknown) => error),
        ]);
        for (const result of results) expect(result).toBeInstanceOf(Error);
        expect(runtime.recordedLaunches).toHaveLength(1);
        const sessions = [runtime.latestSession()];
        runtime.queueModels([customModel]);
        await expect(client.listFeatures(config)).rejects.toThrow();
        expect(runtime.recordedLaunches).toHaveLength(2);
        sessions.push(runtime.latestSession());
        runtime.setInitialModel(customModel);
        runtime.queueModels([customModel]);
        expect(speed(await client.listFeatures(config))).toMatchObject({
          type: "select",
          value: "ultrafast",
        });
        expect(runtime.recordedLaunches).toHaveLength(3);
        sessions.push(runtime.latestSession());
        expect(
          speed(await client.listFeatures({ ...config, featureValues: { fast_mode: "off" } })),
        ).toMatchObject({ type: "select", value: "off" });
        expect(runtime.recordedLaunches).toHaveLength(3);
        await expectRetiredProbes(runtime, sessions);
      } finally {
        database.close();
      }
    },
  );

  it.each([
    { name: "unavailable", catalog: null },
    { name: "empty", catalog: [] },
    { name: "another model", catalog: [{ ...customModel, id: "another-model" }] },
    { name: "another provider", catalog: [{ ...customModel, provider: "another-provider" }] },
    { name: "duplicate selected model", catalog: [customModel, customModel] },
  ])(
    "rejects an opaque scope's $name native catalog rather than borrowing its cache payload",
    async ({ catalog }) => {
      const database = await createModelCache();
      class CatalogRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache VALUES('custom-provider:opaque-account', 1, '${JSON.stringify([customModel])}')`,
          );
          if (catalog === null && this.recordedLaunches.length === 1) {
            session.getAvailableModels = async () => {
              throw new Error("Native catalog unavailable");
            };
          }
          return session;
        }
      }
      const { client, runtime, config } = setup(new CatalogRuntime());
      config.model = `${customModel.provider}/${customModel.id}`;
      runtime.setInitialModel(customModel);
      if (catalog) runtime.queueModels(catalog);
      try {
        await expect(client.listFeatures(config)).rejects.toThrow();
        const rejected = runtime.latestSession();
        runtime.queueModels([customModel]);
        expect(speed(await client.listFeatures(config))).toMatchObject({
          type: "select",
          value: "ultrafast",
        });
        expect(runtime.recordedLaunches).toHaveLength(2);
        await expectRetiredProbes(runtime, [rejected, runtime.latestSession()]);
      } finally {
        database.close();
      }
    },
  );

  it.each(["catalog", "retirement"])(
    "rejects context changes during opaque %s reconfirmation and retries without warm reuse",
    async (phase) => {
      const database = await createModelCache();
      let mutate = true;
      const change = () => {
        if (!mutate) return;
        mutate = false;
        database.exec(
          `UPDATE model_cache SET models = '${JSON.stringify([{ ...customModel, name: "Changed declaration" }])}'`,
        );
      };
      class CatalogRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache VALUES('custom-provider:opaque-account', 1, '${JSON.stringify([customModel])}')`,
          );
          const getModels = session.getAvailableModels.bind(session);
          session.getAvailableModels = async () => {
            const models = await getModels();
            if (phase === "catalog") change();
            return models;
          };
          const close = session.close.bind(session);
          session.close = async () => {
            await close();
            if (phase === "retirement") change();
          };
          return session;
        }
      }
      const { client, runtime, config } = setup(new CatalogRuntime());
      config.model = `${customModel.provider}/${customModel.id}`;
      runtime.setInitialModel(customModel);
      runtime.queueModels([customModel]);
      try {
        await expect(client.listFeatures(config)).rejects.toThrow();
        const rejected = runtime.latestSession();
        runtime.queueModels([customModel]);
        expect(speed(await client.listFeatures(config))).toMatchObject({
          type: "select",
          value: "ultrafast",
        });
        expect(runtime.recordedLaunches).toHaveLength(2);
        await expectRetiredProbes(runtime, [rejected, runtime.latestSession()]);
      } finally {
        database.close();
      }
    },
  );

  it.each(["model", "configuration", "credentials", "runtime"])(
    "rejects startup changes to existing %s evidence instead of warming an invalid result",
    async (changed) => {
      const database = await createModelCache(changed === "model");
      let mutate = true;
      class MutatingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          if (mutate) {
            mutate = false;
            database.exec(
              `INSERT OR REPLACE INTO model_cache VALUES('openai-codex:0.159.0', 2, '${priorityPayload}')`,
            );
            if (changed === "configuration") {
              await mkdir(join(directory, ".omp"));
              await writeFile(join(directory, ".omp", "config.yml"), "tier: off\n");
            } else if (changed === "credentials") {
              const require = createRequire(import.meta.url);
              const { DatabaseSync } = require("node:sqlite") as {
                DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
              };
              const credentials = new DatabaseSync(join(directory, "profile", "agent.db"));
              try {
                credentials.exec(
                  "CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY, provider TEXT, data TEXT)",
                );
                credentials.exec(
                  "INSERT INTO auth_credentials VALUES(41, 'openai-codex', 'changed credential')",
                );
              } finally {
                credentials.close();
              }
            } else if (changed === "runtime") {
              await writeFile(binary, "runtime installation changed during startup");
            }
          }
          return session;
        }
      }
      const { client, runtime, config } = setup(new MutatingRuntime());
      try {
        await expect(client.listFeatures(config)).rejects.toThrow("context changed");
        expect(runtime.latestSession().closed).toBe(true);
        runtime.setUltrafastSupported(false);
        runtime.setInitialModel(priorityModel);
        expect(speed(await client.listFeatures(config))).toBeUndefined();
        expect(runtime.recordedLaunches).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  );

  it("reconfirms committed model declaration changes in WAL but ignores uncommitted writes and freshness-only updates", async () => {
    const { client, runtime, config } = setup();
    await mkdir(join(directory, "profile"));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
    };
    const database = new DatabaseSync(join(directory, "profile", "models.db"));
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec(
        "CREATE TABLE model_cache(provider_id TEXT PRIMARY KEY, updated_at INTEGER, models TEXT, models_hash TEXT DEFAULT '')",
      );
      database.exec(`INSERT INTO model_cache VALUES('openai-codex', 1, '${modelPayload}', '')`);
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      database.exec("BEGIN");
      database.exec(`UPDATE model_cache SET models = '${priorityPayload}'`);
      runtime.setUltrafastSupported(false);
      runtime.setInitialModel(priorityModel);
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      expect(runtime.recordedLaunches).toHaveLength(1);
      database.exec("COMMIT");
      expect(speed(await client.listFeatures(config))).toBeUndefined();
      expect(runtime.recordedLaunches).toHaveLength(2);
      database.exec("UPDATE model_cache SET updated_at = 2");
      expect(speed(await client.listFeatures(config))).toBeUndefined();
      expect(runtime.recordedLaunches).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it.each([`${model.provider}/${model.id}`, model.id, undefined])(
    "accepts unrelated startup caches and reconfirms native evidence for model=%s",
    async (configuredModel) => {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
      };
      class PopulatingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          await mkdir(join(directory, "profile"), { recursive: true });
          const database = new DatabaseSync(join(directory, "profile", "models.db"));
          try {
            database.exec(
              "CREATE TABLE IF NOT EXISTS model_cache(provider_id TEXT PRIMARY KEY, updated_at INTEGER, models TEXT)",
            );
            database.exec(
              `INSERT OR IGNORE INTO model_cache VALUES('factory-droid:models-v4:scope', 1, '[{"serviceTiers":["priority"]}]')`,
            );
          } finally {
            database.close();
          }
          return super.startSession(input);
        }
      }
      const { client, runtime, config } = setup(new PopulatingRuntime());
      if (configuredModel === undefined) delete config.model;
      else config.model = configuredModel;
      const warmLaunches = configuredModel === `${model.provider}/${model.id}` ? 1 : 2;
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      const database = new DatabaseSync(join(directory, "profile", "models.db"));
      try {
        database.exec(
          `UPDATE model_cache SET models = '[]' WHERE provider_id = 'factory-droid:models-v4:scope'`,
        );
        database.exec(`INSERT INTO model_cache VALUES('openai-codex-other:scope', 1, '[]')`);
        expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
        expect(runtime.recordedLaunches).toHaveLength(warmLaunches);
        database.exec(
          `INSERT INTO model_cache VALUES('openai-codex:0.159.0', 1, '${priorityPayload}')`,
        );
        runtime.setUltrafastSupported(false);
        runtime.setInitialModel(priorityModel);
        expect(speed(await client.listFeatures(config))).toBeUndefined();
        expect(runtime.recordedLaunches).toHaveLength(warmLaunches + 1);
      } finally {
        database.close();
      }
    },
  );

  it("does not infer Ultrafast or ignore bare-model identity when no provider is specified", async () => {
    const { client, runtime, config } = setup();
    delete config.model;
    runtime.setUltrafastSupported(false);
    expect(speed(await client.listFeatures(config))).toBeUndefined();
    runtime.setUltrafastSupported(true);
    expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
    expect(runtime.recordedLaunches).toHaveLength(2);
    config.model = model.id;
    runtime.setInitialModel({ ...model, id: "different-native-model" });
    await expect(client.listFeatures(config)).rejects.toThrow();
    expect(runtime.latestSession().closed).toBe(true);
  });

  it.each(["--config", "--config="])(
    "reconfirms changes to an external CLI %s overlay",
    async (flag) => {
      const overlay = join(directory, "external.yml");
      await writeFile(overlay, "tier:\n  openai: ultrafast\n");
      const args = flag === "--config" ? [flag, overlay] : [`${flag}${overlay}`];
      const { client, runtime, config } = setup(new FakeOmp(), args);
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      runtime.setUltrafastSupported(false);
      await writeFile(overlay, "tier:\n  openai: off\n");
      expect(speed(await client.listFeatures(config))).toBeUndefined();
      expect(runtime.recordedLaunches).toHaveLength(2);
    },
  );

  it("rejects capabilities invalidated during detection and reconfirms on retry", async () => {
    const reading = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let hold = true;
    class HeldRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const getState = session.getState.bind(session);
        session.getState = async () => {
          if (hold) {
            reading.resolve();
            await released.promise;
          }
          return getState();
        };
        return session;
      }
    }
    const { client, runtime, config } = setup(new HeldRuntime());
    const pending = client.listFeatures(config).catch((error: unknown) => error);
    await reading.promise;
    await mkdir(join(directory, ".omp"));
    await writeFile(join(directory, ".omp", "config.yml"), "tier:\n  openai: off\n");
    hold = false;
    released.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(runtime.latestSession().closed).toBe(true);
    runtime.setUltrafastSupported(false);
    expect(speed(await client.listFeatures(config))).toBeUndefined();
    expect(runtime.recordedLaunches).toHaveLength(2);
  });

  it.each(["getState", "close", "getState-restored-on-close"])(
    "rejects model evidence changed after readiness during %s and reconfirms on retry",
    async (phase) => {
      const database = await createModelCache();
      let mutate = true;
      const change = () => {
        if (!mutate) return;
        mutate = false;
        database.exec(`UPDATE model_cache SET models = '${priorityPayload}'`);
      };
      class MutatingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache VALUES('openai-codex:0.159.0', 1, '${modelPayload}')`,
          );
          const getState = session.getState.bind(session);
          session.getState = async () => {
            const state = await getState();
            if (phase !== "close") change();
            return state;
          };
          const close = session.close.bind(session);
          session.close = async () => {
            await close();
            if (phase === "close") change();
            if (phase === "getState-restored-on-close")
              database.exec(`UPDATE model_cache SET models = '${modelPayload}'`);
          };
          return session;
        }
      }
      const { client, runtime, config } = setup(new MutatingRuntime());
      try {
        await expect(client.listFeatures(config)).rejects.toThrow("context changed");
        expect(runtime.latestSession().closed).toBe(true);
        runtime.setUltrafastSupported(false);
        runtime.setInitialModel(phase === "getState-restored-on-close" ? model : priorityModel);
        expect(speed(await client.listFeatures(config))).toBeUndefined();
        expect(runtime.recordedLaunches).toHaveLength(2);
      } finally {
        database.close();
      }
    },
  );

  it("does not give a shared probe's old declaration to a caller that observed a newer one", async () => {
    const database = await createModelCache(true);
    const reading = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    let hold = true;
    class HeldRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const getState = session.getState.bind(session);
        session.getState = async () => {
          if (hold) {
            reading.resolve();
            await released.promise;
          }
          return getState();
        };
        return session;
      }
    }
    const { client, runtime, config } = setup(new HeldRuntime());
    // Observe a completed real SQLite read to order the two callers around an
    // external declaration change; the fingerprint itself is never replaced.
    const fingerprint = featureContext.fingerprintOmpFeatureContext;
    let observeNext = false;
    const observation = vi
      .spyOn(featureContext, "fingerprintOmpFeatureContext")
      .mockImplementation(async (input) => {
        const context = await fingerprint(input);
        if (observeNext) {
          observeNext = false;
          observed.resolve();
        }
        return context;
      });
    try {
      const first = client.listFeatures(config);
      await reading.promise;
      database.exec(`UPDATE model_cache SET models = '${priorityPayload}'`);
      observeNext = true;
      const changed = client.listFeatures(config).catch((error: unknown) => error);
      await observed.promise;
      database.exec(`UPDATE model_cache SET models = '${modelPayload}'`);
      hold = false;
      released.resolve();
      expect(speed(await first)).toMatchObject({ value: "ultrafast" });
      expect(await changed).toBeInstanceOf(Error);
      expect(runtime.recordedLaunches).toHaveLength(1);
      expect(runtime.latestSession().closed).toBe(true);
    } finally {
      released.resolve();
      observation.mockRestore();
      database.close();
    }
  });

  it.each([false, true])(
    "bounds queued work and rejects model changes before queued startup (existing evidence=%s)",
    async (populated) => {
      const database = await createModelCache(populated);
      const reading = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const busy = Promise.withResolvers<void>();
      class HeldRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          const getState = session.getState.bind(session);
          session.getState = async () => {
            reading.resolve();
            await released.promise;
            return getState();
          };
          return session;
        }
      }
      const { client, runtime, config } = setup(new HeldRuntime());
      const first = client.listFeatures(config).catch((error: unknown) => error);
      await reading.promise;
      const recordQueuedError = (error: unknown) => {
        if (error instanceof Error && error.message.includes("busy")) busy.resolve();
        return error;
      };
      const queued = Array.from({ length: 8 }, (_, index) =>
        client
          .listFeatures({
            ...config,
            featureValues: { oauth_account_credential: String(index + 1) },
          })
          .catch(recordQueuedError),
      );
      try {
        // The ninth distinct request is refused only after the other seven
        // have joined the queue; no sleeps or private queue inspection.
        await busy.promise;
        database.exec(
          `INSERT OR REPLACE INTO model_cache VALUES('openai-codex:0.159.0', 2, '${priorityPayload}')`,
        );
        released.resolve();
        const results = await Promise.all([first, ...queued]);
        expect(results.every((result) => result instanceof Error)).toBe(true);
        expect(runtime.recordedLaunches).toHaveLength(1);
        expect(runtime.latestSession().closed).toBe(true);
        runtime.setUltrafastSupported(false);
        runtime.setInitialModel(priorityModel);
        expect(speed(await client.listFeatures(config))).toBeUndefined();
        expect(runtime.recordedLaunches).toHaveLength(2);
      } finally {
        released.resolve();
        database.close();
      }
    },
  );

  it("does not cache failure and allows an explicit retry", async () => {
    const { client, runtime, config } = setup();
    runtime.failNextStart(new Error("native startup failed"));
    await expect(client.listFeatures(config)).rejects.toThrow();
    expect(speed(await client.listFeatures(config))).toMatchObject({
      type: "select",
      value: "ultrafast",
    });
    expect(runtime.latestSession().closed).toBe(true);
  });

  it("rejects evidence for a different model and never caches it for the requested model", async () => {
    const { client, runtime, config } = setup();
    runtime.setInitialModel({ ...model, id: "other-model" });
    await expect(client.listFeatures(config)).rejects.toThrow();
    expect(runtime.latestSession().closed).toBe(true);
    runtime.setInitialModel(model);
    expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
    expect(runtime.recordedLaunches).toHaveLength(2);
  });

  it.each([false, true])(
    "requires both native tier support and model declaration (native=%s)",
    async (native) => {
      const { client, runtime, config } = setup();
      runtime.setUltrafastSupported(native);
      runtime.setInitialModel({
        ...model,
        serviceTiers: native ? ["priority"] : model.serviceTiers,
      });
      expect(speed(await client.listFeatures(config))).toBeUndefined();
      expect(config.featureValues?.fast_mode).toBe("ultrafast");
      expect(runtime.latestSession().setFastModeRequests).toEqual([]);
      expect(runtime.latestSession().setFastModeTierRequests).toEqual([]);
    },
  );

  it("retains failed retirements and refuses another process until exit can be confirmed", async () => {
    let closes = 0;
    class UnconfirmedRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const close = session.close.bind(session);
        session.close = async () => {
          closes += 1;
          if (closes <= 2) throw new Error("exit not confirmed");
          await close();
        };
        return session;
      }
    }
    const { client, runtime, config } = setup(new UnconfirmedRuntime());
    await expect(client.listFeatures(config)).rejects.toThrow();
    const args = runtime.recordedLaunches[0]!.argv;
    const overlay = args[args.indexOf("--config") + 1]!;
    await access(overlay);
    await expect(client.listFeatures(config)).rejects.toThrow();
    expect(runtime.recordedLaunches).toHaveLength(1);
    expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
    expect(runtime.recordedLaunches).toHaveLength(2);
    await expect(access(overlay)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains startup retirement ownership when negotiation fails before returning a session", async () => {
    let closes = 0;
    class FailedNegotiationRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const close = session.close.bind(session);
        session.close = async () => {
          closes += 1;
          if (closes <= 2) throw new Error("unconfirmed startup process exit");
          await close();
        };
        input.onRetirementCreated?.(session);
        if (this.recordedLaunches.length === 1) throw new Error("protocol negotiation failed");
        return session;
      }
    }
    const { client, runtime, config } = setup(new FailedNegotiationRuntime());
    await expect(client.listFeatures(config)).rejects.toThrow();
    const args = runtime.recordedLaunches[0]!.argv;
    const overlay = args[args.indexOf("--config") + 1]!;
    await access(overlay);
    await expect(client.listFeatures(config)).rejects.toThrow();
    expect(runtime.recordedLaunches).toHaveLength(1);
    expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
    await expect(access(overlay)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes an independent OAuth runtime even when capability retirement still fails", async () => {
    let failRetirement = true;
    class FailedRetirementRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const close = session.close.bind(session);
        if (input.env?.OMP_DESKTOP_SERVICE_OWNER?.startsWith("desktop:capabilities:")) {
          session.close = async () => {
            if (failRetirement) throw new Error("unconfirmed capability exit");
            await close();
          };
        }
        return session;
      }
    }
    const { client, runtime, config } = setup(new FailedRetirementRuntime());
    runtime.queueLoginFlow({ url: "https://example.test/oauth" });
    await client.startOmpProviderLogin("openai-codex");
    const loginSession = runtime.latestSession();
    try {
      await expect(client.listFeatures(config)).rejects.toThrow();
      await expect(client.shutdown()).rejects.toBeInstanceOf(AggregateError);
      expect(loginSession.closed).toBe(true);
    } finally {
      failRetirement = false;
    }
  });

  it("aborts a stalled startup at its deadline, retires it and permits a bounded retry", async () => {
    const starting = Promise.withResolvers<void>();
    let stall = true;
    class StalledRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        if (!stall) return session;
        stall = false;
        input.onRetirementCreated?.(session);
        const signal = input.signal!;
        signal.throwIfAborted();
        const blocked = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => blocked.reject(signal.reason), { once: true });
        starting.resolve();
        await blocked.promise;
        return session;
      }
    }
    vi.useFakeTimers();
    const { client, runtime, config } = setup(new StalledRuntime());
    try {
      const detected = client.listFeatures(config).catch((error: unknown) => error);
      await starting.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await detected).toMatchObject({ message: "OMP capability detection timed out" });
      expect(runtime.latestSession().closed).toBe(true);
      const args = runtime.recordedLaunches[0]!.argv;
      const overlay = args[args.indexOf("--config") + 1]!;
      await expect(access(overlay)).rejects.toMatchObject({ code: "ENOENT" });
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      expect(runtime.recordedLaunches).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish successful state when shutdown begins during retirement", async () => {
    const retiring = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    class HeldRetirementRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        const close = session.close.bind(session);
        session.close = async () => {
          retiring.resolve();
          await released.promise;
          await close();
        };
        return session;
      }
    }
    const { client, runtime, config } = setup(new HeldRetirementRuntime());
    const detected = client.listFeatures(config).catch((error: unknown) => error);
    await retiring.promise;
    const shutdown = client.shutdown();
    await expect(client.listFeatures(config)).rejects.toThrow("shutting down");
    expect(runtime.latestSession().closed).toBe(false);
    released.resolve();
    await shutdown;
    expect(await detected).toMatchObject({ message: "OMP provider is shutting down" });
    expect(runtime.latestSession().closed).toBe(true);
    expect(runtime.recordedLaunches).toHaveLength(1);
  });

  it("waits for actual probe retirement on shutdown and refuses further work", async () => {
    const reading = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<never>();
    const retiring = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    class HeldRuntime extends FakeOmp {
      override async startSession(input: OmpStartSessionInput) {
        const session = await super.startSession(input);
        session.getState = async () => {
          reading.resolve();
          return blocked.promise;
        };
        const close = session.close.bind(session);
        session.close = async () => {
          retiring.resolve();
          blocked.reject(new Error("probe closed"));
          await released.promise;
          await close();
        };
        return session;
      }
    }
    const { client, runtime, config } = setup(new HeldRuntime());
    const detected = client.listFeatures(config).catch((error: unknown) => error);
    await reading.promise;
    let shutdownFinished = false;
    const shutdown = client.shutdown().finally(() => {
      shutdownFinished = true;
    });
    await retiring.promise;
    expect(shutdownFinished).toBe(false);
    expect(runtime.latestSession().closed).toBe(false);
    const args = runtime.recordedLaunches[0]!.argv;
    const overlay = args[args.indexOf("--config") + 1]!;
    await access(overlay);
    released.resolve();
    await shutdown;
    expect(await detected).toBeInstanceOf(Error);
    expect(runtime.latestSession().closed).toBe(true);
    await expect(access(overlay)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(client.listFeatures(config)).rejects.toThrow();
  });
});
