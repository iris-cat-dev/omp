import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { formatOmpAccountSelectionLabel } from "@/components/omp-provider-accounts";
import {
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "@/components/omp-provider-quota";
import type { OmpAccountQuotaDisplayAccount } from "@/hooks/use-omp-account-quota";
import type { ProviderUsage, ProviderUsageView, ProviderUsageWindow } from "./types";

type OmpLoginProvider = OmpProviderManagement["loginProviders"][number];

export interface CodexUsageCopy {
  providerName: string;
  accountFallback: (number: number) => string;
  fiveHour: string;
  weekly: string;
}

export interface CodexUsageSource {
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
    usedPct: input.usedPct,
    remainingPct,
    resetsAt: input.resetsAt,
    percentageDisplay: "remaining",
  };
}

function unavailableCodexUsage(input: {
  displayName: string;
  sourceLabel: string;
  status: "unavailable" | "error";
  error?: string | null;
  fetchedAt: string | null;
}): ProviderUsage {
  return {
    providerId: "openai-codex",
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

export function buildCodexProviderUsage(
  source: CodexUsageSource,
  copy: CodexUsageCopy,
): ProviderUsage[] {
  const providerName = copy.providerName;
  if (source.error) {
    return [
      unavailableCodexUsage({
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
      unavailableCodexUsage({
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
      shouldShowOmpFiveHourQuota(quota?.planLabel)
        ? quotaWindow({
            id: "codex_five_hour",
            label: copy.fiveHour,
            usedPct: quota?.fiveHourUsedPct,
            resetsAt: quota?.fiveHourResetsAt,
          })
        : null,
      quotaWindow({
        id: "codex_weekly",
        label: copy.weekly,
        usedPct: quota?.weeklyUsedPct,
        resetsAt: quota?.weeklyResetsAt,
      }),
    ].filter((window): window is ProviderUsageWindow => window !== null);

    return {
      providerId: `openai-codex:${account.credentialId}`,
      displayName: `${providerName} · ${accountLabel}`,
      status: quota?.status ?? "unavailable",
      planLabel: quota?.planLabel ?? null,
      sourceLabel: providerName,
      fetchedAt: quota?.fetchedAt ?? source.updatedAt,
      windows,
      balances: [],
      details: [],
      error: quota?.error ?? null,
    };
  });
}

export function mergeCodexProviderUsage(
  view: ProviderUsageView,
  codexProviders: readonly ProviderUsage[],
  codexLoading: boolean,
  codexUpdatedAt: string | null,
): ProviderUsageView {
  if (codexProviders.length === 0) {
    if (view.kind !== "ready" || !codexLoading) return view;
    return { ...view, isRefreshing: true };
  }

  if (view.kind === "ready") {
    const otherProviders = view.payload.providers.filter(
      (provider) =>
        provider.providerId !== "openai-codex" && !provider.providerId.startsWith("openai-codex:"),
    );
    return {
      kind: "ready",
      payload: {
        ...view.payload,
        providers: [...codexProviders, ...otherProviders],
      },
      isRefreshing: view.isRefreshing || codexLoading,
    };
  }

  if (!codexUpdatedAt) return view;
  return {
    kind: "ready",
    payload: {
      fetchedAt: codexUpdatedAt,
      providers: [...codexProviders],
    },
    isRefreshing: codexLoading || view.kind === "loading",
  };
}
