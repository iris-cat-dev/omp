import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorQuotaProvider, createStoredCursorQuotaProviders } from "./cursor.js";

const homes: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cursorHome(email: string): string {
  const home = mkdtempSync(join(tmpdir(), "cursor-quota-"));
  homes.push(home);
  const directory = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "state.vscdb"));
  database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  database
    .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
    .run("cursorAuth/cachedEmail", email);
  database.close();
  return home;
}

function provider(homeDir: string, fetchApi: typeof fetch): CursorQuotaProvider {
  return new CursorQuotaProvider({
    logger: pino({ level: "silent" }),
    fetch: fetchApi,
    homeDir,
    platform: "darwin",
  });
}

afterEach(() => {
  delete process.env["CURSOR_ACCESS_TOKEN"];
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("CursorQuotaProvider team spend", () => {
  it("uses the signed-in member spend when the individual plan usage is absent", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    const home = cursorHome("me@example.com");
    const calls: string[] = [];
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        return jsonResponse({ billingCycleEnd: "1788329751426", displayThreshold: 100 });
      }
      if (url.endsWith("/GetTeams")) {
        return jsonResponse({ teams: [{ id: 10 }, { id: 20 }] });
      }
      if (url.endsWith("/GetTeamSpend")) {
        const body: unknown = JSON.parse(String(init?.body));
        if (typeof body === "object" && body !== null && "teamId" in body && body.teamId === 10) {
          return jsonResponse({
            teamMemberSpend: [
              {
                email: "admin@example.com",
                spendCents: 99999,
                effectivePerUserLimitDollars: 2000,
              },
              {
                email: "ME@example.com",
                spendCents: 1061,
                overallSpendCents: 1061,
                monthlyLimitDollars: 1000,
                effectivePerUserLimitDollars: 1000,
              },
            ],
            nextCycleStart: "1790812800000",
          });
        }
        return jsonResponse({ teamMemberSpend: [] });
      }
      throw new Error(`Unexpected Cursor endpoint: ${url}`);
    }) as typeof fetch;

    const usage = await provider(home, fetchApi).fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      balances: [
        {
          id: "team_spend",
          label: "Monthly usage",
          used: 10.61,
          remaining: 989.39,
          limit: 1000,
          unit: "usd",
          resetsAt: "2026-10-01T00:00:00.000Z",
          tone: "ok",
        },
      ],
    });
    expect(calls.some((url) => url.endsWith("/auth/usage"))).toBe(false);
  });

  it("does not request team spend when individual plan usage is available", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/GetCurrentPeriodUsage")) {
        throw new Error(`Unexpected Cursor endpoint: ${url}`);
      }
      return jsonResponse({
        planUsage: { totalSpend: 1061, remaining: 98939, limit: 100000 },
        billingCycleEnd: "1790812800000",
      });
    }) as typeof fetch;

    const usage = await provider(cursorHome("me@example.com"), fetchApi).fetchUsage();

    expect(usage.balances?.[0]).toMatchObject({ id: "plan_usage", used: 10.61, limit: 1000 });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("falls back to legacy request usage when team spend fails", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/GetCurrentPeriodUsage")) return jsonResponse({});
      if (url.endsWith("/GetTeams")) return jsonResponse({}, 500);
      if (url.endsWith("/auth/usage")) {
        return jsonResponse({ gpt: { numRequests: 7, maxRequestUsage: 100 } });
      }
      throw new Error(`Unexpected Cursor endpoint: ${url}`);
    }) as typeof fetch;

    const usage = await provider(cursorHome("me@example.com"), fetchApi).fetchUsage();

    expect(usage.balances?.[0]).toMatchObject({
      id: "monthly_requests",
      used: 7,
      remaining: 93,
      limit: 100,
    });
  });
});

