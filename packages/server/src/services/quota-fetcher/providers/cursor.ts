import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { resolveOmpDiagnosticPaths } from "../../../server/agent/providers/omp/provider-config.js";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type {
  ProviderApiFetch,
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
} from "../provider.js";
import {
  ApiNumberSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  toIsoStringOrNull,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
} from "../usage.js";

const CURSOR_USAGE_ENDPOINT =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_USAGE_SUMMARY_ENDPOINT = "https://cursor.com/api/usage-summary";

const CursorUsageResponseSchema = z.object({
  planUsage: z
    .object({
      totalSpend: ApiNumberSchema,
      includedSpend: ApiNumberSchema.optional(),
      bonusSpend: ApiNumberSchema.optional(),
      remaining: ApiNumberSchema,
      limit: ApiNumberSchema,
    })
    .optional(),
  billingCycleStart: z.union([z.string(), z.number()]).nullable().optional(),
  billingCycleEnd: z.union([z.string(), z.number()]).nullable().optional(),
});

const CursorRequestUsageBucketSchema = z.object({
  numRequests: ApiNumberSchema,
  maxRequestUsage: ApiNumberSchema.nullable(),
});
const CursorTeamsResponseSchema = z.object({
  teams: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
    }),
  ),
});

const CursorTeamSpendResponseSchema = z.object({
  teamMemberSpend: z
    .array(
      z.object({
        email: z.string().optional(),
        spendCents: ApiNumberSchema.optional(),
        overallSpendCents: ApiNumberSchema.optional(),
        monthlyLimitDollars: ApiNumberSchema.optional(),
        effectivePerUserLimitDollars: ApiNumberSchema.optional(),
      }),
    )
    .optional(),
  nextCycleStart: z.union([z.string(), z.number()]).nullable().optional(),
});

