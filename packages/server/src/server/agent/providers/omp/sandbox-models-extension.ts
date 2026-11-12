import {
  LOCAL_MODEL_PROVIDER,
  LocalModelCatalogSchema,
  type LocalModel,
} from "@omp-desktop/protocol/local-models";

const BRIDGE_ENV = "OMP_DESKTOP_SANDBOX_MODEL_BRIDGE";
interface BridgeModel {
  provider: string;
  id: string;
  baseUrl?: string;
  transport?: "pi-native";
  headers?: unknown;
  resolveHeaders?: unknown;
}
interface BridgeRegistry {
  getAvailable(...args: unknown[]): BridgeModel[];
  getAll(...args: unknown[]): BridgeModel[];
  getAvailableForProviders(...args: unknown[]): BridgeModel[];
  getProviderModels(...args: unknown[]): BridgeModel[];
  find(provider: string, id: string): BridgeModel | undefined;
  getApiKey(model: BridgeModel, ...args: unknown[]): Promise<string | undefined>;
  resolver(model: BridgeModel | string, ...args: unknown[]): unknown;
  getApiKeyWithCredentialForProvider(provider: string, ...args: unknown[]): Promise<{ apiKey: string } | undefined>;
}
interface ProviderBridgeApi {
  registerProvider(provider: string, definition: Record<string, unknown>): void;
  on(event: "session_start", handler: (event: unknown, context: { modelRegistry: BridgeRegistry }) => void): void;
}
interface BridgeConfiguration {
  baseUrl: string;
  token: string;
}

function readConfiguration(): BridgeConfiguration {
  const encoded = process.env[BRIDGE_ENV];
  delete process.env[BRIDGE_ENV];
  if (!encoded) throw new Error("Sandbox model source is unavailable");
  const input: unknown = JSON.parse(encoded);
  if (!input || typeof input !== "object" || !("baseUrl" in input) || typeof input.baseUrl !== "string" || !("token" in input) || typeof input.token !== "string" || !input.token) {
    throw new Error("Invalid sandbox model bridge configuration");
  }
  const url = new URL(input.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Sandbox model bridge must use a private loopback endpoint");
  }
  return { baseUrl: url.origin, token: input.token };
}

/** Host-only inference registration: original selections, no extension/tool/prompt capabilities. */
export default async function sandboxModels(api: ProviderBridgeApi): Promise<void> {
  const configuration = readConfiguration();
  const response = await fetch(`${configuration.baseUrl}/models`, {
    headers: { authorization: `Bearer ${configuration.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Sandbox model source is unavailable");
  const catalog = LocalModelCatalogSchema.parse(await response.json());
  if (catalog.some(model => model.provider === LOCAL_MODEL_PROVIDER || model.provider === "omp-desktop-bootstrap")) {
    throw new Error("Sandbox model bridge cannot use another model bridge as its source");
  }
  const providers = new Map<string, LocalModel[]>();
  for (const model of catalog) {
    const models = providers.get(model.provider) ?? [];
    models.push(model);
    providers.set(model.provider, models);
  }
  for (const [provider, models] of providers) {
    api.registerProvider(provider, {
      baseUrl: configuration.baseUrl,
      apiKey: configuration.token,
      transport: "pi-native",
      models: models.map(model => ({ ...model, name: model.name ?? model.id })),
    });
  }
  const allowed = new Set(catalog.map(model => `${model.provider}/${model.id}`));
  api.on("session_start", (_event, { modelRegistry: registry }) => {
    // Rebuilt/native model rows must retain the host inference hop, never local provider headers.
    const bindModel = (model: BridgeModel): boolean => {
      if (!allowed.has(`${model.provider}/${model.id}`)) return false;
      model.baseUrl = configuration.baseUrl;
      model.transport = "pi-native";
      delete model.headers;
      delete model.resolveHeaders;
      return true;
    };
    for (const method of ["getAvailable", "getAll", "getAvailableForProviders", "getProviderModels"] as const) {
      const original = registry[method].bind(registry);
      registry[method] = (...args) => original(...args).filter(bindModel);
    }
    const find = registry.find.bind(registry);
    registry.find = (provider, id) => {
      const model = find(provider, id);
      return model && bindModel(model) ? model : undefined;
    };
    registry.getApiKey = async model => {
      if (!bindModel(model)) throw new Error(`Sandbox model is unavailable: ${model.provider}/${model.id}`);
      return configuration.token;
    };
    registry.getApiKeyWithCredentialForProvider = async provider => {
      if (!providers.has(provider)) throw new Error(`Sandbox provider is unavailable: ${provider}`);
      return { apiKey: configuration.token };
    };
    const resolver = registry.resolver.bind(registry);
    registry.resolver = (model, ...args) => {
      if (typeof model === "string") {
        if (!providers.has(model)) throw new Error(`Sandbox provider is unavailable: ${model}`);
      } else if (!bindModel(model)) {
        throw new Error(`Sandbox model is unavailable: ${model.provider}/${model.id}`);
      }
      return resolver(model, ...args);
    };
  });
}
