import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  disableStoredOmpCredential,
  disableStoredOmpProviderCredentials,
  formatOmpModelsYaml,
  readStoredOmpOAuthAccounts,
  readStoredOmpSessionCredentialId,
  OmpAgentClient,
} from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { CODEX_USAGE_ENDPOINT } from "./codex-account-quota.js";
import { CODEX_RESET_CREDITS_ENDPOINT } from "./codex-reset-credits.js";
import { CLAUDE_USAGE_ENDPOINT } from "./claude-account-quota.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const testRequire = createRequire(import.meta.url);
interface TestSqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
}
const { DatabaseSync } = testRequire("node:sqlite") as {
  DatabaseSync: new (path: string) => TestSqliteDatabase;
};

async function createClient(options: { quotaFetch?: typeof fetch } = {}) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-management-"));
  tempDirs.push(agentDir);
  const runtime = new FakeOmp();
  const client = new OmpAgentClient({
    logger: createTestLogger(),
    runtime,
    runtimeSettings: { env: { PI_CODING_AGENT_DIR: agentDir } },
    quotaFetch: options.quotaFetch ?? (async () => new Response(null, { status: 401 })),
  });
  return { agentDir, client, runtime };
}

describe("OMP provider management", () => {
  test("reads native models and subscription state", async () => {
    const { agentDir, client, runtime } = await createClient();
    runtime.queueModels([
      { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" },
      { provider: "openai", id: "gpt-5", name: "GPT-5" },
    ]);
    runtime.queueLoginProviders([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai", name: "OpenAI", available: true, authenticated: false },
    ]);

    await expect(client.getOmpProviderManagement()).resolves.toEqual({
      configPath: path.join(agentDir, "models.yml"),
      configYaml: "providers: {}\n",
      providerModels: [
        {
          id: "anthropic",
          modelCount: 2,
          source: "built-in",
          models: [
            { id: "claude-opus-4", name: "Claude Opus 4" },
            { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
          ],
        },
        {
          id: "openai",
          modelCount: 1,
          source: "built-in",
          models: [{ id: "gpt-5", name: "GPT-5" }],
        },
      ],
      loginProviders: [
        { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
        { id: "openai", name: "OpenAI", available: true, authenticated: false },
      ],
    });
    await expect(readFile(path.join(agentDir, "models.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not rewrite models.yml when OMP RPC starts successfully", async () => {
    const { agentDir, client, runtime } = await createClient();
    const configPath = path.join(agentDir, "models.yml");
    await writeFile(
      configPath,
      `# Keep this comment
providers:
  mintcat:
    baseUrl: https://mintcat.example.test
    models:
      - id: mint-model
`,
      "utf8",
    );
    runtime.queueModels([]);
    runtime.queueLoginProviders([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: false },
    ]);

    const management = await client.getOmpProviderManagement();
    expect(management.loginProviders).toEqual([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: false },
    ]);
    expect(await readFile(configPath, "utf8")).toBe(`# Keep this comment
providers:
  mintcat:
    baseUrl: https://mintcat.example.test
    models:
      - id: mint-model
`);
  });

  test("merges a keyless bootstrap model after OMP RPC fails with no models", async () => {
    const { agentDir, client, runtime } = await createClient();
    const configPath = path.join(agentDir, "models.yml");
    await writeFile(
      configPath,
      `# Keep this comment
providers:
  mintcat:
    baseUrl: https://mintcat.example.test
    models:
      - id: mint-model
`,
      "utf8",
    );
    runtime.failNextStart(
      new Error(
        "OMP RPC process exited with code 1 and signal null\nNo models available. Use /login or set an API key environment variable.",
      ),
    );
    runtime.queueModels([]);
    runtime.queueLoginProviders([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: false },
    ]);

    const management = await client.getOmpProviderManagement();
    expect(management.configYaml).toContain("# Keep this comment");
    expect(management.configYaml).toContain("mintcat");
    expect(management.configYaml).not.toContain("omp-desktop-bootstrap");
    expect(management.loginProviders).toEqual([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: false },
    ]);
    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toContain("# Keep this comment");
    expect(onDisk).toContain("mintcat");
    expect(onDisk).toContain("omp-desktop-bootstrap");
  });

  test("reports every active OAuth account without exposing credential data", async () => {
    const quotaFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer secret-a") {
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 42, reset_at: 1_798_122_000 },
              secondary_window: { used_percent: 8, reset_at: 1_798_640_000 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 401 });
    });
    const { agentDir, client, runtime } = await createClient({ quotaFetch });
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT
      );
      INSERT INTO auth_credentials
        (id, provider, credential_type, data, identity_key, disabled_cause)
      VALUES
        (1, 'openai-codex', 'oauth', '{"access":"secret-a","accountId":"acct-a"}', 'email:alice@example.com|org:personal', NULL),
        (2, 'openai-codex', 'oauth', '{"access":"secret-b","accountId":"acct-b"}', 'email:bob@example.com|org:team', NULL),
        (3, 'openai-codex', 'oauth', '{"access":"secret-c"}', 'email:old@example.com', 'expired'),
        (4, 'openai-codex', 'api_key', '{"key":"secret-d"}', NULL, NULL),
        (5, 'anthropic', 'oauth', '{"access":"secret-e"}', NULL, NULL);
    `);
    database.close();
    runtime.queueModels([]);
    runtime.queueLoginProviders([
      { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: true },
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
    ]);

    expect(readStoredOmpOAuthAccounts(databasePath)).toEqual([
      {
        credentialId: 5,
        accountNumber: 1,
        provider: "anthropic",
      },
      {
        credentialId: 1,
        accountNumber: 1,
        provider: "openai-codex",
        identityKey: "email:alice@example.com|org:personal",
      },
      {
        credentialId: 2,
        accountNumber: 2,
        provider: "openai-codex",
        identityKey: "email:bob@example.com|org:team",
      },
    ]);
    const management = await client.getOmpProviderManagement();
    expect(management).toMatchObject({
      loginProviders: [
        {
          id: "openai-codex",
          accounts: [
            {
              credentialId: 1,
              accountNumber: 1,
              identityKey: "email:alice@example.com|org:personal",
              quota: {
                status: "available",
                planLabel: "plus",
                fiveHourUsedPct: 42,
                fiveHourLimitReached: false,
                weeklyUsedPct: 8,
              },
            },
            {
              credentialId: 2,
              accountNumber: 2,
              identityKey: "email:bob@example.com|org:team",
              quota: {
                status: "unavailable",
                fiveHourUsedPct: null,
                fiveHourLimitReached: null,
              },
            },
          ],
        },
        {
          id: "anthropic",
          accounts: [{ credentialId: 5, accountNumber: 1 }],
        },
      ],
    });
    expect(JSON.stringify(management)).not.toContain("secret-a");
    expect(JSON.stringify(management)).not.toContain("secret-b");
    expect(
      quotaFetch.mock.calls
        .filter(([url]) => String(url) === CODEX_USAGE_ENDPOINT)
        .map(([, init]) => new Headers(init?.headers).get("ChatGPT-Account-Id"))
        .sort(),
    ).toEqual(["acct-a", "acct-b"]);
  });
  test("isolates Claude usage and keeps Codex reset credits separate without changing credentials", async () => {
    const quotaFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (String(url) === CLAUDE_USAGE_ENDPOINT && authorization === "Bearer claude-one") {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 17, resets_at: "2026-10-11T05:00Z" },
            seven_day: { utilization: 22 },
            extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 10000 },
          }),
        );
      }
      if (String(url) === CLAUDE_USAGE_ENDPOINT && authorization === "Bearer claude-two") {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 84 },
            seven_day_opus: { utilization: 63 },
          }),
        );
      }
      return new Response(null, { status: 401 });
    });
    const { agentDir, client, runtime } = await createClient({ quotaFetch });
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
        data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT
      );
      INSERT INTO auth_credentials VALUES
        (11, 'anthropic', 'oauth', '{"access":"claude-one","refresh":"never-write","subscriptionType":"pro"}', NULL, 'email:one@example.com'),
        (12, 'anthropic', 'oauth', '{"access":"claude-two","rateLimitTier":"default_claude_max_5x"}', NULL, 'email:two@example.com'),
        (13, 'anthropic', 'oauth', '{"access":"claude-expired"}', NULL, 'email:expired@example.com'),
        (14, 'anthropic', 'oauth', '{"access":"claude-disabled"}', 'expired', NULL),
        (15, 'anthropic', 'api_key', '{"key":"claude-api-key"}', NULL, NULL),
        (16, 'openai-codex', 'oauth', '{"access":"codex-token","accountId":"codex-account"}', NULL, NULL);
    `);
    const storedBefore = database.prepare("SELECT * FROM auth_credentials ORDER BY id").all();
    database.close();
    runtime.queueModels([]);
    runtime.queueLoginProviders([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai-codex", name: "Codex", available: true, authenticated: true },
    ]);

    const management = await client.getOmpProviderManagement();
    expect(management.loginProviders[0]?.accounts).toMatchObject([
      {
        credentialId: 11,
        accountNumber: 1,
        identityKey: "email:one@example.com",
        quota: {
          status: "available",
          planLabel: "pro",
          fiveHourUsedPct: 17,
          weeklyUsedPct: 22,
          extraUsage: { enabled: true, usedUsd: 2.5, monthlyLimitUsd: 100 },
        },
      },
      {
        credentialId: 12,
        accountNumber: 2,
        identityKey: "email:two@example.com",
        quota: {
          status: "available",
          planLabel: "Max 5x",
          fiveHourUsedPct: 84,
          weeklyUsedPct: null,
          modelWindows: [{ model: "opus", usedPct: 63 }],
        },
      },
      {
        credentialId: 13,
        accountNumber: 3,
        identityKey: "email:expired@example.com",
        quota: { status: "unavailable", fiveHourUsedPct: null },
      },
    ]);
    expect(management.loginProviders[1]?.accounts).toMatchObject([
      {
        credentialId: 16,
        quota: { status: "unavailable", resetCredits: { status: "unavailable" } },
      },
    ]);
    expect(
      quotaFetch.mock.calls
        .filter(([url]) => String(url) === CLAUDE_USAGE_ENDPOINT)
        .map(([, init]) => new Headers(init?.headers).get("Authorization"))
        .sort(),
    ).toEqual(["Bearer claude-expired", "Bearer claude-one", "Bearer claude-two"]);
    expect(quotaFetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect(JSON.stringify(management)).not.toMatch(
      /claude-one|claude-two|claude-expired|codex-token|never-write/,
    );
    expect(
      management.loginProviders[0]?.accounts?.every(
        (account) => !account.quota?.resetCredits && !account.quota?.subscription,
      ),
    ).toBe(true);
    const after = new DatabaseSync(databasePath);
    expect(after.prepare("SELECT * FROM auth_credentials ORDER BY id").all()).toEqual(storedBefore);
    after.close();
  });
  test("reads the unexpired OAuth credential selected for an OMP session", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-session-credential-"));
    tempDirs.push(agentDir);
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO cache (key, value, expires_at) VALUES
        (
          'session:sticky:openai-codex:active-session',
          '{"type":"oauth","credentialId":42}',
          4102444800
        ),
        (
          'session:sticky:openai-codex:expired-session',
          '{"type":"oauth","credentialId":41}',
          1
        );
    `);
    database.close();

    expect(readStoredOmpSessionCredentialId(databasePath, "openai-codex", "active-session")).toBe(
      42,
    );
    expect(
      readStoredOmpSessionCredentialId(databasePath, "openai-codex", "expired-session"),
    ).toBeUndefined();
  });
  test("reads refreshed OAuth credentials before the first quota request", async () => {
    const quotaFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== "Bearer refreshed-token") {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 25, reset_at: 1_798_122_000 },
            secondary_window: { used_percent: 10, reset_at: 1_798_640_000 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { agentDir, client, runtime } = await createClient({ quotaFetch });
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT
      );
      INSERT INTO auth_credentials
        (id, provider, credential_type, data, identity_key, disabled_cause)
      VALUES
        (1, 'openai-codex', 'oauth', '{"access":"stale-token","accountId":"acct-a"}', 'email:alice@example.com', NULL);
    `);
    database.close();
    runtime.queueModels([]);
    runtime.queueLoginProviders([
      { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: true },
    ]);
    const startSession = runtime.startSession.bind(runtime);
    runtime.startSession = async (input) => {
      const refreshedDatabase = new DatabaseSync(databasePath);
      refreshedDatabase.exec(
        `UPDATE auth_credentials SET data = '{"access":"refreshed-token","accountId":"acct-a"}' WHERE id = 1`,
      );
      refreshedDatabase.close();
      return startSession(input);
    };

    const management = await client.getOmpProviderManagement();

    expect(management.loginProviders[0]?.accounts?.[0]?.quota).toMatchObject({
      status: "available",
      fiveHourUsedPct: 25,
      weeklyUsedPct: 10,
    });
    expect(
      quotaFetch.mock.calls.every(
        ([, init]) => new Headers(init?.headers).get("Authorization") === "Bearer refreshed-token",
      ),
    ).toBe(true);
  });
  test("persists account order without overriding OMP automatic selection", async () => {
    const { agentDir, client, runtime } = await createClient();
    const database = new DatabaseSync(path.join(agentDir, "agent.db"));
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT
      );
      INSERT INTO auth_credentials
        (id, provider, credential_type, data, identity_key, disabled_cause)
      VALUES
        (1, 'openai-codex', 'oauth', '{"access":"secret-a"}', 'email:alice@example.com', NULL),
        (2, 'openai-codex', 'oauth', '{"access":"secret-b"}', 'email:bob@example.com', NULL);
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO cache (key, value, expires_at) VALUES
        (
          'session:sticky:openai-codex:omp-session-1',
          '{"type":"oauth","credentialId":1}',
          4102444800
        );
    `);
    database.close();
    const providers = [
      { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: true },
    ];
    runtime.queueModels([]);
    runtime.queueLoginProviders(providers);
    runtime.queueModels([]);
    runtime.queueLoginProviders(providers);

    const management = await client.reorderOmpProviderAccounts("openai-codex", [2, 1]);

    expect(
      management.loginProviders[0]?.accounts?.map(({ credentialId, accountNumber }) => ({
        credentialId,
        accountNumber,
      })),
    ).toEqual([
      { credentialId: 2, accountNumber: 2 },
      { credentialId: 1, accountNumber: 1 },
    ]);
    runtime.setInitialModel({ provider: "openai-codex", id: "gpt-5.6" });
    const session = await client.createSession({
      provider: "omp",
      cwd: agentDir,
      model: "openai-codex/gpt-5.6",
    });
    expect(runtime.latestSession().prompts).toEqual([]);
    expect(session.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oauth_account_credential",
          value: "automatic",
          effectiveValue: "1",
        }),
      ]),
    );
  });
  test("cancels an active provider login and closes its runtime session", async () => {
    const { client, runtime } = await createClient();
    runtime.queueLoginFlow({
      url: "https://example.test/oauth",
      launchUrl: "https://example.test/oauth?launch=1",
    });

    const flow = await client.startOmpProviderLogin("openai-codex");
    const session = runtime.latestSession();
    expect(flow).toMatchObject({
      providerId: "openai-codex",
      url: "https://example.test/oauth",
    });
    expect(session.loginRequests).toEqual(["openai-codex"]);
    expect(session.closed).toBe(false);

    await expect(client.cancelOmpProviderLogin(flow.flowId)).resolves.toBe(true);
    expect(session.closed).toBe(true);
    await expect(client.cancelOmpProviderLogin(flow.flowId)).resolves.toBe(false);
  });

  test("logs out only active credentials for the requested provider", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-auth-"));
    tempDirs.push(agentDir);
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        disabled_cause TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO auth_credentials (id, provider) VALUES
        (1, 'openai-codex'),
        (2, 'anthropic'),
        (3, 'openai-codex');
      UPDATE auth_credentials SET disabled_cause = 'expired' WHERE id = 3;
    `);
    database.close();

    expect(disableStoredOmpProviderCredentials(databasePath, "openai-codex")).toBe(1);

    const verification = new DatabaseSync(databasePath);
    const rows = verification
      .prepare("SELECT id, disabled_cause FROM auth_credentials ORDER BY id")
      .all();
    verification.close();
    expect(rows).toEqual([
      { id: 1, disabled_cause: "deleted by user" },
      { id: 2, disabled_cause: null },
      { id: 3, disabled_cause: "expired" },
    ]);
  });

  test("logs out only the requested OAuth credential", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-auth-"));
    tempDirs.push(agentDir);
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        disabled_cause TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO auth_credentials (id, provider, credential_type) VALUES
        (1, 'openai-codex', 'oauth'),
        (2, 'openai-codex', 'oauth'),
        (3, 'openai-codex', 'apiKey'),
        (4, 'anthropic', 'oauth');
    `);
    database.close();

    expect(disableStoredOmpCredential(databasePath, "openai-codex", 2)).toBe(1);
    expect(disableStoredOmpCredential(databasePath, "anthropic", 1)).toBe(0);
    expect(disableStoredOmpCredential(databasePath, "openai-codex", 3)).toBe(0);

    const verification = new DatabaseSync(databasePath);
    const rows = verification
      .prepare("SELECT id, disabled_cause FROM auth_credentials ORDER BY id")
      .all();
    verification.close();
    expect(rows).toEqual([
      { id: 1, disabled_cause: null },
      { id: 2, disabled_cause: "deleted by user" },
      { id: 3, disabled_cause: null },
      { id: 4, disabled_cause: null },
    ]);
  });

  test("reuses the lowest free account number without changing retained credentials", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-account-numbers-"));
    tempDirs.push(agentDir);
    const databasePath = path.join(agentDir, "agent.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        data TEXT NOT NULL,
        disabled_cause TEXT,
        identity_key TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO auth_credentials
        (id, provider, credential_type, data, identity_key, disabled_cause)
      VALUES
        (10, 'openai-codex', 'oauth', '{"access":"first"}', 'email:first@example.com', NULL),
        (20, 'openai-codex', 'oauth', '{"access":"second"}', 'email:second@example.com', NULL),
        (30, 'openai-codex', 'oauth', '{"access":"third"}', 'email:third@example.com', NULL),
        (40, 'anthropic', 'oauth', '{"access":"other"}', 'email:other@example.com', NULL),
        (50, 'openai-codex', 'api_key', '{"key":"api-key"}', NULL, NULL),
        (60, 'openai-codex', 'oauth', '{"access":"expired"}', 'email:expired@example.com', 'expired');
      CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO cache VALUES
        ('session:sticky:openai-codex:retained-session', '{"type":"oauth","credentialId":30}', 4102444800);
    `);
    const retainedRows = database
      .prepare("SELECT * FROM auth_credentials WHERE id IN (30, 40, 50, 60) ORDER BY id")
      .all();
    const orderPath = path.join(agentDir, "omp-desktop-account-order.json");
    const order = '{"openai-codex":[30,10,20]}';
    await writeFile(orderPath, order);

    expect(readStoredOmpOAuthAccounts(databasePath)).toMatchObject([
      { credentialId: 40, accountNumber: 1 },
      { credentialId: 10, accountNumber: 1 },
      { credentialId: 20, accountNumber: 2 },
      { credentialId: 30, accountNumber: 3 },
    ]);
    expect(disableStoredOmpCredential(databasePath, "openai-codex", 20)).toBe(1);
    expect(disableStoredOmpCredential(databasePath, "openai-codex", 10)).toBe(1);
    database.exec(`
      INSERT INTO auth_credentials (provider, credential_type, data, identity_key)
      VALUES ('openai-codex', 'oauth', '{"access":"replacement-a"}', 'email:new-a@example.com'),
             ('openai-codex', 'oauth', '{"access":"replacement-b"}', 'email:new-b@example.com');
    `);
    expect(readStoredOmpOAuthAccounts(databasePath)).toMatchObject([
      { credentialId: 40, accountNumber: 1 },
      { credentialId: 30, accountNumber: 3 },
      { credentialId: 61, accountNumber: 1 },
      { credentialId: 62, accountNumber: 2 },
    ]);
    expect(readStoredOmpSessionCredentialId(databasePath, "openai-codex", "retained-session")).toBe(
      30,
    );
    expect(
      database
        .prepare("SELECT * FROM auth_credentials WHERE id IN (30, 40, 50, 60) ORDER BY id")
        .all(),
    ).toEqual(retainedRows);
    expect(await readFile(orderPath, "utf8")).toBe(order);

    database.exec("DELETE FROM auth_credentials WHERE id = 61");
    database.close();
    const reopened = new DatabaseSync(databasePath);
    reopened.exec(`
      INSERT INTO auth_credentials (provider, credential_type, data)
      VALUES ('openai-codex', 'oauth', '{"access":"after-restart"}');
    `);
    reopened.close();
    expect(readStoredOmpOAuthAccounts(databasePath)).toMatchObject([
      { credentialId: 40, accountNumber: 1 },
      { credentialId: 30, accountNumber: 3 },
      { credentialId: 62, accountNumber: 2 },
      { credentialId: 63, accountNumber: 1 },
    ]);
  });

  test("reports built-in model context-window overrides without treating them as custom", async () => {
    const { agentDir, client, runtime } = await createClient();
    await writeFile(
      path.join(agentDir, "models.yml"),
      `providers:
  openai-codex:
    modelOverrides:
      gpt-5.6-sol:
        contextWindow: 1000000
`,
      "utf8",
    );
    runtime.queueModels([
      {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        contextWindow: 1_000_000,
      },
    ]);
    runtime.queueLoginProviders([
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        available: true,
        authenticated: true,
      },
    ]);

    await expect(client.getOmpProviderManagement()).resolves.toMatchObject({
      providerModels: [
        {
          id: "openai-codex",
          modelCount: 1,
          source: "built-in",
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6-Sol",
              contextWindow: 1_000_000,
              contextWindowOverride: 1_000_000,
            },
          ],
        },
      ],
    });
  });

  test("updates only requested model context-window overrides", async () => {
    const { agentDir, client, runtime } = await createClient();
    const configPath = path.join(agentDir, "models.yml");
    await writeFile(
      configPath,
      `# Keep this comment
providers:
  openai-codex:
    modelOverrides:
      gpt-empty:
        contextWindow: 32000
      gpt-sibling:
        contextWindow: 64000
        maxTokens: 4096
  mintcat:
    baseUrl: https://api.example.test/v1
`,
      "utf8",
    );
    runtime.queueModels([]);
    runtime.queueLoginProviders([]);
    runtime.queueModels([]);
    runtime.queueLoginProviders([]);

    await client.updateOmpModelContextWindowOverrides("openai-codex", {
      "gpt-empty": null,
      "gpt-sibling": null,
      "gpt-new": 1_000_000,
    });

    const updatedYaml = await readFile(configPath, "utf8");
    expect(updatedYaml).toContain("# Keep this comment");
    expect(parse(updatedYaml)).toEqual({
      providers: {
        "openai-codex": {
          modelOverrides: {
            "gpt-sibling": { maxTokens: 4096 },
            "gpt-new": { contextWindow: 1_000_000 },
          },
        },
        mintcat: { baseUrl: "https://api.example.test/v1" },
      },
    });
  });

  test("rejects invalid context-window overrides before starting OMP", async () => {
    const { client, runtime } = await createClient();

    await expect(
      client.updateOmpModelContextWindowOverrides("openai-codex", {
        "gpt-5.6-sol": 1.5,
      }),
    ).rejects.toThrow("Invalid OMP context window");
    expect(runtime.recordedLaunches).toHaveLength(0);
  });
  test("formats models.yml as readable block YAML and preserves comments", () => {
    expect(
      formatOmpModelsYaml(
        "# Custom providers\nproviders: { mintcat: { baseUrl: https://api.example.test/v1, models: [{ id: gpt-test, name: GPT Test }] } }",
      ),
    ).toBe(`# Custom providers
providers:
  mintcat:
    baseUrl: https://api.example.test/v1
    models:
      - id: gpt-test
        name: GPT Test
`);
  });

  test("saves models.yml atomically after OMP accepts it", async () => {
    const { agentDir, client, runtime } = await createClient();
    runtime.queueModels([]);
    runtime.queueLoginProviders([]);

    const configYaml = "providers:\n  local:\n    auth: none\n";
    await expect(client.saveOmpProviderConfig(configYaml)).resolves.toMatchObject({
      configYaml,
    });
    await expect(readFile(path.join(agentDir, "models.yml"), "utf8")).resolves.toBe(configYaml);
  });
  test("adds an endpoint, API key, and multiple models to native models.yml", async () => {
    const { agentDir, client } = await createClient();

    await client.addOmpProvider({
      providerId: "mintcat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      api: "openai-responses",
      models: [
        {
          id: "gpt-test",
          name: "GPT Test",
          api: "openai-responses",
          contextWindow: 128_000,
          maxTokens: 16_384,
          supportsImages: true,
          reasoning: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium", "high"],
        },
        { id: "gpt-test-mini", name: "GPT Test Mini", api: "anthropic-messages" },
      ],
    });

    const config = parse(await readFile(path.join(agentDir, "models.yml"), "utf8"));
    expect(config).toEqual({
      providers: {
        mintcat: {
          baseUrl: "https://api.example.test/v1",
          apiKey: "test-key",
          api: "openai-responses",
          auth: "apiKey",
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              api: "openai-responses",
              input: ["text", "image"],
              contextWindow: 128_000,
              maxTokens: 16_384,
              reasoning: true,
              thinking: {
                mode: "effort",
                efforts: ["low", "medium", "high"],
                defaultLevel: "medium",
              },
            },
            {
              id: "gpt-test-mini",
              name: "GPT Test Mini",
              api: "anthropic-messages",
              input: ["text"],
            },
          ],
        },
      },
    });
  });

  test("removes only the requested custom provider", async () => {
    const { agentDir, client } = await createClient();
    const configPath = path.join(agentDir, "models.yml");
    await writeFile(
      configPath,
      `providers:
  mintcat:
    baseUrl: https://mintcat.example.test
    models:
      - id: mint-model
  keep:
    baseUrl: https://keep.example.test
    models:
      - id: keep-model
`,
      "utf8",
    );

    await client.removeOmpProvider("mintcat");

    expect(parse(await readFile(configPath, "utf8"))).toEqual({
      providers: {
        keep: {
          baseUrl: "https://keep.example.test",
          models: [{ id: "keep-model" }],
        },
      },
    });
  });

  test("consumes only the selected active Codex credential and blocks concurrent account resets", async () => {
    const posted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const requests: Array<{ account: string | null; method: string }> = [];
    const quotaFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_url)).toBe(
        init?.method === "POST"
          ? `${CODEX_RESET_CREDITS_ENDPOINT}/consume`
          : CODEX_RESET_CREDITS_ENDPOINT,
      );
      requests.push({
        account: new Headers(init?.headers).get("ChatGPT-Account-Id"),
        method: init?.method ?? "GET",
      });
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          credit_id: "selected",
          redeem_request_id: "stable-request",
        });
        posted.resolve();
        return release.promise;
      }
      return new Response(
        JSON.stringify({
          available_count: 1,
          credits: [
            {
              id: "selected",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: "2026-09-01T00:00:00Z",
              expires_at: null,
            },
          ],
        }),
        { status: 200 },
      );
    };
    const { agentDir, client } = await createClient({ quotaFetch });
    const database = new DatabaseSync(path.join(agentDir, "agent.db"));
    database.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL,
        data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT
      );
      INSERT INTO auth_credentials VALUES
        (1, 'openai-codex', 'oauth', '{"access":"first","accountId":"other-account"}', NULL, NULL),
        (2, 'openai-codex', 'oauth', '{"access":"selected","accountId":"selected-account"}', NULL, NULL),
        (3, 'openai-codex', 'oauth', '{"access":"disabled"}', 'expired', NULL),
        (4, 'anthropic', 'oauth', '{"access":"not-codex"}', NULL, NULL);
    `);
    database.close();
    await expect(
      client.consumeOmpCodexResetCredit(3, "selected", "invalid-disabled"),
    ).rejects.toThrow("unavailable");
    await expect(
      client.consumeOmpCodexResetCredit(4, "selected", "invalid-provider"),
    ).rejects.toThrow("unavailable");
    const first = client.consumeOmpCodexResetCredit(2, "selected", "stable-request");
    await posted.promise;
    const duplicate = client.consumeOmpCodexResetCredit(2, "selected", "stable-request");
    await expect(
      client.consumeOmpCodexResetCredit(2, "selected", "different-request"),
    ).rejects.toThrow("already being consumed");
    release.resolve(
      new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 }),
    );
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { code: "reset", windowsReset: 2 },
      { code: "reset", windowsReset: 2 },
    ]);
    expect(requests).toEqual([
      { account: "selected-account", method: "GET" },
      { account: "selected-account", method: "POST" },
    ]);
  });
  test("rolls back a models.yml rejected by OMP", async () => {
    const { agentDir, client, runtime } = await createClient();
    const configPath = path.join(agentDir, "models.yml");
    const previous = "providers: {}\n";
    await writeFile(configPath, previous, "utf8");
    runtime.failNextStart(new Error("invalid models.yml"));

    await expect(client.saveOmpProviderConfig("providers: broken\n")).rejects.toThrow(
      "OMP could not validate the models configuration; the previous configuration was restored. invalid models.yml",
    );
    await expect(readFile(configPath, "utf8")).resolves.toBe(previous);
  });
});
