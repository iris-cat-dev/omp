import type { TFunction } from "i18next";
import type {
  OmpProviderAccountQuota,
  OmpProviderManagement,
} from "@omp-desktop/protocol/messages";
import { formatOmpAccountSelectionLabel } from "@/components/omp-provider-accounts";
import {
  formatOmpAccountPlanLabel,
  formatOmpCodexCreditBalance,
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "@/components/omp-provider-quota";
import type { OmpAccountQuotaDisplayAccount } from "@/hooks/use-omp-account-quota";
import type { ProviderUsage, ProviderUsageView, ProviderUsageWindow } from "./types";

type OmpLoginProvider = OmpProviderManagement["loginProviders"][number];

export type OmpAccountUsageCopy = {
  providerName: string;
  accountFallback: (number: number) => string;
  fiveHour: string;
  weekly: string;
  modelWeekly: (model: string) => string;
} & (
  | {
      providerId: "openai-codex";
      codexCreditsLabel: string;
      codexCreditsSummary: (credits: OmpProviderAccountQuota["credits"]) => string;
    }
  | { providerId: "anthropic" }
);

export function formatOmpModelQuotaLabel(model: string, t: TFunction): string {
  const name = model === "opus" || model === "sonnet" ? t(`providerUsage.models.${model}`) : model;
  return t("providerUsage.modelWeekly", { model: name });
}

export function createOmpAccountUsageCopy(
  providerId: OmpAccountUsageCopy["providerId"],
  t: TFunction,
): OmpAccountUsageCopy {
  if (providerId === "anthropic") {
    return {
      providerId,
      providerName: "Claude",
      accountFallback: (number) => t("agentControls.quota.account", { number }),
      fiveHour: t("agentControls.quota.fiveHour"),
      weekly: t("agentControls.quota.weekly"),
      modelWeekly: (model) => formatOmpModelQuotaLabel(model, t),
    };
  }
  return {
    providerId,
    providerName: "OpenAI Codex",
    accountFallback: (number) => t("agentControls.quota.account", { number }),
    fiveHour: t("agentControls.quota.fiveHour"),
    weekly: t("agentControls.quota.weekly"),
    modelWeekly: (model) => formatOmpModelQuotaLabel(model, t),
    codexCreditsLabel: t("settings.providers.omp.codexQuota.credits"),
    codexCreditsSummary: (credits) => formatOmpCodexCreditBalance(credits, t),
  };
}

export interface OmpAccountUsageSource {
  provider: OmpLoginProvider | null;
  accounts: readonly OmpAccountQuotaDisplayAccount[];
  error: string | null;
  updatedAt: string | null;
}

function quotaWindow(input: {
  id: string;
  label: string;
  usedPct: number | null | undefined;
  resetsAt: string | null | undefined;
  alwaysShow?: boolean;
  limitReached?: boolean;
}): ProviderUsageWindow | null {
  const remainingPct = resolveOmpRemainingQuotaPct(input.usedPct);
  if (remainingPct === null && input.resetsAt == null && !input.alwaysShow && !input.limitReached)
    return null;
  return {
    id: input.id,
    label: input.label,
    usedPct: remainingPct === null ? null : input.usedPct,
    remainingPct,
    resetsAt: input.resetsAt,
    percentageDisplay: "remaining",
    limitReached: input.limitReached,
  };
}

function unavailableAccountUsage(input: {
  providerId: string;
  displayName: string;
  sourceLabel: string;
  status: "unavailable" | "error";
  error?: string | null;
  fetchedAt: string | null;
}): ProviderUsage {
  return {
    providerId: input.providerId,
    displayName: input.displayName,
    status: input.status,
    planLabel: null,
    sourceLabel: input.sourceLabel,
    fetchedAt: input.fetchedAt,
    windows: [],
    balances: [],
    details: [],
    error: input.error ?? null,
  };
}

function accountWindows(
  quota: OmpProviderAccountQuota | undefined,
  copy: OmpAccountUsageCopy,
): ProviderUsageWindow[] {
  const prefix = copy.providerId === "openai-codex" ? "codex" : "anthropic";
  const windows = [
    shouldShowOmpFiveHourQuota(quota, copy.providerId)
      ? quotaWindow({
          id: `${prefix}_five_hour`,
          label: copy.fiveHour,
          usedPct: quota?.fiveHourUsedPct,
          resetsAt: quota?.fiveHourResetsAt,
          alwaysShow: copy.providerId === "anthropic",
          limitReached: copy.providerId === "anthropic" && quota?.fiveHourLimitReached === true,
        })
      : null,
    quotaWindow({
      id: `${prefix}_weekly`,
      label: copy.weekly,
      usedPct: quota?.weeklyUsedPct,
      resetsAt: quota?.weeklyResetsAt,
      alwaysShow: copy.providerId === "openai-codex",
    }),
    ...(quota?.modelWindows ?? []).map((window) => {
      const remainingPct = resolveOmpRemainingQuotaPct(window.usedPct);
      return {
        id: `${copy.providerId}_weekly_${window.model}`,
        label: copy.modelWeekly(window.model),
        usedPct: remainingPct === null ? null : window.usedPct,
        remainingPct,
        resetsAt: window.resetsAt,
        percentageDisplay: "remaining" as const,
      };
    }),
  ];
  return windows.filter((window): window is ProviderUsageWindow => window !== null);
}

function accountQuotaObservation(
  source: OmpAccountUsageSource,
  quota: OmpProviderAccountQuota | undefined,
): OmpProviderAccountQuota | undefined {
  return {
    ...quota,
    status: source.error ? "error" : (quota?.status ?? "unavailable"),
    queryError: source.error ? undefined : quota?.queryError,
    error: source.error ?? quota?.error,
  };
}

export function buildOmpAccountProviderUsage(
  source: OmpAccountUsageSource,
  copy: OmpAccountUsageCopy,
): ProviderUsage[] {
  const providerName = copy.providerName;
  if (source.error && source.accounts.length === 0) {
    return [
      unavailableAccountUsage({
        providerId: copy.providerId,
        displayName: providerName,
        sourceLabel: providerName,
        status: "error",
        error: source.error,
        fetchedAt: source.updatedAt,
      }),
    ];
  }
  if (!source.provider) return [];
  if (source.accounts.length === 0) {
    return [
      unavailableAccountUsage({
        providerId: copy.providerId,
        displayName: providerName,
        sourceLabel: providerName,
        status: "unavailable",
        fetchedAt: source.updatedAt,
      }),
    ];
  }

  return source.accounts.map((account, index) => {
    const quota = account.quota;
    const accountLabel = formatOmpAccountSelectionLabel({
      note: account.note,
      identityKey: account.identityKey,
      fallback: copy.accountFallback(account.accountNumber ?? index + 1),
    });

    return {
      providerId: `${copy.providerId}:${account.credentialId}`,
      displayName: `${providerName} · ${accountLabel}`,
      status: source.error ? "error" : (quota?.status ?? "unavailable"),
      planLabel: formatOmpAccountPlanLabel(copy.providerId, quota?.planLabel),
      sourceLabel: providerName,
      fetchedAt: quota?.fetchedAt ?? source.updatedAt,
      windows: accountWindows(quota, copy),
      balances: [],
      details:
        copy.providerId === "openai-codex"
          ? [
              {
                id: "codex_credits",
                label: copy.codexCreditsLabel,
                value: copy.codexCreditsSummary(quota?.credits),
              },
            ]
          : [],
      extraUsage: quota?.extraUsage,
      accountQuota: accountQuotaObservation(source, quota),
      error: source.error ?? quota?.error ?? null,
    };
  });
}

export function mergeOmpAccountProviderUsage(
  view: ProviderUsageView,
  accountProviders: readonly ProviderUsage[],
  loading: boolean,
  updatedAt: string | null,
): ProviderUsageView {
  if (accountProviders.length === 0) {
    if (view.kind !== "ready" || !loading) return view;
    return { ...view, isRefreshing: true };
  }
  if (view.kind === "ready") {
    const replacedIds = new Set(
      accountProviders.map((provider) => provider.providerId.split(":")[0]),
    );
    const otherProviders = view.payload.providers.filter(
      (provider) => !replacedIds.has(provider.providerId.split(":")[0]),
    );
    return {
      kind: "ready",
      payload: { ...view.payload, providers: [...accountProviders, ...otherProviders] },
      isRefreshing: view.isRefreshing || loading,
    };
  }
  if (!updatedAt) return view;
  return {
    kind: "ready",
    payload: { fetchedAt: updatedAt, providers: [...accountProviders] },
    isRefreshing: loading || view.kind === "loading",
  };
}
