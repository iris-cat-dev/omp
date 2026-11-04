import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { ImageGenerationRuntimeConfig } from "../../../daemon-config-store.js";

const IMAGE_TOOL = "generate_image";
const IMAGE_PROVIDER = "desktop-native-image";
const KEY_ENV = "OMP_DESKTOP_NATIVE_IMAGE_KEY";
const TOKEN_ENV = "OMP_DESKTOP_IMAGE_SETTINGS_TOKEN";
const SUBSCRIPTION_PROVIDER = "openai-codex";

export interface NativeImageModel {
  id: string;
  provider: string;
  api: string;
  kind?: string;
  baseUrl: string;
  hostedImage?: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  [key: string]: unknown;
}
export interface NativeImageRegistry {
  getAvailable(): NativeImageModel[];
  find(provider: string, id: string): NativeImageModel | undefined;
  getApiKey(
    model: NativeImageModel,
    sessionId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  resolver(model: NativeImageModel | string, sessionId?: string | Record<string, unknown>): unknown;
  authStorage: {
    credentials: {
      revalidate(): Promise<void>;
      snapshot(): {
        credentials: Array<{
          id: number;
          provider: string;
          identityKey: string | null;
          credential: { type: string };
        }>;
      };
    };
    sessions: {
      restrict(provider: string, sessionId: string, identities: readonly string[]): symbol;
      unrestrict(provider: string, sessionId: string, lease: symbol): void;
      pin(provider: string, sessionId: string, credentialId: number): boolean;
      release(provider: string, sessionId: string): boolean;
    };
  };
}
interface NativeImageContext {
  modelRegistry: NativeImageRegistry;
  model?: NativeImageModel;
}
export interface NativeImageExtensionApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: NativeImageContext) => Promise<void>,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
  on(
    event: "tool_call",
    handler: (event: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    }) => unknown,
  ): void;
  setToolEnabled(name: string, enabled: boolean): Promise<void>;
  getAllTools(): Array<{ name: string }>;
  registerProvider(name: string, config: Record<string, unknown>): void;
  unregisterProvider(name: string): void;
}
interface ImageRegistration {
  keyEnv: string;
  definition: Record<string, unknown>;
  carrier?: NativeImageModel;
  imageSessionId?: string;
  restriction?: symbol;
}

/** Settings/auth integration only. OMP's original generate_image tool executes every request. */
export class NativeImagePreferences {
  private readonly scope = randomUUID().replaceAll("-", "");
  private config: ImageGenerationRuntimeConfig | null = null;
  private allowed = false;
  private error: string | null = "Desktop image generation is disabled";
  private provider: string | null = null;
  private revision = 0;
  private callSequence = 0;
  private readonly registrations = new Map<string, ImageRegistration>();
  private readonly modelProviders = new WeakMap<NativeImageModel, string>();
  private readonly originalGetApiKey: NativeImageRegistry["getApiKey"];
  private readonly originalResolver: NativeImageRegistry["resolver"];

  constructor(
    private readonly pi: NativeImageExtensionApi,
    private readonly context: NativeImageContext,
  ) {
    const registry = context.modelRegistry;
    this.originalGetApiKey = registry.getApiKey;
    this.originalResolver = registry.resolver;
    // Scope native credential resolution to the image-only catalog provider. Chat
    // models (including a Codex carrier with the same id) retain their own affinity.
    registry.getApiKey = (model, sessionId, options) => {
      const provider = this.modelProviders.get(model) ?? model.provider;
      const route = this.registrations.get(provider);
      if (!route) return this.originalGetApiKey.call(registry, model, sessionId, options);
      if (route.carrier)
        return this.originalGetApiKey.call(registry, route.carrier, route.imageSessionId, options);
      const key = this.originalGetApiKey.call(registry, { ...model, provider }, sessionId, options);
      // Native OpenAI chooses standard multipart edits by provider identity.
      // Auth has already been scoped to the isolated image-only provider.
      model.provider = "openai";
      return key;
    };
    registry.resolver = (model, sessionId) => {
      const provider =
        typeof model === "string" ? undefined : (this.modelProviders.get(model) ?? model.provider);
      const route = provider ? this.registrations.get(provider) : undefined;
      if (!route || typeof model === "string")
        return this.originalResolver.call(registry, model, sessionId);
      return route.carrier
        ? this.originalResolver.call(registry, route.carrier, route.imageSessionId)
        : this.originalResolver.call(registry, { ...model, provider: provider! }, sessionId);
    };
  }

