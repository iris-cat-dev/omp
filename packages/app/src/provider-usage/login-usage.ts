import type { ProviderUsage, ProviderUsageView } from "./types";

const CODEX_LOGIN_PROVIDER_ID = "openai-codex";

export function selectProviderUsages(
  providers: ProviderUsage[],
  providerId: string | null | undefined,
): ProviderUsage[] {
  if (!providerId) return [];
  const target = providerId.toLowerCase();
  const hasAccounts =
    target === CODEX_LOGIN_PROVIDER_ID || target === "anthropic" || target === "zhipu-coding-plan";
  return providers.filter((usage) => {
    const id = usage.providerId.toLowerCase();
    return id === target || (hasAccounts && id.startsWith(`${target}:`));
  });
}

export function resolveLoginProviderUsages(
  view: ProviderUsageView,
  providerId: string,
): ProviderUsage[] {
  if (
    view.kind !== "ready" ||
    providerId === CODEX_LOGIN_PROVIDER_ID ||
    providerId === "anthropic"
  ) {
    return [];
  }
  return selectProviderUsages(view.payload.providers, providerId).filter(
    (usage) =>
      providerId === "zhipu-coding-plan" ||
      (usage.status === "available" &&
        (usage.windows.length > 0 || (usage.balances ?? []).length > 0)),
  );
}
