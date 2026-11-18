// Desktop only: messages travel on the inherited Node IPC descriptor, never on the
// agent's JSON-RPC stream, through extension prompts, or in argv/environment.
export const OMP_PROVIDER_API_KEY_IPC = "omp-desktop:provider-api-key";

// Plain API-key inference transports verified in the built-in SDK catalog. OAuth
// variants such as openai-codex and google-gemini-cli have different transport IDs.
const OMP_API_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google Gemini",
  mistral: "Mistral",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export interface OmpApiKeyProvider {
  id: string;
  name: string;
  authenticated: boolean;
}

export type OmpProviderApiKeyOperation =
  | { operation: "list" }
  | { operation: "save"; providerId: string; apiKey: string };

export type OmpProviderApiKeyResult =
  | { ok: true; providers: OmpApiKeyProvider[]; refreshFailed?: true }
  | { ok: false };

interface OmpCredentialRegistry {
  authStorage: {
    credentials: {
      has(providerId: string): boolean;
      upsert(
        providerId: string,
        credential: { type: "api_key"; source: "login"; key: string },
      ): Promise<unknown>;
      revalidate(): Promise<void>;
    };
  };
  refreshProvider(providerId: string, strategy: "online"): Promise<void>;
}

interface ExtensionApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: { modelRegistry: OmpCredentialRegistry }) => void,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
}

export async function manageOmpProviderApiKeys(
  registry: OmpCredentialRegistry,
  command: OmpProviderApiKeyOperation,
  restrictedPool: boolean,
): Promise<OmpProviderApiKeyResult> {
  const storage = registry.authStorage.credentials;
  // A broker visibility pool is client-side routing policy. The broker upload
  // endpoint accepts even keys the pool hides, so leave writes to its operator.
  if (restrictedPool) {
    return command.operation === "list" ? { ok: true, providers: [] } : { ok: false };
  }
  let refreshFailed: true | undefined;
  if (command.operation === "save") {
    const { providerId, apiKey } = command;
    // The SDK interprets !-prefixed stored values as shell references. This API
    // accepts literal keys only; whitespace is also invalid in the supported keys.
    if (
      !Object.hasOwn(OMP_API_KEY_PROVIDERS, providerId) ||
      !apiKey ||
      apiKey.length > 8192 ||
      apiKey.startsWith("!") ||
      /[\s\p{Cc}]/u.test(apiKey)
    ) {
      return { ok: false };
    }
    // SDK upsert is transactional locally and authoritative in broker mode.
    // A distinct key adds an account; an identical key is deduplicated. Neither
    // operation replaces the provider's existing OAuth or API-key pool.
    await storage.upsert(providerId, { type: "api_key", source: "login", key: apiKey });
    try {
      await registry.refreshProvider(providerId, "online");
    } catch {
      refreshFailed = true;
    }
    try {
      // Publish a live broker snapshot via the SDK's encrypted cache path for
      // other catalog workers. For a local store this only reloads active rows.
      await storage.revalidate();
    } catch {
      refreshFailed = true;
    }
  }
  const providers = Object.entries(OMP_API_KEY_PROVIDERS).map(([id, name]) => ({
    id,
    name,
    authenticated: storage.has(id),
  }));
  return { ok: true, providers, ...(refreshFailed ? { refreshFailed } : {}) };
}

export default function desktopProviderApiKeys(pi: ExtensionApi): void {
  let listener: ((message: unknown) => void) | undefined;
  const stop = () => {
    if (listener) process.off("message", listener);
    listener = undefined;
  };
  pi.on("session_start", (_event, { modelRegistry }) => {
    stop();
    listener = (message) => {
      if (!message || typeof message !== "object" || !("type" in message) ||
        message.type !== OMP_PROVIDER_API_KEY_IPC || !("id" in message) ||
        typeof message.id !== "string" || !("operation" in message)) return;
      const id = message.id;
      let command: OmpProviderApiKeyOperation;
      if (message.operation === "list") {
        command = { operation: "list" };
      } else if (message.operation === "save" && "providerId" in message &&
        typeof message.providerId === "string" && "apiKey" in message &&
        typeof message.apiKey === "string") {
        command = { operation: "save", providerId: message.providerId, apiKey: message.apiKey };
      } else {
        return;
      }
      const send = (result: OmpProviderApiKeyResult) => {
        if (process.connected) process.send?.({ type: OMP_PROVIDER_API_KEY_IPC, id, result }, () => {});
      };
      void manageOmpProviderApiKeys(
        modelRegistry,
        command,
        !!process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE?.trim(),
      ).then(send, () => send({ ok: false }));
    };
    process.on("message", listener);
  });
  pi.on("session_shutdown", stop);
}