  async apply(config: ImageGenerationRuntimeConfig | null, allowed: boolean): Promise<void> {
    this.config = config;
    this.allowed = allowed;
    this.error = "Desktop image generation is disabled";
    await this.pi.setToolEnabled(IMAGE_TOOL, false);
    this.provider = null;
    if (!config?.enabled || !allowed) return;
    if (!this.pi.getAllTools().some((tool) => tool.name === IMAGE_TOOL)) {
      throw new Error(
        "Native generate_image is unavailable; Desktop image settings require OMP v18.8.7 or newer",
      );
    }
    const registry = this.context.modelRegistry;
    // Keep in-flight native requests on their original provider/key/auth session
    // when a steer changes settings. Everything is private and released at shutdown.
    const provider = `${IMAGE_PROVIDER}-${this.scope}-${++this.revision}`;
    const keyEnv = `${KEY_ENV}_${this.scope}_${this.revision}`;
    const route: ImageRegistration = { keyEnv, definition: {} };
    this.registrations.set(provider, route);
    this.provider = provider;
    try {
      if (config.backend === "chatgpt-subscription") {
        await registry.authStorage.credentials.revalidate();
        const accounts = registry.authStorage.credentials
          .snapshot()
          .credentials.filter(
            (row) =>
              row.provider === SUBSCRIPTION_PROVIDER &&
              row.credential.type === "oauth" &&
              row.identityKey,
          );
        const selected =
          config.subscriptionCredentialId === undefined
            ? accounts
            : accounts.filter((row) => row.id === config.subscriptionCredentialId);
        route.imageSessionId = `desktop-image:${randomUUID()}`;
        route.restriction = registry.authStorage.sessions.restrict(
          SUBSCRIPTION_PROVIDER,
          route.imageSessionId,
          selected.map((row) => row.identityKey!),
        );
        if (!selected.length)
          throw new Error(
            "The selected ChatGPT image account is unavailable; sign in or choose another subscription account",
          );
        if (
          config.subscriptionCredentialId !== undefined &&
          !registry.authStorage.sessions.pin(
            SUBSCRIPTION_PROVIDER,
            route.imageSessionId,
            config.subscriptionCredentialId,
          )
        )
          throw new Error("The selected ChatGPT image account cannot be pinned");
        const carriers = registry
          .getAvailable()
          .filter(
            (model) =>
              model.provider === SUBSCRIPTION_PROVIDER &&
              model.api === "openai-codex-responses" &&
              model.hostedImage,
          );
        const carrier =
          this.context.model?.provider === SUBSCRIPTION_PROVIDER && this.context.model.hostedImage
            ? this.context.model
            : carriers.reduce<NativeImageModel | undefined>(
                (best, model) => (!best || model.cost.input < best.cost.input ? model : best),
                undefined,
              );
        if (!carrier)
          throw new Error("OMP has no hosted image carrier for the selected ChatGPT subscription");
        route.carrier = carrier;
        // The marker only makes the private catalog entry discoverable. Both key
        // lookups and auth retry use the native restricted subscription resolver.
        process.env[keyEnv] = "desktop-native-subscription";
        route.definition = {
          baseUrl: carrier.baseUrl,
          api: carrier.api,
          apiKey: keyEnv,
          models: [{ ...carrier, kind: "image" }],
        };
      } else {
        if (!config.apiKey?.trim())
          throw new Error(
            "An image API key is required for the selected third-party image provider",
          );
        process.env[keyEnv] = config.apiKey;
        route.definition = {
          baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
          api: "openai-images",
          apiKey: keyEnv,
          models: [
            {
              id: config.model,
              name: config.model,
              api: "openai-images",
              kind: "image",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 0,
              maxTokens: 0,
            },
          ],
        };
      }
      this.pi.registerProvider(provider, route.definition);
      this.projectImageModel(provider);
      this.error = null;
      await this.pi.setToolEnabled(IMAGE_TOOL, true);
    } catch (error) {
      // Never surface provider config/key material via native extension error events.
      this.error =
        error instanceof Error &&
        /^(The selected ChatGPT|OMP has no hosted|An image API key)/.test(error.message)
          ? error.message
          : "OMP could not apply the selected image provider settings";
      // Invalid image credentials disable only image access. The tool-call hook
      // retains the error for stale/direct requests; ordinary chat stays usable.
    }
  }

  private projectImageModel(provider: string): void {
    const route = this.registrations.get(provider);
    if (!route) throw new Error("OMP image provider routing is unavailable");
    const id = route.carrier?.id ?? this.config?.model;
    if (!id) throw new Error("OMP image model selection is unavailable");
    const model = this.context.modelRegistry.find(provider, id);
    if (!model) throw new Error("OMP could not register the selected image model");
    this.modelProviders.set(model, provider);
    // Runtime provider definitions omit hostedImage. Reuse native wire metadata.
    if (route.carrier)
      Object.assign(model, route.carrier, { provider, kind: "image", hostedImage: true });
  }

