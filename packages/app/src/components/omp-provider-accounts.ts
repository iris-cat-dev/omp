export interface OmpAccountIdentity {
  primary: string | null;
  secondary: string | null;
}

interface OmpAccountFeatureOption {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface OmpAccountFeatureSelection {
  value: string | null;
  effectiveValue?: string | null;
  options: readonly OmpAccountFeatureOption[];
}

export function isOmpAutomaticAccountOption(option: OmpAccountFeatureOption): boolean {
  return option.metadata?.selectionMode === "automatic";
}

export function orderOmpAccountFeatureOptions<T extends OmpAccountFeatureOption>(
  options: readonly T[],
): T[] {
  const automatic = options.find(isOmpAutomaticAccountOption);
  return automatic
    ? [automatic, ...options.filter((option) => option !== automatic)]
    : [...options];
}

export function resolveOmpAccountSelectorOptions(
  featureOptions: readonly OmpAccountFeatureOption[] | null | undefined,
  accounts: readonly { credentialId: number }[],
): OmpAccountFeatureOption[] {
  if (featureOptions) {
    const orderedFeatureOptions = orderOmpAccountFeatureOptions(featureOptions);
    const optionsById = new Map(orderedFeatureOptions.map((option) => [option.id, option]));
    const ordered: OmpAccountFeatureOption[] = [];
    const automatic = orderedFeatureOptions.find(isOmpAutomaticAccountOption);
    if (automatic) {
      ordered.push(automatic);
      optionsById.delete(automatic.id);
    }
    for (const account of accounts) {
      const id = String(account.credentialId);
      const option = optionsById.get(id);
      if (!option) continue;
      ordered.push(option);
      optionsById.delete(id);
    }
    for (const option of orderedFeatureOptions) {
      if (!optionsById.has(option.id)) continue;
      ordered.push(option);
      optionsById.delete(option.id);
    }
    return ordered;
  }
  return accounts.map((account) => {
    const id = String(account.credentialId);
    return { id, label: id };
  });
}

export function resolveOmpAccountFeatureSelection(feature: OmpAccountFeatureSelection): {
  automaticOptionId: string | null;
  configuredValue: string;
  effectiveValue: string;
  isAutomatic: boolean;
} {
  const automaticOption =
    orderOmpAccountFeatureOptions(feature.options).find(isOmpAutomaticAccountOption) ?? null;
  const isAutomatic =
    feature.value === null || (automaticOption !== null && feature.value === automaticOption.id);
  return {
    automaticOptionId: automaticOption?.id ?? null,
    configuredValue: isAutomatic ? (automaticOption?.id ?? "") : (feature.value ?? ""),
    effectiveValue: feature.effectiveValue ?? (isAutomatic ? "" : (feature.value ?? "")),
    isAutomatic,
  };
}

export function resolveOmpLoginAction(input: {
  available: boolean;
  authenticated: boolean;
}): "sign-in" | "add-account" | null {
  if (!input.available) return null;
  return input.authenticated ? "add-account" : "sign-in";
}

export function formatOmpAccountIdentity(identityKey?: string): OmpAccountIdentity {
  const normalized = identityKey?.trim();
  if (!normalized) return { primary: null, secondary: null };

  const parts = normalized
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const emailPart = parts.find((part) => part.toLowerCase().startsWith("email:"));
  const email = emailPart?.slice(emailPart.indexOf(":") + 1).trim();
  if (!email) return { primary: normalized, secondary: null };

  const qualifiers = parts.filter((part) => part !== emailPart);
  return {
    primary: email,
    secondary: qualifiers.length > 0 ? qualifiers.join(" · ") : null,
  };
}

export function formatOmpAccountSelectionLabel(input: {
  note?: string;
  identityKey?: string;
  fallback: string;
}): string {
  const note = input.note?.trim();
  const identity = formatOmpAccountIdentity(input.identityKey).primary?.trim();
  return note || identity || input.fallback;
}

export function resolveOmpAccountControlLabels(input: {
  featureLabel: string;
  accountLabel?: string | null;
}): { buttonLabel: string; tooltipLabel: string } {
  const accountLabel = input.accountLabel?.trim();
  return {
    buttonLabel: input.featureLabel,
    tooltipLabel: accountLabel ? `${input.featureLabel}: ${accountLabel}` : input.featureLabel,
  };
}

export function selectOmpQuotaAccounts<T extends { credentialId: number }>(
  accounts: readonly T[],
  selectedCredentialId: number | null | undefined,
  allowedCredentialIds?: readonly string[],
): T[] {
  const available =
    allowedCredentialIds === undefined
      ? [...accounts]
      : accounts.filter((account) => allowedCredentialIds.includes(String(account.credentialId)));
  if (selectedCredentialId !== null && selectedCredentialId !== undefined) {
    return available.filter((account) => account.credentialId === selectedCredentialId);
  }
  return available.length <= 1 ? available : [];
}
