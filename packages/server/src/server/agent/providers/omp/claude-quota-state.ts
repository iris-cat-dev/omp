import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { parseClaudeRetryAt } from "./claude-oauth-api.js";

interface ClaudeModelCompletion {
  provider?: string;
  stopReason?: string;
  errorStatus?: number | null;
  errorMessage?: string | null;
}

interface ExhaustedWindow {
  resetsAt: string | null;
  source: "usage" | "model";
  observedAt: number;
}

interface AccountState {
  revision: number;
  readSequence: number;
  quota?: OmpProviderAccountQuota;
  fiveHour?: ExhaustedWindow;
  modelRateLimit?: NonNullable<OmpProviderAccountQuota["modelRateLimit"]>;
}

interface QuotaRead {
  key: string;
  state: AccountState;
  revision: number;
  sequence: number;
}

function isFreshReset(resetsAt: string | null, now: number): boolean {
  return resetsAt !== null && Date.parse(resetsAt) > now;
}

function explicitScope(message: string): "five_hour" | "seven_day" | "unknown" {
  // Native errors currently carry HTTP status and formatted body text, not a
  // declared window field. Require an explicit exhausted-window statement.
  const five =
    /(?:five[_ -]hour|5[_ -]hour)\s+(?:limit|quota)\s+(?:has been\s+)?(?:reached|exceeded|exhausted|full)|(?:reached|exceeded|exhausted|hit)\s+(?:your\s+)?(?:five[_ -]hour|5[_ -]hour)\s+(?:limit|quota)/i.test(
      message,
    );
  const weekly =
    /(?:seven[_ -]day|7[_ -]day|weekly)\s+(?:limit|quota)\s+(?:has been\s+)?(?:reached|exceeded|exhausted|full)|(?:reached|exceeded|exhausted|hit)\s+(?:your\s+)?(?:seven[_ -]day|7[_ -]day|weekly)\s+(?:limit|quota)/i.test(
      message,
    );
  if (five === weekly) return "unknown";
  return five ? "five_hour" : "seven_day";
}

export class ClaudeQuotaState {
  private readonly accounts = new Map<string, AccountState>();

  constructor(private readonly now: () => number = Date.now) {}

  retainAccounts(keys: ReadonlySet<string>): void {
    for (const key of this.accounts.keys()) {
      if (!keys.has(key)) this.accounts.delete(key);
    }
  }

  private account(key: string): AccountState {
    let state = this.accounts.get(key);
    if (!state) {
      state = { revision: 0, readSequence: 0 };
      this.accounts.set(key, state);
    }
    return state;
  }

  beginRead(key: string): QuotaRead {
    const state = this.account(key);
    return { key, state, revision: state.revision, sequence: ++state.readSequence };
  }

  completeRead(read: QuotaRead, quota: OmpProviderAccountQuota): OmpProviderAccountQuota {
    const state = this.accounts.get(read.key);
    // A newer account read or credential deletion supersedes this response.
    if (state !== read.state) return quota;
    if (read.sequence !== state.readSequence) return this.merge(state, state.quota ?? quota);
    const now = this.now();
    const unchanged = read.revision === state.revision;
    if (unchanged && quota.status === "available") this.reconcileAvailableQuota(state, quota, now);
    // Never present an old in-flight observation as fresh model recovery.
    const current = !unchanged
      ? {
          ...quota,
          fiveHourUsedPct: null,
          fiveHourLimitReached: null,
          fiveHourResetsAt: null,
          weeklyUsedPct: null,
          weeklyResetsAt: null,
          modelWindows: undefined,
        }
      : quota;
    state.quota = current;
    return this.merge(state, current);
  }

  private reconcileAvailableQuota(
    state: AccountState,
    quota: OmpProviderAccountQuota,
    now: number,
  ): void {
    if (
      quota.fiveHourUsedPct != null &&
      (quota.fiveHourResetsAt == null || isFreshReset(quota.fiveHourResetsAt, now))
    ) {
      state.fiveHour =
        quota.fiveHourUsedPct >= 100
          ? { resetsAt: quota.fiveHourResetsAt ?? null, observedAt: now, source: "usage" }
          : undefined;
      if (state.modelRateLimit?.scope === "five_hour" && quota.fiveHourUsedPct < 100) {
        state.modelRateLimit = undefined;
      }
    } else if (quota.fiveHourLimitReached === true) {
      state.fiveHour = {
        resetsAt: quota.fiveHourResetsAt ?? null,
        observedAt: now,
        source: "usage",
      };
    }
    if (
      state.modelRateLimit?.scope === "seven_day" &&
      quota.weeklyUsedPct != null &&
      quota.weeklyUsedPct < 100 &&
      (quota.weeklyResetsAt == null || isFreshReset(quota.weeklyResetsAt, now))
    ) {
      state.modelRateLimit = undefined;
    }
  }

  observeCompletion(key: string, message: ClaudeModelCompletion): void {
    if (message.provider !== "anthropic" || message.stopReason === "aborted") return;
    const state = this.account(key);
    if (message.stopReason === "error" && message.errorStatus === 429) {
      this.observeRateLimit(state, message.errorMessage ?? "");
    } else if (
      message.stopReason &&
      ["stop", "length", "toolUse"].includes(message.stopReason) &&
      !message.errorStatus &&
      !message.errorMessage
    ) {
      // An actual successful same-account model response is recovery evidence.
      state.modelRateLimit = undefined;
      if (state.fiveHour?.source === "model") state.fiveHour = undefined;
      state.revision++;
    }
  }

  private observeRateLimit(state: AccountState, text: string): void {
    const now = this.now();
    const retry = /\bretry-after-ms\s*=\s*(\d+(?:\.\d+)?)(?=\s|$|[;,])/i.exec(text);
    const retryAt = retry
      ? parseClaudeRetryAt(new Headers({ "retry-after-ms": retry[1]! }), now)
      : null;
    let scope = explicitScope(text);
    if (
      scope === "unknown" &&
      state.fiveHour &&
      now - state.fiveHour.observedAt <= 5 * 60_000 &&
      (state.fiveHour.resetsAt === null || isFreshReset(state.fiveHour.resetsAt, now))
    ) {
      scope = "five_hour";
    }
    state.modelRateLimit = {
      scope,
      resetsAt:
        scope === "five_hour" && isFreshReset(state.fiveHour?.resetsAt ?? null, now)
          ? state.fiveHour!.resetsAt
          : retryAt,
      observedAt: new Date(now).toISOString(),
    };
    if (scope === "five_hour" && state.fiveHour?.source !== "usage") {
      state.fiveHour = {
        resetsAt: state.modelRateLimit.resetsAt,
        observedAt: now,
        source: "model",
      };
    }
    state.revision++;
  }

  private merge(state: AccountState, quota: OmpProviderAccountQuota): OmpProviderAccountQuota {
    const fiveHour =
      state.modelRateLimit?.scope === "five_hour" ? state.modelRateLimit : state.fiveHour;
    return {
      ...quota,
      ...(fiveHour
        ? {
            fiveHourLimitReached: true,
            fiveHourResetsAt: fiveHour.resetsAt,
            // Failed or stale queries cannot manufacture a fresh percentage.
            ...(state.modelRateLimit?.scope === "five_hour" ||
            quota.status !== "available" ||
            quota.fiveHourUsedPct !== 100
              ? { fiveHourUsedPct: null }
              : {}),
          }
        : {}),
      ...(state.modelRateLimit ? { modelRateLimit: state.modelRateLimit } : {}),
    };
  }
}
