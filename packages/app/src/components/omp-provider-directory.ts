import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { isKnownOmpBrowserLoginProvider } from "@omp-desktop/protocol/omp-provider-auth";
import { compareMatchScores, scoreTextFields } from "@omp-desktop/protocol/search/text-match";
import bundledModelIndex from "./omp-provider-model-index.json";

type OmpManagedProvider = OmpProviderManagement["providerModels"][number];
type OmpProviderLogin = OmpProviderManagement["loginProviders"][number];

export interface OmpProviderSummary {
  id: string;
  name: string;
  brandId: string;
  brand: string;
  product?: string;
  modelCount: number;
  models?: OmpManagedProvider["models"];
  custom: boolean;
  login?: OmpProviderLogin;
  deviceCodeLogin?: OmpProviderLogin;
}

const CODEX = "openai-codex";
const CODEX_DEVICE = "openai-codex-device";

const BRANDS: Record<string, { name: string; ids: string[]; product?: string }> = {
  openai: { name: "OpenAI", product: "ChatGPT · GPT", ids: [CODEX, CODEX_DEVICE, "openai"] },
  anthropic: { name: "Anthropic", product: "Claude", ids: ["anthropic"] },
  google: { name: "Google", product: "Gemini", ids: ["google", "google-gemini-cli", "google-antigravity", "google-vertex"] },
  deepseek: { name: "DeepSeek", ids: ["deepseek"] },
  cursor: { name: "Cursor", ids: ["cursor"] },
  moonshot: { name: "Kimi", product: "Moonshot AI", ids: ["kimi-code", "moonshot", "moonshot-cn"] },
  minimax: { name: "MiniMax", ids: ["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"] },
  alibaba: { name: "Alibaba Cloud", ids: ["alibaba", "alibaba-coding-plan", "alibaba-token-plan", "qwen-portal", "dashscope"] },
  zhipu: { name: "GLM", product: "Zhipu AI · Z.ai", ids: ["zai", "zai-coding-plan", "zhipu", "zhipu-coding-plan"] },
  github: { name: "GitHub", ids: ["github-copilot"] },
  xai: { name: "xAI", ids: ["xai", "xai-oauth"] },
};

const BRAND_IDS = new Map(
  Object.entries(BRANDS).flatMap(([brandId, { ids }]) => ids.map((id) => [id, brandId] as const)),
);
const FEATURED_BRANDS = ["openai", "anthropic", "deepseek", "cursor", "moonshot", "zhipu"];
const BUNDLED_MODELS: Readonly<Record<string, readonly (readonly string[])[]>> = bundledModelIndex;

export function canStartOmpBrowserLogin(login: OmpProviderLogin | undefined): boolean {
  if (!login?.available) return false;
  return login.supportsBrowserLogin ?? isKnownOmpBrowserLoginProvider(login.id);
}

function reconcileSharedLogin(
  login: OmpProviderLogin | undefined,
  deviceCodeLogin: OmpProviderLogin | undefined,
) {
  if (!login || login.authenticated || !deviceCodeLogin?.authenticated) return login;
  return {
    ...login,
    authenticated: true,
    accounts: login.accounts ?? deviceCodeLogin.accounts,
  };
}

function summarizeProvider(
  id: string,
  provider: OmpManagedProvider | undefined,
  storedLogin: OmpProviderLogin | undefined,
  deviceCodeLogin: OmpProviderLogin | undefined,
): OmpProviderSummary {
  const custom =
    provider?.source === "custom" ||
    (provider !== undefined && provider.source === undefined && !storedLogin && id !== CODEX_DEVICE);
  const login = reconcileSharedLogin(storedLogin, deviceCodeLogin);
  const name = provider?.name ?? login?.name ?? id;
  const brandId = custom ? id : (BRAND_IDS.get(id) ?? id);
  const brand = custom ? undefined : BRANDS[brandId];
  return {
    id,
    name,
    brandId,
    brand: brand?.name ?? name,
    product: brand?.product,
    modelCount: provider?.modelCount ?? 0,
    models: provider?.models,
    custom,
    login,
    deviceCodeLogin,
  };
}

export function buildOmpProviderDirectory(management: OmpProviderManagement | null) {
  const connected: OmpProviderSummary[] = [];
  const available: OmpProviderSummary[] = [];
  if (!management) return { connected, available, featured: [] };

  const models = new Map(management.providerModels.map((provider) => [provider.id, provider]));
  const logins = new Map(management.loginProviders.map((provider) => [provider.id, provider]));
  const sharedDeviceLogin = logins.has(CODEX) ? logins.get(CODEX_DEVICE) : undefined;
  const ids = new Set([...models.keys(), ...logins.keys()]);
  if (sharedDeviceLogin && !models.get(CODEX_DEVICE)?.modelCount) ids.delete(CODEX_DEVICE);

  for (const id of ids) {
    const storedLogin = id === CODEX_DEVICE && sharedDeviceLogin ? undefined : logins.get(id);
    const deviceCodeLogin = id === CODEX ? sharedDeviceLogin : undefined;
    const summary = summarizeProvider(id, models.get(id), storedLogin, deviceCodeLogin);
    if (summary.custom || summary.login?.authenticated || summary.modelCount > 0) {
      connected.push(summary);
    } else if (summary.login?.available || deviceCodeLogin?.available || summary.login?.supportsApiKey) {
      available.push(summary);
    }
  }

  const byBrand = (a: OmpProviderSummary, b: OmpProviderSummary) =>
    a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name);
  connected.sort(byBrand);
  available.sort(byBrand);
  const featured = FEATURED_BRANDS.flatMap((brandId) =>
    available.filter((entry) => entry.brandId === brandId),
  );
  return { connected, available, featured };
}

export function searchOmpProviderDirectory(providers: OmpProviderSummary[], query: string) {
  const results = [];
  for (const provider of providers) {
    const brandScore = scoreTextFields(query, [
      provider.brand,
      provider.product ?? "",
      provider.name,
      provider.id,
      provider.deviceCodeLogin?.name ?? "",
      provider.deviceCodeLogin?.id ?? "",
    ]);
    const matches = new Map<string, { name: string; score: NonNullable<typeof brandScore> }>();
    const candidates = new Map<string, string>();
    if (!provider.custom) {
      for (const [id, name = id] of BUNDLED_MODELS[provider.id] ?? []) {
        if (id) candidates.set(id, name ?? id);
      }
    }
    for (const { id, name } of provider.models ?? []) candidates.set(id, name);
    for (const [id, name] of candidates) {
      const score = scoreTextFields(query, [id, name]);
      if (score) matches.set(name, { name, score });
    }
    const bestModels = [...matches.values()].sort((a, b) => compareMatchScores(a.score, b.score));
    const score = brandScore ?? bestModels[0]?.score;
    if (score) {
      results.push({
        provider,
        score,
        brandMatch: brandScore !== null,
        modelNames: bestModels.slice(0, 3).map(({ name }) => name),
      });
    }
  }
  return results.sort(
    (a, b) => Number(b.brandMatch) - Number(a.brandMatch) || compareMatchScores(a.score, b.score),
  );
}