describe("CursorQuotaProvider credentials and billing dates", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "cursor-credentials-"));
    homes.push(homeDir);
    vi.stubEnv("CURSOR_ACCESS_TOKEN", "");
    vi.stubEnv("CURSOR_TOKEN", "");
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => vi.unstubAllEnvs());

  function credentialProvider(): CursorQuotaProvider {
    return new CursorQuotaProvider({
      logger: createLogger(),
      fetch: fetchApi,
      homeDir,
      platform: "linux",
    });
  }
  it("fetches Cursor usage and normalizes malformed billing dates to null", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              planUsage: {
                totalSpend: "1500",
                includedSpend: "1000",
                bonusSpend: "500",
                remaining: "2500",
                limit: "4000",
              },
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "not-a-date",
            }),
        ],
      ]),
    );

    const cursor = await credentialProvider().fetchUsage();

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "plan_usage",
          used: 15,
          remaining: 25,
          limit: 40,
          resetsAt: null,
        }),
      ],
    });
  });

  it("reads the Cursor token from the modern cursorAuth/accessToken key in state.vscdb", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_state_jwt" });
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = await credentialProvider().fetchUsage();

    expect(authorization).toBe("Bearer cursor_state_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("falls back to the legacy cursorAuthStatus JSON blob when the modern key is absent", async () => {
    writeCursorStateDb(homeDir, {
      cursorAuthStatus: Buffer.from(JSON.stringify({ accessToken: "cursor_legacy_jwt" }), "utf8"),
    });
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = await credentialProvider().fetchUsage();

    expect(authorization).toBe("Bearer cursor_legacy_jwt");
    expect(cursor.status).toBe("available");
  });

  it("reads the Cursor token from cursor-agent ~/.config/cursor/auth.json when desktop state is absent", async () => {
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = await credentialProvider().fetchUsage();

    expect(authorization).toBe("Bearer cursor_cli_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("prefers the desktop state.vscdb token over cursor-agent auth.json", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_desktop_jwt" });
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = await credentialProvider().fetchUsage();

    expect(authorization).toBe("Bearer cursor_desktop_jwt");
    expect(cursor.status).toBe("available");
  });

  it("logs a debug diagnostic and stays unavailable when state.vscdb is unreadable", async () => {
    const dir = join(homeDir, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.vscdb"), "not a sqlite database");
    const debug = vi.fn();
    const logger = {
      debug,
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    } as unknown as Logger;
    const unavailableProvider = new CursorQuotaProvider({
      logger,
      fetch: (() => {
        throw new Error("usage API should not be called without a token");
      }) as unknown as typeof fetch,
      homeDir,
      platform: "linux",
    });

    const usage = await unavailableProvider.fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("state.vscdb") }),
      expect.stringContaining("Failed to read Cursor token"),
    );
  });

  it("ignores encrypted cursor-safe tokens in state.vscdb and never sends them over HTTP", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor-safe-encrypted-blob" });
    const fetchSpy = vi.fn(() => {
      throw new Error("encrypted safeStorage blobs must not be sent as Bearer tokens");
    }) as unknown as typeof fetch;

    const usage = await new CursorQuotaProvider({
      logger: createLogger(),
      fetch: fetchSpy,
      homeDir,
      platform: "linux",
    }).fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads OMP agent.db Cursor OAuth credentials and queries usage-summary even when state.vscdb is encrypted", async () => {
    const token = createJwt({
      sub: "auth0|user_01TEST",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor-safe-encrypted-blob" });
    writeOmpAgentDb(homeDir, [
      {
        id: 10,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: token, refresh: "ref_1", email: "omp@example.com" }),
        disabled_cause: null,
      },
    ]);
    let receivedCookie = "";
    fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://cursor.com/api/usage-summary") {
        receivedCookie = new Headers(init?.headers).get("Cookie") ?? "";
        return jsonResponse({
          billingCycleStart: "2026-11-01T00:00:00.000Z",
          billingCycleEnd: "2026-12-01T00:00:00.000Z",
          membershipType: "enterprise",
          limitType: "team",
          isUnlimited: false,
          individualUsage: {
            overall: { enabled: true, used: 3975, limit: 100000, remaining: 96025 },
          },
        });
      }
      throw new Error(`Unexpected Cursor endpoint: ${url}`);
    }) as typeof fetch;

    const usage = await credentialProvider().fetchUsage();

    expect(receivedCookie).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent(`user_01TEST::${token}`)}`,
    );
    expect(usage).toMatchObject({
      providerId: "cursor",
      status: "available",
      planLabel: "Enterprise",
      balances: [
        {
          id: "team_spend",
          label: "Monthly usage",
          used: 39.75,
          remaining: 960.25,
          limit: 1000,
          unit: "usd",
          resetsAt: "2026-12-01T00:00:00.000Z",
          tone: "ok",
        },
      ],
    });
  });

  it("parses Pro+ split rails and on-demand spend from usage-summary", async () => {
    const token = createJwt({ sub: "github|1245379", exp: Math.floor(Date.now() / 1000) + 3600 });
    writeOmpAgentDb(homeDir, [
      {
        id: 1,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: token }),
        disabled_cause: null,
      },
    ]);
    fetchApi = mockFetch(
      new Map([
        [
          "https://cursor.com/api/usage-summary",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-09-08T08:00:31.000Z",
              membershipType: "pro_plus",
              individualUsage: {
                plan: {
                  enabled: true,
                  used: 1504,
                  limit: 7000,
                  remaining: 5496,
                  autoPercentUsed: 1.85,
                  apiPercentUsed: 10,
                },
                onDemand: {
                  enabled: true,
                  used: 500,
                  limit: 2000,
                  remaining: 1500,
                },
              },
            }),
        ],
      ]),
    );

    const usage = await credentialProvider().fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      planLabel: "Pro+",
      windows: [
        {
          id: "cursor_models",
          label: "Cursor Models",
          usedPct: 1.85,
          remainingPct: 98.15,
          resetsAt: "2026-09-08T08:00:31.000Z",
          tone: "ok",
        },
      ],
      balances: [
        {
          id: "other_models",
          label: "Other Models",
          used: 7,
          remaining: 63,
          limit: 70,
          unit: "usd",
          resetsAt: "2026-09-08T08:00:31.000Z",
          tone: "ok",
        },
        {
          id: "on_demand",
          label: "On-demand usage",
          used: 5,
          remaining: 15,
          limit: 20,
          unit: "usd",
          resetsAt: "2026-09-08T08:00:31.000Z",
          tone: "ok",
        },
      ],
    });
  });

  it("parses unified subscription weekly pool via GetPlanInfo and prepaid credit", async () => {
    const token = createJwt({ sub: "auth0|user_uni", exp: Math.floor(Date.now() / 1000) + 3600 });
    writeOmpAgentDb(homeDir, [
      {
        id: 2,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: token }),
        disabled_cause: null,
      },
    ]);
    fetchApi = mockFetch(
      new Map([
        [
          "https://cursor.com/api/usage-summary",
          () =>
            jsonResponse({
              membershipType: "unified_pro",
              individualUsage: {
                plan: { enabled: true, used: 1200, limit: 5000, totalPercentUsed: 24 },
                onDemand: { enabled: false, used: 0, limit: 0 },
              },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () =>
            jsonResponse({
              planInfo: {
                planName: "X Subscription",
                includedUsageResetsAt: "1790812800000",
              },
            }),
        ],
      ]),
    );

    const usage = await credentialProvider().fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      planLabel: "X Subscription",
      balances: [
        {
          id: "cursor_models",
          label: "Cursor Models",
          used: 12,
          remaining: 38,
          limit: 50,
          unit: "usd",
          resetsAt: "2026-10-01T00:00:00.000Z",
          tone: "ok",
        },
        {
          id: "prepaid_credit",
          label: "Prepaid credit",
          used: 0,
          remaining: 0,
          limit: 0,
          unit: "usd",
          resetsAt: null,
          tone: "danger",
        },
      ],
    });
  });

  it("falls back to the next candidate on 401 and resolves GetMe email for team spend when usage-summary fails", async () => {
    const expiredJwt = createJwt({
      sub: "auth0|expired",
      exp: Math.floor(Date.now() / 1000) - 600,
    });
    const freshJwt = createJwt({
      sub: "auth0|fresh",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    writeOmpAgentDb(homeDir, [
      {
        id: 1,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: expiredJwt }),
        disabled_cause: null,
      },
      {
        id: 2,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: freshJwt }),
        disabled_cause: null,
      },
    ]);
    fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get("Authorization") ?? "";
      const cookie = headers.get("Cookie") ?? "";
      if (url === "https://cursor.com/api/usage-summary") {
        if (cookie.includes("fresh")) return jsonResponse({}, 403);
        return jsonResponse({}, 401);
      }
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        if (auth === `Bearer ${expiredJwt}`) return jsonResponse({}, 401);
        return jsonResponse({});
      }
      if (url.endsWith("/GetMe")) {
        return jsonResponse({ email: "Me@Example.com" });
      }
      if (url.endsWith("/GetTeams")) {
        return jsonResponse({ teams: [{ id: 99 }] });
      }
      if (url.endsWith("/GetTeamSpend")) {
        return jsonResponse({
          teamMemberSpend: [
            { email: "me@example.com", overallSpendCents: 2500, effectivePerUserLimitDollars: 500 },
          ],
          nextCycleStart: "1790812800000",
        });
      }
      throw new Error(`Unexpected Cursor endpoint: ${url}`);
    }) as typeof fetch;

    const usage = await credentialProvider().fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      balances: [
        {
          id: "team_spend",
          used: 25,
          remaining: 475,
          limit: 500,
          unit: "usd",
        },
      ],
    });
  });

  it("creates separate fetchers when multiple Cursor accounts are stored in OMP agent.db", () => {
    writeOmpAgentDb(homeDir, [
      {
        id: 10,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: "tok-a", email: "a@example.com" }),
        disabled_cause: null,
      },
      {
        id: 11,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: "tok-b", email: "b@example.com" }),
        disabled_cause: null,
      },
      {
        id: 12,
        provider: "cursor",
        credential_type: "oauth",
        data: JSON.stringify({ access: "tok-c", email: "c@example.com" }),
        disabled_cause: "deleted by user",
      },
    ]);

    const fetchers = createStoredCursorQuotaProviders({
      logger: createLogger(),
      homeDir,
      platform: "linux",
      env: {},
    });

    expect(fetchers.map((fetcher) => [fetcher.providerId, fetcher.displayName])).toEqual([
      ["cursor:10", "Cursor · a@example.com"],
      ["cursor:11", "Cursor · b@example.com"],
    ]);
  });

  it("falls back to CURSOR_TOKEN when CURSOR_ACCESS_TOKEN is empty and ignores zero/whitespace resets", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "";
    process.env["CURSOR_TOKEN"] = "cursor_fallback_env_token";
    let authorization: string | null = null;
    fetchApi = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        planUsage: { totalSpend: 100, remaining: 900, limit: 1000 },
        billingCycleEnd: "   ",
      });
    }) as typeof fetch;

    const usage = await credentialProvider().fetchUsage();

    expect(authorization).toBe("Bearer cursor_fallback_env_token");
    expect(usage.balances?.[0]).toMatchObject({ id: "plan_usage", resetsAt: null });

    fetchApi = vi.fn(async () =>
      jsonResponse({
        planUsage: { totalSpend: 100, remaining: 900, limit: 1000 },
        billingCycleEnd: 0,
      }),
    ) as typeof fetch;

    const zeroUsage = await credentialProvider().fetchUsage();
    expect(zeroUsage.balances?.[0]).toMatchObject({ id: "plan_usage", resetsAt: null });
  });
});

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function writeOmpAgentDb(
  homeDir: string,
  rows: Array<{
    id: number;
    provider: string;
    credential_type: string;
    data: string;
    disabled_cause: string | null;
    identity_key?: string | null;
  }>,
): void {
  const directory = join(homeDir, ".omp", "agent");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "agent.db"));
  database.exec(`
    CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT DEFAULT NULL,
      identity_key TEXT DEFAULT NULL
    )
  `);
  const insert = database.prepare(
    "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.provider,
      row.credential_type,
      row.data,
      row.disabled_cause,
      row.identity_key ?? null,
    );
  }
  database.close();
}

function writeCursorStateDb(homeDir: string, rows: Record<string, string | Uint8Array>): void {
  const directory = join(homeDir, ".config", "Cursor", "User", "globalStorage");
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, "state.vscdb"));
  database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  database.close();
}

function writeCursorAuthJson(homeDir: string, accessToken: string): void {
  const directory = join(homeDir, ".config", "cursor");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "auth.json"), JSON.stringify({ accessToken }));
}
function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function createLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}
