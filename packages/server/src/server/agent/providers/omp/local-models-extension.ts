import { LOCAL_MODEL_PROVIDER, LocalModelCatalogSchema } from "@omp-desktop/protocol/local-models";

const BRIDGE_ENV = "OMP_DESKTOP_LOCAL_MODEL_BRIDGE";
const KEY_ENV = "OMP_DESKTOP_LOCAL_MODEL_BRIDGE_KEY";
interface BridgeModel {
  provider: string;
  id: string;
  transport?: "pi-native";
}
interface BridgeRegistry {
  getAvailable(): BridgeModel[];
  getAll(): BridgeModel[];
  getApiKey(model: BridgeModel, ...args: unknown[]): Promise<string | undefined>;
  resolver(model: BridgeModel | string, ...args: unknown[]): unknown;
}
interface LocalModelExtensionApi {
  registerProvider(provider: string, definition: Record<string, unknown>): void;
  on(
    event: "session_start",
    handler: (
      event: unknown,
      context: { modelRegistry: BridgeRegistry; model?: BridgeModel },
    ) => void,
  ): void;
}

/** Registers only public catalog data; the bearer authorizes this remote loopback hop, not a provider. */
export default async function localModels(pi: LocalModelExtensionApi): Promise<void> {
  const encoded = process.env[BRIDGE_ENV];
  delete process.env[BRIDGE_ENV];
  if (!encoded) throw new Error("Local model bridge is unavailable");
  const configuration: unknown = JSON.parse(encoded);
  if (
    !configuration ||
    typeof configuration !== "object" ||
    !("baseUrl" in configuration) ||
    typeof configuration.baseUrl !== "string" ||
    !("token" in configuration) ||
    typeof configuration.token !== "string"
  ) {
    throw new Error("Invalid local model bridge configuration");
  }
  const url = new URL(configuration.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Local model bridge must use a private loopback endpoint");
  }
  const response = await fetch(`${url.origin}/models`, {
    headers: { authorization: `Bearer ${configuration.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Local model source is disconnected. Reconnect OMP Desktop.");
  const models = LocalModelCatalogSchema.parse(await response.json());
  process.env[KEY_ENV] = configuration.token;
  pi.registerProvider(LOCAL_MODEL_PROVIDER, {
    baseUrl: url.origin,
    apiKey: KEY_ENV,
    transport: "pi-native",
    models: models.map((model) =>
      Object.assign({}, model, {
        id: `${model.provider}/${model.id}`,
        provider: LOCAL_MODEL_PROVIDER,
        name: `Local · ${model.provider}/${model.name ?? model.id}`,
      }),
    ),
  });
  pi.on("session_start", (_event, context) => {
    const registry = context.modelRegistry;
    const getAvailable = registry.getAvailable.bind(registry);
    const getAll = registry.getAll.bind(registry);
    const getApiKey = registry.getApiKey.bind(registry);
    const resolver = registry.resolver.bind(registry);
    // Native runtime registration can rebuild model rows without the provider's
    // transport override. Enforce this source's transport on each live model.
    const localModel = (model: BridgeModel): boolean => {
      if (model.provider !== LOCAL_MODEL_PROVIDER) return false;
      model.transport = "pi-native";
      return true;
    };
    if (context.model) localModel(context.model);
    // Native slash commands and task-model selection must not bypass the selected source.
    registry.getAvailable = () => getAvailable().filter(localModel);
    registry.getAll = () => getAll().filter(localModel);
    registry.getApiKey = (model, ...args) => {
      if (model.provider !== LOCAL_MODEL_PROVIDER)
        throw new Error("Select a model from this Desktop.");
      model.transport = "pi-native";
      return getApiKey(model, ...args);
    };
    registry.resolver = (model, ...args) => {
      const provider = typeof model === "string" ? model.split("/")[0] : model.provider;
      if (provider !== LOCAL_MODEL_PROVIDER) throw new Error("Select a model from this Desktop.");
      if (typeof model !== "string") model.transport = "pi-native";
      return resolver(model, ...args);
    };
  });
}