const CursorPlanInfoResponseSchema = z.object({
  planInfo: z
    .object({
      planName: z.string().nullable().optional(),
      includedUsageResetsAt: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const CursorMeResponseSchema = z.object({
  email: z.string().optional(),
});

const CursorSummaryBucketSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    used: z.unknown().optional(),
    limit: z.unknown().optional(),
    remaining: z.unknown().optional(),
    autoPercentUsed: z.unknown().optional(),
    apiPercentUsed: z.unknown().optional(),
    totalPercentUsed: z.unknown().optional(),
  })
  .passthrough();

const CursorUsageSummarySchema = z
  .object({
    billingCycleStart: z.union([z.string(), z.number()]).nullable().optional(),
    billingCycleEnd: z.union([z.string(), z.number()]).nullable().optional(),
    membershipType: z.string().nullable().optional(),
    limitType: z.string().nullable().optional(),
    isUnlimited: z.boolean().nullable().optional(),
    individualUsage: z
      .object({
        overall: CursorSummaryBucketSchema.nullable().optional(),
        plan: CursorSummaryBucketSchema.nullable().optional(),
        onDemand: CursorSummaryBucketSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

type CursorSummaryBucket = z.infer<typeof CursorSummaryBucketSchema>;
type CursorUsageSummary = z.infer<typeof CursorUsageSummarySchema>;

const CursorLegacyAuthSchema = z.object({
  accessToken: z.unknown().optional(),
});

const StoredCursorOAuthSchema = z.object({
  access: z.unknown().optional(),
  email: z.unknown().optional(),
  expires: z.number().finite().optional(),
});

const StoredCursorApiKeySchema = z.object({
  key: z.unknown().optional(),
});

const StoredCursorRowSchema = z.object({
  id: z.number().int().positive(),
  credential_type: z.string(),
  data: z.string(),
  identity_key: z.unknown().optional(),
});

const SqliteTableColumnSchema = z.object({
  name: z.string(),
});

const JwtPayloadSchema = z.record(z.string(), z.unknown());

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export interface CursorCredentialCandidate {
  token: string;
  email: string | null;
  source: "env" | "omp" | "state_db" | "agent_auth";
  credentialId?: number;
}

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
  platform?: NodeJS.Platform;
  appDataDir?: string;
  env?: NodeJS.ProcessEnv;
  agentDbPath?: string;
  providerId?: string;
  displayName?: string;
  credential?: CursorCredentialCandidate;
}

const moduleRequire = createRequire(import.meta.url);

function openReadOnlySqlite(path: string): SqliteDatabase {
  const sqlite = moduleRequire("node:sqlite") as SqliteModule;
  return new sqlite.DatabaseSync(path, { readOnly: true });
}

function readItemTableValue(database: SqliteDatabase, key: string): unknown {
  const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  return row && typeof row === "object" && "value" in row ? row.value : undefined;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8").trim() || null;
  return null;
}

function isUsableAccessToken(value: unknown): string | null {
  const token = textValue(value);
  if (!token) return null;
  // Modern Cursor desktop encrypts tokens in state.vscdb with Electron safeStorage
  // and stores a "cursor-safe-..." payload rather than a bearer JWT.
  if (token.startsWith("cursor-safe-")) return null;
  return token;
}

function tokenFromLegacyValue(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  try {
    const parsed = CursorLegacyAuthSchema.safeParse(JSON.parse(text));
    return parsed.success ? isUsableAccessToken(parsed.data.accessToken) : null;
  } catch {
    return null;
  }
}

function tokenFromStateDatabase(path: string): string | null {
  const database = openReadOnlySqlite(path);
  try {
    const modernToken = isUsableAccessToken(readItemTableValue(database, "cursorAuth/accessToken"));
    if (modernToken) return modernToken;

    return tokenFromLegacyValue(readItemTableValue(database, "cursorAuthStatus"));
  } finally {
    database.close();
  }
}

function emailFromStateDatabase(path: string): string | null {
  const database = openReadOnlySqlite(path);
  try {
    return textValue(readItemTableValue(database, "cursorAuth/cachedEmail"))?.toLowerCase() ?? null;
  } finally {
    database.close();
  }
}

function cursorStateDatabasePath(input: {
  homeDir: string;
  platform: NodeJS.Platform;
  appDataDir?: string;
}): string {
  if (input.platform === "darwin") {
    return join(
      input.homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (input.platform === "win32") {
    return join(
      input.appDataDir ?? join(input.homeDir, "AppData", "Roaming"),
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  return join(input.homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function tokenFromAgentAuth(homeDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, ".config", "cursor", "auth.json"), "utf8"));
    const parsed = CursorLegacyAuthSchema.safeParse(raw);
    return parsed.success ? isUsableAccessToken(parsed.data.accessToken) : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const parsed = JwtPayloadSchema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function extractCursorUserId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const sub = typeof payload?.["sub"] === "string" ? payload["sub"].trim() : "";
  if (!sub) return null;
  const parts = sub.split("|");
  const userId = (parts.length > 1 ? parts[1] : sub)?.trim() ?? "";
  return userId || null;
}

function isTokenDefinitelyExpired(token: string, expiresMs: number | null, nowMs: number): boolean {
  const jwtExp = decodeJwtPayload(token)?.["exp"];
  if (typeof jwtExp === "number" && Number.isFinite(jwtExp)) {
    return jwtExp * 1000 <= nowMs;
  }
  return expiresMs !== null && Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function emailFromIdentityKey(identityKey: unknown): string | null {
  const text = textValue(identityKey);
  if (!text) return null;
  for (const part of text.split("|")) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().startsWith("email:")) {
      return textValue(trimmed.slice(6))?.toLowerCase() ?? null;
    }
  }
  return null;
}

function resolveAgentDbPath(options: {
  agentDbPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string {
  if (options.agentDbPath) return options.agentDbPath;
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  // Keep explicit-home unit tests isolated from host PI_CODING_AGENT_DIR / XDG overrides.
  const env = options.env ?? (options.homeDir !== undefined ? {} : process.env);
  return resolveOmpDiagnosticPaths(env, homeDir, platform).agentDb;
}

function parseStoredCursorRow(
  rawRow: unknown,
  nowMs: number,
): { candidate: CursorCredentialCandidate; expired: boolean } | null {
  const rowParsed = StoredCursorRowSchema.safeParse(rawRow);
  if (!rowParsed.success) return null;
  const row = rowParsed.data;

  let decoded: unknown;
  try {
    decoded = JSON.parse(row.data);
  } catch {
    return null;
  }

  const identityEmail = emailFromIdentityKey(row.identity_key);
  let token: string | null = null;
  let email: string | null = identityEmail;
  let expiresMs: number | null = null;

  if (row.credential_type === "oauth") {
    const parsed = StoredCursorOAuthSchema.safeParse(decoded);
    if (!parsed.success) return null;
    token = isUsableAccessToken(parsed.data.access);
    email = textValue(parsed.data.email)?.toLowerCase() ?? identityEmail;
    expiresMs = parsed.data.expires ?? null;
  } else if (row.credential_type === "api_key") {
    const parsed = StoredCursorApiKeySchema.safeParse(decoded);
    if (!parsed.success) return null;
    token = isUsableAccessToken(parsed.data.key);
  }

  if (!token) return null;
  return {
    candidate: {
      token,
      email,
      source: "omp",
      credentialId: row.id,
    },
    expired: isTokenDefinitelyExpired(token, expiresMs, nowMs),
  };
}

function readStoredCursorCredentials(
  agentDbPath: string,
  logger: Logger,
  nowMs = Date.now(),
): CursorCredentialCandidate[] {
  if (!existsSync(agentDbPath)) return [];
  try {
    const database = openReadOnlySqlite(agentDbPath);
    try {
      const columns = new Set(
        database
          .prepare("PRAGMA table_info(auth_credentials)")
          .all()
          .flatMap((row) => {
            const parsed = SqliteTableColumnSchema.safeParse(row);
            return parsed.success ? [parsed.data.name] : [];
          }),
      );
      const required = ["id", "provider", "credential_type", "data", "disabled_cause"];
      if (required.some((column) => !columns.has(column))) return [];

      const hasIdentityKey = columns.has("identity_key");
      const rows = database
        .prepare(
          `SELECT id, credential_type, data${hasIdentityKey ? ", identity_key" : ""}
           FROM auth_credentials
           WHERE provider = 'cursor' AND disabled_cause IS NULL
           ORDER BY id`,
        )
        .all();

      const fresh: CursorCredentialCandidate[] = [];
      const expired: CursorCredentialCandidate[] = [];
      for (const row of rows) {
        const entry = parseStoredCursorRow(row, nowMs);
        if (!entry) continue;
        if (entry.expired) {
          expired.push(entry.candidate);
        } else {
          fresh.push(entry.candidate);
        }
      }
      return [...fresh, ...expired];
    } finally {
      database.close();
    }
  } catch (err) {
    logger.debug({ err, path: agentDbPath }, "Failed to read Cursor credentials from OMP database");
    return [];
  }
}

export function createStoredCursorQuotaProviders(
  options: ProviderUsageFetcherFactoryOptions & {
    homeDir?: string;
    platform?: NodeJS.Platform;
    appDataDir?: string;
    agentDbPath?: string;
  },
): ProviderUsageFetcher[] {
  const env = options.env ?? process.env;
  if (isUsableAccessToken(env["CURSOR_ACCESS_TOKEN"]) ?? isUsableAccessToken(env["CURSOR_TOKEN"])) {
    return [new CursorQuotaProvider(options)];
  }
  const agentDbPath = resolveAgentDbPath(options);
  const stored = readStoredCursorCredentials(agentDbPath, options.logger);
  if (stored.length <= 1) {
    return [new CursorQuotaProvider(options)];
  }
  return stored.map(
    (credential, index) =>
      new CursorQuotaProvider({
        ...options,
        providerId: `cursor:${credential.credentialId}`,
        displayName: credential.email
          ? `Cursor · ${credential.email}`
          : `Cursor · Account #${index + 1}`,
        credential,
      }),
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cents(value: number): number {
  return value / 100;
}

function billingReset(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return toIsoStringOrNull(ms);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numericTimestamp = Number(trimmed);
  if (Number.isFinite(numericTimestamp)) {
    if (numericTimestamp <= 0) return null;
    const ms = numericTimestamp < 1_000_000_000_000 ? numericTimestamp * 1000 : numericTimestamp;
    return toIsoStringOrNull(ms);
  }
  return toIsoStringOrNull(Date.parse(trimmed));
}

function nextMonthlyReset(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const startIso = billingReset(value);
  if (!startIso) return null;
  const start = new Date(startIso);
  if (!Number.isFinite(start.getTime())) return null;
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
}

function parseCentsBucket(bucket: CursorSummaryBucket): {
  used: number;
  remaining: number | null;
  limit: number | null;
} | null {
  if (bucket.enabled === false) return null;

  const reportedUsed = finiteNumber(bucket.used);
  const reportedRemaining = finiteNumber(bucket.remaining);
  const hasValidUsed = reportedUsed !== null && reportedUsed >= 0;
  const hasValidRemaining = reportedRemaining !== null && reportedRemaining >= 0;
  const limit = finiteNumber(bucket.limit);

  if (bucket.limit == null) {
    if (!hasValidUsed) return null;
    return { used: cents(reportedUsed), remaining: null, limit: null };
  }

  if (limit === null || limit <= 0) return null;
  let used: number;
  if (reportedUsed !== null && reportedUsed > 0) {
    used = reportedUsed;
  } else if (hasValidRemaining && reportedRemaining < limit) {
    used = Math.max(0, limit - reportedRemaining);
  } else if (hasValidUsed) {
    used = reportedUsed;
  } else {
    return null;
  }

  const remaining = Math.max(0, limit - used);
  return {
    used: cents(used),
    remaining: cents(remaining),
    limit: cents(limit),
  };
}

function formatMembershipPlanLabel(
  membershipType: string | null | undefined,
  planName?: string | null,
): string | null {
  const explicit = planName?.trim();
  if (explicit) return explicit;
  switch (membershipType?.trim().toLowerCase()) {
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "pro_plus":
      return "Pro+";
    case "ultra":
      return "Ultra";
    case "free":
      return "Free";
    default:
      return null;
  }
}

function appendPercentPool(
  windows: ProviderUsageWindow[],
  balances: ProviderUsageBalance[],
  input: {
    id: string;
    label: string;
    pct: number;
    limitUsd: number | null;
    resetsAt: string | null;
  },
): void {
  const pct = Math.max(0, Math.min(100, input.pct));
  if (input.limitUsd !== null) {
    const used = input.limitUsd * (pct / 100);
    balances.push({
      id: input.id,
      label: input.label,
      used,
      remaining: Math.max(0, input.limitUsd - used),
      limit: input.limitUsd,
      unit: "usd",
      resetsAt: input.resetsAt,
      tone: toneFromUsedPct(pct),
    });
    return;
  }
  windows.push({
    id: input.id,
    label: input.label,
    usedPct: pct,
    remainingPct: Math.max(0, 100 - pct),
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(pct),
  });
}

function appendCentsBalance(
  balances: ProviderUsageBalance[],
  input: {
    id: string;
    label: string;
    bucket: { used: number; remaining: number | null; limit: number | null };
    resetsAt: string | null;
    toneWhenNoLimit?: ProviderUsageBalance["tone"];
  },
): void {
  balances.push({
    id: input.id,
    label: input.label,
    used: input.bucket.used,
    remaining: input.bucket.remaining,
    limit: input.bucket.limit,
    unit: "usd",
    resetsAt: input.resetsAt,
    tone:
      input.bucket.limit !== null
        ? toneFromUsedPct(usedPctOf(input.bucket.used, input.bucket.limit))
        : (input.toneWhenNoLimit ?? "default"),
  });
}

function collectUnifiedSummaryMeters(
  individual: NonNullable<CursorUsageSummary["individualUsage"]>,
  weeklyResetsAt: string | null,
): { windows: ProviderUsageWindow[]; balances: ProviderUsageBalance[] } {
  const windows: ProviderUsageWindow[] = [];
  const balances: ProviderUsageBalance[] = [];

  const plan = individual.plan ?? null;
  if (plan && plan.enabled !== false) {
    const limitCents = finiteNumber(plan.limit);
    const usedCents = finiteNumber(plan.used);
    const percent = finiteNumber(plan.totalPercentUsed);

    if (limitCents !== null && limitCents > 0) {
      const usedFraction = Math.max(
        percent !== null ? percent / 100 : 0,
        usedCents !== null ? usedCents / limitCents : 0,
        0,
      );
      const limit = cents(limitCents);
      const used = Math.min(limit, limit * usedFraction);
      balances.push({
        id: "cursor_models",
        label: "Cursor Models",
        used,
        remaining: Math.max(0, limit - used),
        limit,
        unit: "usd",
        resetsAt: weeklyResetsAt,
        tone: toneFromUsedPct(usedFraction * 100),
      });
    } else if (percent !== null) {
      appendPercentPool(windows, balances, {
        id: "cursor_models",
        label: "Cursor Models",
        pct: percent,
        limitUsd: null,
        resetsAt: weeklyResetsAt,
      });
    }
  }

  const onDemand = individual.onDemand ?? null;
  if (onDemand) {
    if (onDemand.enabled === false || finiteNumber(onDemand.limit) === 0) {
      balances.push({
        id: "prepaid_credit",
        label: "Prepaid credit",
        used: 0,
        remaining: 0,
        limit: 0,
        unit: "usd",
        resetsAt: null,
        tone: "danger",
      });
    } else {
      const credit = parseCentsBucket(onDemand);
      if (credit) {
        appendCentsBalance(balances, {
          id: "prepaid_credit",
          label: "Prepaid credit",
          bucket: credit,
          resetsAt: null,
          toneWhenNoLimit: balanceToneFromRemaining(credit.remaining),
        });
      }
    }
  }

  return { windows, balances };
}

function collectPlanRailMeters(
  plan: CursorSummaryBucket,
  monthlyResetsAt: string | null,
): { windows: ProviderUsageWindow[]; balances: ProviderUsageBalance[] } {
  const windows: ProviderUsageWindow[] = [];
  const balances: ProviderUsageBalance[] = [];
  if (plan.enabled === false) return { windows, balances };

  const limitCents = finiteNumber(plan.limit);
  const limitUsd = limitCents !== null && limitCents > 0 ? cents(limitCents) : null;
  const autoPct = finiteNumber(plan.autoPercentUsed);
  const apiPct = finiteNumber(plan.apiPercentUsed);
  const totalPct = finiteNumber(plan.totalPercentUsed);

  if (autoPct !== null) {
    appendPercentPool(windows, balances, {
      id: "cursor_models",
      label: "Cursor Models",
      pct: autoPct,
      limitUsd: null,
      resetsAt: monthlyResetsAt,
    });
  }
  if (apiPct !== null) {
    appendPercentPool(windows, balances, {
      id: "other_models",
      label: "Other Models",
      pct: apiPct,
      limitUsd,
      resetsAt: monthlyResetsAt,
    });
  }
  if (autoPct === null && apiPct === null) {
    if (totalPct !== null) {
      appendPercentPool(windows, balances, {
        id: limitUsd !== null ? "plan_usage" : "monthly",
        label: limitUsd !== null ? "Plan usage" : "Monthly",
        pct: totalPct,
        limitUsd,
        resetsAt: monthlyResetsAt,
      });
    } else {
      const planBucket = parseCentsBucket(plan);
      if (planBucket) {
        appendCentsBalance(balances, {
          id: "plan_usage",
          label: "Plan usage",
          bucket: planBucket,
          resetsAt: monthlyResetsAt,
        });
      }
    }
  }

  return { windows, balances };
}

function collectStandardSummaryMeters(
  summary: CursorUsageSummary,
  monthlyResetsAt: string | null,
): { windows: ProviderUsageWindow[]; balances: ProviderUsageBalance[] } {
  const individual = summary.individualUsage!;
  const isTeam =
    summary.limitType === "team" ||
    summary.membershipType === "enterprise" ||
    summary.membershipType === "team";

  let windows: ProviderUsageWindow[] = [];
  let balances: ProviderUsageBalance[] = [];

  const overallBucket = individual.overall ? parseCentsBucket(individual.overall) : null;
  if (overallBucket) {
    appendCentsBalance(balances, {
      id: isTeam ? "team_spend" : "plan_usage",
      label: isTeam ? "Monthly usage" : "Plan usage",
      bucket: overallBucket,
      resetsAt: monthlyResetsAt,
    });
  } else if (individual.plan) {
    ({ windows, balances } = collectPlanRailMeters(individual.plan, monthlyResetsAt));
  }

  if (individual.onDemand) {
    const onDemandBucket = parseCentsBucket(individual.onDemand);
    if (
      onDemandBucket &&
      ((onDemandBucket.limit !== null && onDemandBucket.limit > 0) || onDemandBucket.used > 0)
    ) {
      appendCentsBalance(balances, {
        id: "on_demand",
        label: "On-demand usage",
        bucket: onDemandBucket,
        resetsAt: monthlyResetsAt,
      });
    }
  }

  return { windows, balances };
}

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly appDataDir: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly agentDbPath: string;
  private readonly pinnedCredential: CursorCredentialCandidate | undefined;

  constructor(options: CursorQuotaProviderOptions) {
    this.providerId = options.providerId ?? "cursor";
    this.displayName = options.displayName ?? "Cursor";
    this.logger = options.logger.child({ providerId: this.providerId });
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.appDataDir = options.appDataDir ?? process.env["APPDATA"];
    this.env = options.env;
    this.agentDbPath = resolveAgentDbPath(options);
    this.pinnedCredential = options.credential;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const candidates = this.pinnedCredential ? [this.pinnedCredential] : this.readCandidates();
    if (candidates.length === 0) return unavailableUsage(this);

    for (const candidate of candidates) {
      const outcome = await this.fetchUsageForCandidate(candidate);
      if (outcome.kind === "unauthorized") continue;
      return outcome.usage;
    }

    return unavailableUsage(this);
  }

  private async fetchUsageForCandidate(
    candidate: CursorCredentialCandidate,
  ): Promise<{ kind: "ok"; usage: ProviderUsage } | { kind: "unauthorized" }> {
    const summaryOutcome = await this.fetchUsageSummary(candidate.token);
    if (summaryOutcome.kind === "ok") {
      return { kind: "ok", usage: summaryOutcome.usage };
    }

    const response = await fetchProviderApi(this.fetchApi, CURSOR_USAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${candidate.token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized" };
      }
      throw new Error(`Cursor usage request failed with HTTP ${response.status}`);
    }

    const payload = CursorUsageResponseSchema.parse(await response.json());
    if (!payload.planUsage) {
      try {
        const teamBalance = await this.fetchTeamSpendBalance(candidate.token, candidate.email);
        if (teamBalance) {
          return {
            kind: "ok",
            usage: {
              providerId: this.providerId,
              displayName: this.displayName,
              status: "available",
              planLabel: null,
              sourceLabel: "Cursor",
              windows: [],
              balances: [teamBalance],
              details: [],
              error: null,
            },
          };
        }
      } catch (err) {
        this.logger.debug({ err }, "Failed to fetch Cursor team spend");
      }
      return this.fetchRequestUsage(candidate.token, billingReset(payload.billingCycleEnd));
    }

    const used = cents(payload.planUsage.totalSpend);
    const remaining = cents(payload.planUsage.remaining);
    const limit = cents(payload.planUsage.limit);
    const usedPct = usedPctOf(used, limit);

    return {
      kind: "ok",
      usage: {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel: null,
        sourceLabel: "Cursor",
        windows: [],
        balances: [
          {
            id: "plan_usage",
            label: "Plan usage",
            used,
            remaining,
            limit,
            unit: "usd",
            resetsAt: billingReset(payload.billingCycleEnd),
            tone: toneFromUsedPct(usedPct),
          },
        ],
        details: [],
        error: null,
      },
    };
  }

  private async fetchUsageSummary(
    token: string,
  ): Promise<{ kind: "ok"; usage: ProviderUsage } | { kind: "skip" }> {
    const userId = extractCursorUserId(token);
    if (!userId) return { kind: "skip" };

    let response: Response;
    try {
      response = await fetchProviderApi(this.fetchApi, CURSOR_USAGE_SUMMARY_ENDPOINT, {
        headers: {
          Accept: "application/json",
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
        },
      });
    } catch (err) {
      this.logger.debug({ err }, "Cursor usage summary request error");
      return { kind: "skip" };
    }

    if (!response.ok) {
      this.logger.debug({ status: response.status }, "Cursor usage summary request failed");
      return { kind: "skip" };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      this.logger.debug({ err }, "Cursor usage summary returned invalid JSON");
      return { kind: "skip" };
    }

    const parsed = CursorUsageSummarySchema.safeParse(raw);
    if (!parsed.success || !parsed.data.individualUsage) {
      return { kind: "skip" };
    }

    const summary = parsed.data;
    const isUnified =
      typeof summary.membershipType === "string" && summary.membershipType.startsWith("unified_");
    const planInfo = isUnified ? await this.fetchPlanInfo(token) : null;
    const usage = this.buildSummaryUsage(summary, planInfo);
    return usage ? { kind: "ok", usage } : { kind: "skip" };
  }

  private buildSummaryUsage(
    summary: CursorUsageSummary,
    planInfo: { planName: string | null; weeklyResetsAt: string | null } | null,
  ): ProviderUsage | null {
    const individual = summary.individualUsage;
    if (!individual) return null;

    const isUnified =
      typeof summary.membershipType === "string" && summary.membershipType.startsWith("unified_");
    const { windows, balances } = isUnified
      ? collectUnifiedSummaryMeters(individual, planInfo?.weeklyResetsAt ?? null)
      : collectStandardSummaryMeters(
          summary,
          billingReset(summary.billingCycleEnd) ?? nextMonthlyReset(summary.billingCycleStart),
        );

    if (windows.length === 0 && balances.length === 0) {
      return null;
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: formatMembershipPlanLabel(summary.membershipType, planInfo?.planName),
      sourceLabel: "Cursor",
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async fetchPlanInfo(
    token: string,
  ): Promise<{ planName: string | null; weeklyResetsAt: string | null } | null> {
    try {
      const response = await this.fetchDashboardRpc(token, "GetPlanInfo", {});
      if (!response.ok) return null;
      const parsed = CursorPlanInfoResponseSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.planInfo) return null;
      return {
        planName: parsed.data.planInfo.planName?.trim() || null,
        weeklyResetsAt: billingReset(parsed.data.planInfo.includedUsageResetsAt),
      };
    } catch {
      return null;
    }
  }

  private async fetchAccountEmail(token: string): Promise<string | null> {
    try {
      const response = await this.fetchDashboardRpc(token, "GetMe", {});
      if (!response.ok) return null;
      const parsed = CursorMeResponseSchema.safeParse(await response.json());
      return parsed.success ? (textValue(parsed.data.email)?.toLowerCase() ?? null) : null;
    } catch {
      return null;
    }
  }

  private async fetchTeamSpendBalance(
    token: string,
    candidateEmail: string | null,
  ): Promise<ProviderUsageBalance | null> {
    const email = candidateEmail ?? this.readCachedEmail() ?? (await this.fetchAccountEmail(token));
    if (!email) return null;

    const teamsResponse = await this.fetchDashboardRpc(token, "GetTeams", {});
    if (!teamsResponse.ok) {
      throw new Error(`Cursor teams request failed with HTTP ${teamsResponse.status}`);
    }
    const { teams } = CursorTeamsResponseSchema.parse(await teamsResponse.json());

    for (const team of teams) {
      const spendResponse = await this.fetchDashboardRpc(token, "GetTeamSpend", {
        teamId: team.id,
      });
      if (!spendResponse.ok) continue;

      const payload = CursorTeamSpendResponseSchema.parse(await spendResponse.json());
      const member = payload.teamMemberSpend?.find(
        (candidate) => candidate.email?.trim().toLowerCase() === email,
      );
      const spendCents = member?.spendCents ?? member?.overallSpendCents;
      if (spendCents == null) continue;

      const used = cents(spendCents);
      const limit = member?.effectivePerUserLimitDollars ?? member?.monthlyLimitDollars ?? null;
      return {
        id: "team_spend",
        label: "Monthly usage",
        used,
        remaining: limit == null ? null : Math.max(0, limit - used),
        limit,
        unit: "usd",
        resetsAt: billingReset(payload.nextCycleStart),
        tone: toneFromUsedPct(usedPctOf(used, limit)),
      };
    }
    return null;
  }

  private fetchDashboardRpc(
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetchProviderApi(
      this.fetchApi,
      `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify(body),
      },
    );
  }

  private async fetchRequestUsage(
    token: string,
    resetsAt: string | null,
  ): Promise<{ kind: "ok"; usage: ProviderUsage } | { kind: "unauthorized" }> {
    const response = await fetchProviderApi(this.fetchApi, "https://api2.cursor.sh/auth/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized" };
      }
      throw new Error(`Cursor request usage failed with HTTP ${response.status}`);
    }

    const payload = z.record(z.string(), z.unknown()).parse(await response.json());
    const buckets = Object.entries(payload).flatMap(([model, value]) => {
      const parsed = CursorRequestUsageBucketSchema.safeParse(value);
      return parsed.success ? [{ model, ...parsed.data }] : [];
    });
    const bucket =
      buckets.find((candidate) => candidate.maxRequestUsage != null) ?? buckets.at(0) ?? null;
    if (!bucket) return { kind: "ok", usage: unavailableUsage(this) };

    const limit = bucket.maxRequestUsage;
    const remaining = limit == null ? null : Math.max(0, limit - bucket.numRequests);
    return {
      kind: "ok",
      usage: {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel: null,
        sourceLabel: "Cursor",
        windows: [],
        balances: [
          {
            id: "monthly_requests",
            label: "Monthly requests",
            used: bucket.numRequests,
            remaining,
            limit,
            unit: "requests",
            resetsAt: nextMonthlyReset(payload["startOfMonth"]) ?? resetsAt,
            tone: toneFromUsedPct(usedPctOf(bucket.numRequests, limit)),
          },
        ],
        details: [{ id: "model", label: "Model", value: bucket.model }],
        error: null,
      },
    };
  }

  private readCachedEmail(): string | null {
    const path = cursorStateDatabasePath({
      homeDir: this.homeDir,
      platform: this.platform,
      appDataDir: this.appDataDir,
    });
    try {
      return emailFromStateDatabase(path);
    } catch (err) {
      this.logger.debug({ err, path }, "Failed to read Cursor email from state database");
      return null;
    }
  }

  private readCandidates(): CursorCredentialCandidate[] {
    const candidates: CursorCredentialCandidate[] = [];
    const seenTokens = new Set<string>();
    const addCandidate = (candidate: CursorCredentialCandidate | null) => {
      if (!candidate || seenTokens.has(candidate.token)) return;
      seenTokens.add(candidate.token);
      candidates.push(candidate);
    };

    const env = this.env ?? process.env;
    const envToken =
      isUsableAccessToken(env["CURSOR_ACCESS_TOKEN"]) ?? isUsableAccessToken(env["CURSOR_TOKEN"]);
    if (envToken) {
      addCandidate({ token: envToken, email: null, source: "env" });
    }

    for (const stored of readStoredCursorCredentials(this.agentDbPath, this.logger)) {
      addCandidate(stored);
    }

    const stateDbPath = cursorStateDatabasePath({
      homeDir: this.homeDir,
      platform: this.platform,
      appDataDir: this.appDataDir,
    });
    try {
      const stateToken = tokenFromStateDatabase(stateDbPath);
      if (stateToken) {
        addCandidate({
          token: stateToken,
          email: this.readCachedEmail(),
          source: "state_db",
        });
      }
    } catch (err) {
      this.logger.debug(
        { err, path: stateDbPath },
        "Failed to read Cursor token from state database",
      );
    }

    const cliToken = tokenFromAgentAuth(this.homeDir);
    if (cliToken) {
      addCandidate({ token: cliToken, email: null, source: "agent_auth" });
    }

    return candidates;
  }
}
