import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";

type UsageValues = Pick<
  OmpProviderAccountQuota,
  | "planLabel"
  | "fiveHourUsedPct"
  | "fiveHourLimitReached"
  | "fiveHourResetsAt"
  | "weeklyUsedPct"
  | "weeklyResetsAt"
>;

interface SuccessfulUsage {
  values: UsageValues;
  fetchedAt: string;
}

interface AccountState {
  sequence: number;
  revision: number;
  successfulUsage?: SuccessfulUsage;
  quota?: OmpProviderAccountQuota;
}

interface QuotaRead {
  key: string;
  state: AccountState;
  sequence: number;
  revision: number;
}

export class CodexQuotaState {
  private readonly accounts = new Map<string, AccountState>();

  retainAccounts(keys: ReadonlySet<string>): void {
    for (const key of this.accounts.keys()) {
      if (!keys.has(key)) this.accounts.delete(key);
    }
  }

  beginRead(key: string): QuotaRead {
    let state = this.accounts.get(key);
    if (!state) {
      state = { sequence: 0, revision: 0 };
      this.accounts.set(key, state);
    }
    return { key, state, sequence: ++state.sequence, revision: state.revision };
  }

  completeRead(
    read: QuotaRead,
    quota: OmpProviderAccountQuota,
  ): OmpProviderAccountQuota | undefined {
    const state = this.accounts.get(read.key);
    // Deleted/replaced credentials cannot repopulate history or return their old inventory.
    if (state !== read.state) return undefined;
    // Ignore an older request, including requests begun before a successful reset.
    if (read.sequence !== state.sequence || read.revision !== state.revision) return state.quota;

    if (quota.status === "available") {
      // A partial success replaces the whole observation; absent windows stay absent.
      state.successfulUsage =
        quota.fetchedAt && (quota.fiveHourUsedPct != null || quota.weeklyUsedPct != null)
          ? {
              fetchedAt: quota.fetchedAt,
              values: {
                planLabel: quota.planLabel,
                fiveHourUsedPct: quota.fiveHourUsedPct,
                fiveHourLimitReached: quota.fiveHourLimitReached,
                fiveHourResetsAt: quota.fiveHourResetsAt,
                weeklyUsedPct: quota.weeklyUsedPct,
                weeklyResetsAt: quota.weeklyResetsAt,
              },
            }
          : undefined;
    } else if (quota.queryError?.kind === "authentication" || quota.status === "unavailable") {
      state.successfulUsage = undefined;
    } else if (state.successfulUsage) {
      quota = {
        ...quota,
        ...state.successfulUsage.values,
        lastSuccessfulAt: state.successfulUsage.fetchedAt,
      };
    }
    // Latest status/error/inventory always come from this attempt, never from history.
    state.quota = quota;
    return quota;
  }

  invalidate(key: string): void {
    const state = this.accounts.get(key);
    if (!state) return;
    state.revision++;
    state.successfulUsage = undefined;
    state.quota = undefined;
  }
}
