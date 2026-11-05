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
  api: "openai-codex-responses",
  serviceTiers: ["priority", "ultrafast"],
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

async function createModelCache(populated = false) {
  await mkdir(join(directory, "profile"), { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
  };
  const database = new DatabaseSync(join(directory, "profile", "models.db"));
  database.exec(
    "CREATE TABLE model_cache(provider_id TEXT PRIMARY KEY, updated_at INTEGER, models TEXT)",
  );
  if (populated)
    database.exec(
      `INSERT INTO model_cache VALUES('openai-codex:client-version:account-scope', 1, '[{"serviceTiers":["priority","ultrafast"]}]')`,
    );
  return database;
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

  it.each([false, true])(
    "accepts first selected-provider cache materialization and shares consumers across it (schema=%s)",
    async (withSchema) => {
      if (withSchema) (await createModelCache()).close();
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
              `INSERT OR REPLACE INTO model_cache VALUES('openai-codex:client-version:account-scope', 1, '[{"serviceTiers":["priority","ultrafast"]}]')`,
            );
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
              `INSERT OR REPLACE INTO model_cache VALUES('openai-codex:client-version:account-scope', 2, '[{"serviceTiers":["priority"]}]')`,
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
      database.exec(
        `INSERT INTO model_cache VALUES('openai-codex', 1, '[{"serviceTiers":["priority","ultrafast"]}]', '')`,
      );
      expect(speed(await client.listFeatures(config))).toMatchObject({ value: "ultrafast" });
      database.exec("BEGIN");
      database.exec(`UPDATE model_cache SET models = '[{"serviceTiers":["priority"]}]'`);
      runtime.setUltrafastSupported(false);
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
          `INSERT INTO model_cache VALUES('openai-codex:client-version:account-scope', 1, '[{"serviceTiers":["priority"]}]')`,
        );
        runtime.setUltrafastSupported(false);
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
        database.exec(`UPDATE model_cache SET models = '[{"serviceTiers":["priority"]}]'`);
      };
      class MutatingRuntime extends FakeOmp {
        override async startSession(input: OmpStartSessionInput) {
          const session = await super.startSession(input);
          database.exec(
            `INSERT OR IGNORE INTO model_cache VALUES('openai-codex:client-version:account-scope', 1, '[{"serviceTiers":["priority","ultrafast"]}]')`,
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
              database.exec(
                `UPDATE model_cache SET models = '[{"serviceTiers":["priority","ultrafast"]}]'`,
              );
          };
          return session;
        }
      }
      const { client, runtime, config } = setup(new MutatingRuntime());
      try {
        await expect(client.listFeatures(config)).rejects.toThrow("context changed");
        expect(runtime.latestSession().closed).toBe(true);
        runtime.setUltrafastSupported(false);
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
      database.exec(`UPDATE model_cache SET models = '[{"serviceTiers":["priority"]}]'`);
      observeNext = true;
      const changed = client.listFeatures(config).catch((error: unknown) => error);
      await observed.promise;
      database.exec(
        `UPDATE model_cache SET models = '[{"serviceTiers":["priority","ultrafast"]}]'`,
      );
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
          `INSERT OR REPLACE INTO model_cache VALUES('openai-codex:client-version:account-scope', 2, '[{"serviceTiers":["priority"]}]')`,
        );
        released.resolve();
        const results = await Promise.all([first, ...queued]);
        expect(results.every((result) => result instanceof Error)).toBe(true);
        expect(runtime.recordedLaunches).toHaveLength(1);
        expect(runtime.latestSession().closed).toBe(true);
        runtime.setUltrafastSupported(false);
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