  beforeToolCall(event: {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }): unknown {
    if (event.toolName !== IMAGE_TOOL) return undefined;
    if (!this.config?.enabled || !this.allowed || this.error || !this.provider) {
      return {
        block: true,
        reason: this.error ?? "Desktop image generation is disabled by the tool policy",
      };
    }
    const source = this.provider ? this.registrations.get(this.provider) : undefined;
    if (!source) return { block: true, reason: "OMP image provider routing is unavailable" };
    // Each invocation gets its own catalog object: projecting OpenAI identity
    // cannot race another invocation or change a previously running native tool.
    const provider = `${this.provider}-call-${++this.callSequence}`;
    this.registrations.set(provider, source);
    this.pi.registerProvider(provider, source.definition);
    this.projectImageModel(provider);
    // A single explicit selector disables OMP's default fallback chain and
    // cannot be overridden by the chat model or a stale historical tool call.
    return {
      input: { ...event.input, model: `${provider}/${source.carrier?.id ?? this.config.model}` },
    };
  }

  dispose(): void {
    const registry = this.context.modelRegistry;
    registry.getApiKey = this.originalGetApiKey;
    registry.resolver = this.originalResolver;
    const released = new Set<ImageRegistration>();
    for (const [provider, route] of this.registrations) {
      this.pi.unregisterProvider(provider);
      if (released.has(route)) continue;
      released.add(route);
      if (route.imageSessionId) {
        if (route.restriction)
          registry.authStorage.sessions.unrestrict(
            SUBSCRIPTION_PROVIDER,
            route.imageSessionId,
            route.restriction,
          );
        registry.authStorage.sessions.release(SUBSCRIPTION_PROVIDER, route.imageSessionId);
      }
      delete process.env[route.keyEnv];
    }
    this.registrations.clear();
  }
}

export default function desktopNativeImageSettings(pi: NativeImageExtensionApi): void {
  const token = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  if (!token) throw new Error("Desktop native image settings control token is unavailable");
  let preferences: NativeImagePreferences | undefined;
  let stop: (() => void) | undefined;
  pi.on("tool_call", (event) => preferences?.beforeToolCall(event));
  pi.on("session_start", async (_event, context) => {
    stop?.();
    preferences?.dispose();
    preferences = new NativeImagePreferences(pi, context);
    await preferences.apply(null, false);
    let updates = Promise.resolve();
    const applyPreferences = (config: ImageGenerationRuntimeConfig | null, allowed: boolean) => {
      const apply = updates.then(() => preferences!.apply(config, allowed));
      updates = apply.catch(() => undefined);
      return apply;
    };
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) {
        response.writeHead(403).end('{"error":"Forbidden"}');
        return;
      }
      if (request.method !== "POST" || request.url !== "/settings") {
        response.writeHead(404).end('{"error":"Not found"}');
        return;
      }
      void (async () => {
        const buffers: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 64 * 1024) throw new Error("Image settings request is too large");
          buffers.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(buffers).toString("utf8")) as {
          config: ImageGenerationRuntimeConfig | null;
          allowed: boolean;
        };
        if (
          typeof body.allowed !== "boolean" ||
          (body.config !== null &&
            (typeof body.config !== "object" ||
              typeof body.config.enabled !== "boolean" ||
              typeof body.config.model !== "string" ||
              !["openai-api", "chatgpt-subscription"].includes(body.config.backend)))
        )
          throw new Error("Invalid Desktop image settings");
        await applyPreferences(body.config, body.allowed);
        response.writeHead(200).end('{"applied":true}');
      })().catch((error: unknown) => {
        const message =
          error instanceof Error &&
          /^(The selected ChatGPT|OMP |An image API key|Native generate_image|Invalid Desktop|Image settings request)/.test(
            error.message,
          )
            ? error.message
            : "OMP image settings update failed";
        response.writeHead(400).end(JSON.stringify({ error: message }));
      });
    });
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", () => ready.resolve());
    await ready.promise;
    server.removeListener("error", ready.reject);
    server.unref();
    stop = () => {
      server.close();
      stop = undefined;
    };
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Desktop image settings endpoint did not bind");
    process.stdout.write(
      `${JSON.stringify({ type: "desktop_image_settings_ready", port: address.port })}\n`,
    );
  });
  pi.on("session_shutdown", () => {
    stop?.();
    preferences?.dispose();
    preferences = undefined;
  });
}
