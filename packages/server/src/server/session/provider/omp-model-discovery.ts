import { OmpProviderApiSchema, type OmpProviderApi } from "@omp-desktop/protocol/messages";

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface OmpDiscoveredProviderModel {
  id: string;
  name: string;
  supportedApis?: OmpProviderApi[];
  inputModalities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: string[];
}

interface DiscoveryInput {
  baseUrl: string;
  apiKey: string;
}

function buildModelUrls(baseUrl: string): URL[] {
  const base = new URL(baseUrl);
  base.hash = "";
  base.search = "";
  base.pathname = base.pathname.replace(/\/+$/, "");

  if (base.pathname.endsWith("/v1") || base.pathname.endsWith("/v2")) {
    const rootPath = base.pathname.slice(0, -3);
    const enhanced = new URL(base);
    enhanced.pathname = `${rootPath}/v2/models`.replace(/\/{2,}/g, "/");
    const versioned = new URL(base);
    versioned.pathname = `${rootPath}/v1/models`.replace(/\/{2,}/g, "/");
    return [enhanced, versioned];
  }

  const enhanced = new URL(base);
  enhanced.pathname = `${enhanced.pathname}/v2/models`.replace(/\/{2,}/g, "/");
  const versioned = new URL(base);
  versioned.pathname = `${versioned.pathname}/v1/models`.replace(/\/{2,}/g, "/");
  const direct = new URL(base);
  direct.pathname = `${direct.pathname}/models`.replace(/\/{2,}/g, "/");
  return [enhanced, versioned, direct];
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = [
    ...new Set(
      value.flatMap((level) => (typeof level === "string" && level.trim() ? [level.trim()] : [])),
    ),
  ];
  return levels.length > 0 ? levels : undefined;
}

function parseModels(value: unknown): OmpDiscoveredProviderModel[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const seen = new Set<string>();
  const models: OmpDiscoveredProviderModel[] = [];

  for (const item of items) {
    const candidate =
      typeof item === "string"
        ? { id: item, name: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const displayName =
      candidate && "display_name" in candidate ? candidate.display_name : undefined;
    const candidateName = candidate && "name" in candidate ? candidate.name : undefined;
    const name =
      typeof displayName === "string" && displayName.trim()
        ? displayName.trim()
        : typeof candidateName === "string" && candidateName.trim()
          ? candidateName.trim()
          : id;
    const supportedApis = Array.isArray(candidate?.supported_apis)
      ? [
          ...new Set(
            candidate.supported_apis.flatMap((api) => {
              const parsed = OmpProviderApiSchema.safeParse(api);
              return parsed.success ? [parsed.data] : [];
            }),
          ),
        ]
      : undefined;
    const inputModalities = Array.isArray(candidate?.input_modalities)
      ? [
          ...new Set(
            candidate.input_modalities
              .filter(
                (modality): modality is string =>
                  typeof modality === "string" &&
                  (modality.trim() === "text" || modality.trim() === "image"),
              )
              .map((modality) => modality.trim()),
          ),
        ]
      : undefined;
    const contextWindow = parsePositiveInteger(candidate?.context_window);
    const maxOutputTokens = parsePositiveInteger(candidate?.max_output_tokens);
    const reasoning = typeof candidate?.reasoning === "boolean" ? candidate.reasoning : undefined;
    const defaultReasoningLevel =
      typeof candidate?.default_reasoning_level === "string" &&
      candidate.default_reasoning_level.trim()
        ? candidate.default_reasoning_level.trim()
        : undefined;
    const supportedReasoningLevels = parseReasoningLevels(candidate?.supported_reasoning_levels);
    seen.add(id);
    models.push({
      id,
      name,
      ...(supportedApis?.length ? { supportedApis } : {}),
      ...(inputModalities?.length ? { inputModalities } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
      ...(supportedReasoningLevels ? { supportedReasoningLevels } : {}),
    });
  }

  return models;
}

export async function discoverOmpProviderModels(
  input: DiscoveryInput,
): Promise<OmpDiscoveredProviderModel[]> {
  for (const url of buildModelUrls(input.baseUrl)) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const contentLength = Number(response.headers.get("content-length"));
      if (!response.ok || (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES)) {
        await response.body?.cancel();
        continue;
      }

      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) continue;
      const models = parseModels(JSON.parse(body));
      if (models.length > 0) return models;
    } catch {
      // Fetch, body decoding (including broken gzip), and JSON failures try the next endpoint.
      continue;
    }
  }

  return [];
}
