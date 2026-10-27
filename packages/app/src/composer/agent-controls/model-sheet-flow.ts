import type { ModelBrowserView } from "@/components/model-browser-view";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  resolveOmpModelProviderLabel,
  resolveOmpModelProviderNamespace,
} from "@/provider-selection/omp-model-provider";

export function resolveModelBrowserScrolling(usesBottomSheet: boolean): "sheet" | "independent" {
  return usesBottomSheet ? "sheet" : "independent";
}

export function groupOmpModelsByProviderNamespace(
  providers: ProviderSelectorProvider[],
): ProviderSelectorProvider[] {
  return providers.flatMap((provider) => {
    if (provider.id !== "omp" || provider.modelSelection.kind !== "models") return [provider];
    const grouped = new Map<string, typeof provider.modelSelection.rows>();
    for (const row of provider.modelSelection.rows) {
      const namespace = resolveOmpModelProviderNamespace(row.modelId);
      const rows = grouped.get(namespace) ?? [];
      rows.push(row);
      grouped.set(namespace, rows);
    }
    if (grouped.size <= 1 && !provider.modelSelection.rows.some((row) => row.providerName?.trim()))
      return [provider];
    return [...grouped]
      .map(([namespace, rows]) => {
        const label = resolveOmpModelProviderLabel(
          namespace,
          rows.find((row) => row.providerName?.trim())?.providerName,
        );
        return {
          id: grouped.size === 1 ? provider.id : `omp:${namespace}`,
          label,
          modelSelection: {
            ...provider.modelSelection,
            kind: "models" as const,
            rows: rows.map((row) => ({ ...row, providerLabel: label })),
          },
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  });
}

export function resolveProviderSwitchModel(
  provider: ProviderSelectorProvider,
  rememberedModelId?: string,
) {
  if (provider.modelSelection.kind !== "models") return null;
  return (
    provider.modelSelection.rows.find((row) => row.modelId === rememberedModelId) ??
    provider.modelSelection.rows.find((row) => row.isDefault) ??
    provider.modelSelection.rows[0] ??
    null
  );
}

export function resolveModelBrowserProviderId(
  provider: string,
  modelId: string,
  providers: ProviderSelectorProvider[],
): string {
  if (provider !== "omp") return provider;
  const groupedId = `omp:${resolveOmpModelProviderNamespace(modelId)}`;
  if (providers.some((entry) => entry.id === groupedId)) return groupedId;
  for (const entry of providers) {
    if (entry.modelSelection.kind !== "models") continue;
    const matches = entry.modelSelection.rows.some(
      (row) => row.modelId === modelId || row.modelId.endsWith(`/${modelId}`),
    );
    if (matches) return entry.id;
  }
  return provider;
}
export function resolveModelBrowserProviderNamespaceId(
  providerId: string,
  modelId?: string,
): string {
  if (providerId.startsWith("omp:")) return providerId.slice("omp:".length);
  if (providerId === "omp" && modelId) return resolveOmpModelProviderNamespace(modelId);
  return providerId;
}

export function isModelBrowserRowSelected(
  rowProvider: string,
  rowModelId: string,
  selectedProvider: string,
  selectedModel: string,
): boolean {
  if (rowModelId !== selectedModel) return false;
  return rowProvider === selectedProvider || selectedProvider.startsWith(`${rowProvider}:`);
}

export function resolveModelSheetOpening({
  canSwitchProvider,
  providers,
  selectedProvider,
}: {
  canSwitchProvider: boolean;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
}): ModelBrowserView {
  if (canSwitchProvider && providers.length > 1) return { kind: "all" };

  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
  return provider
    ? {
        kind: "provider",
        providerId: provider.id,
        providerLabel: provider.label,
      }
    : { kind: "all" };
}
