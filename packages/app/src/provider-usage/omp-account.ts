import type { TFunction } from "i18next";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { formatOmpAccountSelectionLabel } from "@/components/omp-provider-accounts";
import {
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "@/components/omp-provider-quota";
import type { OmpAccountQuotaDisplayAccount } from "@/hooks/use-omp-account-quota";
import type { ProviderUsage, ProviderUsageView, ProviderUsageWindow } from "./types";

type OmpLoginProvider = OmpProviderManagement["loginProviders"][number];

export interface OmpAccountUsageCopy {
  providerId: "openai-codex" | "anthropic";
  providerName: string;
  accountFallback: (number: number) => string;
  fiveHour: string;
  weekly: string;
  modelWeekly: (model: string) => string;
}

export function formatOmpModelQuotaLabel(model: string, t: TFunction): string {
  const name = model === "opus" || model === "sonnet" ? t(`providerUsage.models.${model}`) : model;
  return t("providerUsage.modelWeekly", { model: name });
}

export function createOmpAccountUsageCopy(
  providerId: OmpAccountUsageCopy["providerId"],
  t: TFunction,
): OmpAccountUsageCopy {
  return {
    providerId,
    providerName: providerId === "anthropic" ? "Claude" : "OpenAI Codex",
    accountFallback: (number) => t("agentControls.quota.account", { number }),
    fiveHour: t("agentControls.quota.fiveHour"),
    weekly: t("agentControls.quota.weekly"),
    modelWeekly: (model) => formatOmpModelQuotaLabel(model, t),
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
}): ProviderUsageWindow | null {
  const remainingPct = resolveOmpRemainingQuotaPct(input.usedPct);
  if (remainingPct === null && input.resetsAt == null) return null;
  return {
    id: input.id,
    label: input.label,
    usedPct: remainingPct === null ? null : input.usedPct,
    remainingPct,
    resetsAt: input.resetsAt,
    percentageDisplay: "remaining",
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

export function buildOmpAccountProviderUsage(
  source: OmpAccountUsageSource,
  copy: OmpAccountUsageCopy,
): ProviderUsage[] {
  const providerName = copy.providerName;
  if (source.error) {
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
    const windows = [
      shouldShowOmpFiveHourQuota(quota)
        ? quotaWindow({
            id: copy.providerId === "openai-codex" ? "codex_five_hour" : "anthropic_five_hour",
            label: copy.fiveHour,
            usedPct: quota?.fiveHourUsedPct,
            resetsAt: quota?.fiveHourResetsAt,
          })
        : null,
      quotaWindow({
        id: copy.providerId === "openai-codex" ? "codex_weekly" : "anthropic_weekly",
        label: copy.weekly,
        usedPct: quota?.weeklyUsedPct,
        resetsAt: quota?.weeklyResetsAt,
      }),
      ...(quota?.modelWindows ?? []).map((window) => ({
        id: `${copy.providerId}_weekly_${window.model}`,
        label: copy.modelWeekly(window.model),
        usedPct:
          typeof window.usedPct === "number" && Number.isFinite(window.usedPct)
            ? window.usedPct
            : null,
        remainingPct: resolveOmpRemainingQuotaPct(window.usedPct),
        resetsAt: window.resetsAt,
        percentageDisplay: "remaining" as const,
      })),
    ].filter((window): window is ProviderUsageWindow => window !== null);

    return {
      providerId: `${copy.providerId}:${account.credentialId}`,
      displayName: `${providerName} · ${accountLabel}`,
      status: quota?.status ?? "unavailable",
      planLabel: quota?.planLabel ?? null,
      sourceLabel: providerName,
      fetchedAt: quota?.fetchedAt ?? source.updatedAt,
      windows,
      balances: [],
      details: [],
      extraUsage: quota?.extraUsage,
      error: quota?.error ?? null,
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
