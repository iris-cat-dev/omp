import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorQuotaProvider } from "./cursor.js";

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
        const body = JSON.parse(String(init?.body)) as { teamId: number };
        if (body.teamId === 10) {
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
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
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
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
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
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
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
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
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
    const logger = createLogger();
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
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("state.vscdb") }),
      expect.stringContaining("Failed to read Cursor token"),
    );
  });
});

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
