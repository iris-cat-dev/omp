export function resolveOmpModelProviderNamespace(
  modelId: string,
  metadataProvider?: unknown,
): string {
  if (typeof metadataProvider === "string" && metadataProvider.trim()) {
    return metadataProvider.trim();
  }
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : "omp";
}

export function formatOmpModelProviderNamespace(namespace: string): string {
  return namespace
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "openai") return "OpenAI";
      if (lower === "omp") return "OMP";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function resolveOmpModelProviderLabel(namespace: string, providerName?: unknown): string {
  return typeof providerName === "string" && providerName.trim()
    ? providerName.trim()
    : formatOmpModelProviderNamespace(namespace);
}
