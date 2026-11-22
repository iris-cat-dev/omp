import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GeneratedImageSchema,
  IMAGE_GENERATION_TIMEOUT_MS,
  MAX_GENERATED_IMAGE_BYTES,
  type GeneratedImage,
  type ImageGenerationInput,
} from "@omp-desktop/protocol/image-generation";
import type { ProxyPolicy } from "@omp-desktop/protocol/provider-config";
import { z } from "zod";
import { createProxyFetch } from "../../../../services/quota-fetcher/proxy-fetch.js";
import type { ImageGenerationRuntimeConfig } from "../../../daemon-config-store.js";
import { createProviderEnv, type ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createCodexCatalogFetch } from "./codex-catalog-policy.js";
import { NativeImagePreferences, type NativeImageModel, type NativeImageRegistry } from "./image-settings-extension.js";
import { resolveOmpRuntimeHelperPath, resolveOmpSdkHostCommand } from "./sdk-host-command.js";
import { OMP_SDK_ROOT_ENV } from "./sdk-host-protocol.js";
import { resolveOmpSdkInstallation, type OmpSdkInstallation } from "./sdk-installation.js";

const ERRORS = {
  disabled: "Image generation is disabled on this host.",
  denied: "Image generation is disabled by the OMP provider policy on this host.",
  missingKey: "Set an OpenAI image API key in this host’s image generation settings.",
  account: "The selected ChatGPT image account is unavailable. Sign in or choose another subscription account on the host.",
  sdk: "The host’s OMP Node SDK does not support direct image generation. Update or rebuild the selected SDK.",
  failed: "The image provider request failed. Check the host’s image generation settings and credentials.",
  noImage: "The image provider returned no image.",
  invalidImage: "The provider must return one PNG, JPEG, or WebP image of at most 4 MiB.",
  timeout: "Image generation timed out.",
} as const;

type Failure = keyof typeof ERRORS;

/** Only these host-authored messages may cross the renderer boundary. */
export class WorkflowImageError extends Error {
  constructor(readonly code: Failure) {
    super(ERRORS[code]);
    this.name = "WorkflowImageError";
  }
}

interface HostRequest {
  input: ImageGenerationInput;
  config: ImageGenerationRuntimeConfig;
  proxyPolicy?: ProxyPolicy;
}

type HostReply = { image: GeneratedImage } | { error: Failure };

/** The SDK initializes process-global fetch, settings, and native auth state in its own child. */
export async function generateWorkflowImage(
  input: ImageGenerationInput,
  config: ImageGenerationRuntimeConfig,
  signal: AbortSignal,
  options?: { runtimeSettings?: ProviderRuntimeSettings },
): Promise<GeneratedImage> {
  signal.throwIfAborted();
  if (!config.enabled) throw new WorkflowImageError("disabled");
  if (options?.runtimeSettings?.disallowedTools?.includes("generate_image")) {
    throw new WorkflowImageError("denied");
  }
  if (config.backend === "openai-api" && !config.apiKey?.trim()) {
    throw new WorkflowImageError("missingKey");
  }

  const env = createProviderEnv({ runtimeSettings: options?.runtimeSettings });
  const [command, ...args] = await resolveOmpSdkHostCommand().catch(() => {
    throw new WorkflowImageError("sdk");
  });
  const timeout = AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeout]);
  requestSignal.throwIfAborted();
  const child = spawn(command, [...args, "--workflow-image"], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      [OMP_SDK_ROOT_ENV]: options?.runtimeSettings?.ompSdkPath ?? env[OMP_SDK_ROOT_ENV],
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const request: HostRequest = { input, config, proxyPolicy: options?.runtimeSettings?.proxyPolicy };
  const { promise, resolve: complete, reject } = Promise.withResolvers<HostReply>();
  const abort = () => {
    if (child.connected) child.disconnect();
    reject(signal.aborted ? signal.reason : new WorkflowImageError("timeout"));
  };
  requestSignal.addEventListener("abort", abort, { once: true });
  child.on("error", () => reject(new WorkflowImageError("sdk")));
  child.once("exit", () => reject(new WorkflowImageError("sdk")));
  child.once("message", (message: HostReply) => complete(message));
  child.send(request, (error) => { if (error) reject(new WorkflowImageError("sdk")); });
  try {
    const reply = await promise;
    signal.throwIfAborted();
    if (timeout.aborted) throw new WorkflowImageError("timeout");
    if ("error" in reply) throw new WorkflowImageError(reply.error);
    return reply.image;
  } finally {
    requestSignal.removeEventListener("abort", abort);
    if (child.connected) child.disconnect();
    // Give the SDK's fetch abort and native-auth cleanup a chance to finish.
    if (child.exitCode === null && child.signalCode === null) {
      const cleanup = setTimeout(() => child.kill(), 1000).unref();
      child.once("exit", () => clearTimeout(cleanup));
    }
  }
}

const requireSdk = createRequire(import.meta.url);
const callable = <T>(message: string) => z.custom<T>((value) => typeof value === "function", message);
const registryMap = z.object({ version: z.literal(1), modules: z.record(z.string(), z.string()) });

async function loadImageModules(installation: OmpSdkInstallation) {
  const directory = await realpath(join(installation.root, "dist", "node"));
  const { modules } = registryMap.parse(JSON.parse(await readFile(join(directory, "modules.json"), "utf8")));
  async function load(alias: string): Promise<unknown> {
    const entry = modules[alias];
    if (!entry || isAbsolute(entry)) throw new WorkflowImageError("sdk");
    const file = await realpath(resolve(directory, entry));
    const child = relative(directory, file);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new WorkflowImageError("sdk");
    }
    return requireSdk(file);
  }
  const sdk = requireSdk(installation.sdkEntry) as unknown;
  const ai = z.object({
    generateImage: callable<(
      model: NativeImageModel,
      request: { prompt: string; inputImages: ImageGenerationInput["images"]; count: 1 },
      options: { apiKey: unknown; signal: AbortSignal; fetch: typeof fetch; carrier?: NativeImageModel; sessionId?: string },
    ) => Promise<{ images: unknown[] }>>("Missing native generateImage export"),
  }).parse(await load("@oh-my-pi/pi-ai"));
  const catalog = z.object({
    buildModel: callable<(model: NativeImageModel) => NativeImageModel>("Missing native buildModel export"),
  }).parse(await load("@oh-my-pi/pi-catalog/build"));
  return { sdk, ai, catalog };
}

interface ImageAuth { close(): void }
interface ModelRegistry extends NativeImageRegistry {
  registerProvider(name: string, config: Record<string, unknown>, source: string): void;
  unregisterProvider(name: string): void;
}

/** Bound the native JSON/SSE reader and keep provider-supplied image URLs on the selected origin. */
function imageFetch(baseUrl: string, fetchApi: typeof fetch): typeof fetch {
  const origin = new URL(baseUrl).origin;
  // SSE may contain the same result in both output_item.done and response.completed.
  const maxWireBytes = 2 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 64 * 1024;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || url.username || url.password) throw new WorkflowImageError("failed");
    const response = await fetchApi(input, { ...init, redirect: "error" });
    if (!response.body) return response;
    const contentType = response.headers.get("content-type");
    const limit = contentType?.startsWith("image/") ? MAX_GENERATED_IMAGE_BYTES : maxWireBytes;
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) throw new WorkflowImageError("invalidImage");
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function generateInSdkHost(
  installation: OmpSdkInstallation,
  { config, input, proxyPolicy }: HostRequest,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const rawFetch = globalThis.fetch;
  if (config.backend === "chatgpt-subscription") {
    // Use the same pre-SDK catalog cache guard as the standard OMP host.
    requireSdk(resolveOmpRuntimeHelperPath("codex-catalog-preload", import.meta.url));
  }
  const { sdk, ai, catalog } = await loadImageModules(installation)
    .catch(() => { throw new WorkflowImageError("sdk"); });
  globalThis.fetch = createCodexCatalogFetch(globalThis.fetch);
  signal.throwIfAborted();
  const subscription = config.backend === "chatgpt-subscription";
  const routedFetch = createProxyFetch({
    getProxyPolicy: () => proxyPolicy,
    provider: subscription ? "openai-codex" : "openai",
    fetch: rawFetch,
  });

  let auth: ImageAuth | undefined;
  let preferences: NativeImagePreferences | undefined;
  try {
    let model: NativeImageModel;
    let carrier: NativeImageModel | undefined;
    let apiKey: unknown;
    let sessionId: string | undefined;
    if (subscription) {
      const native = z.object({
        getAgentDir: callable<() => string>("Missing native agent directory export"),
        Settings: z.custom<{ loadIsolated(options: { agentDir: string; globalOnly: true }): Promise<unknown> }>(
          (value) => typeof value === "function" && "loadIsolated" in value,
        ),
        discoverAuthStorage: callable<(agentDir: string, options: { settings: unknown }) => Promise<ImageAuth>>("Missing native auth storage export"),
        ModelRegistry: callable<new (auth: ImageAuth, modelsPath: string, options: { settings: unknown }) => ModelRegistry>("Missing native model registry export"),
        isAuthenticated: callable<(key: string | undefined) => boolean>("Missing native auth-state export"),
      }).parse(sdk);
      const agentDir = native.getAgentDir();
      const settings = await native.Settings.loadIsolated({ agentDir, globalOnly: true });
      signal.throwIfAborted();
      auth = await native.discoverAuthStorage(agentDir, { settings });
      signal.throwIfAborted();
      const registry = new native.ModelRegistry(auth, join(agentDir, "models.yml"), { settings });
      preferences = new NativeImagePreferences({
        on: () => {},
        getAllTools: () => [{ name: "generate_image" }],
        setToolEnabled: async () => {},
        registerProvider: (name, definition) => registry.registerProvider(name, definition, "<desktop-workflow-image>"),
        unregisterProvider: (name) => registry.unregisterProvider(name),
      }, { modelRegistry: registry });
      await preferences.apply(config, true);
      signal.throwIfAborted();
      sessionId = randomUUID();
      const prepared = z.object({ input: z.object({ model: z.string() }) }).safeParse(
        preferences.beforeToolCall({ toolName: "generate_image", toolCallId: sessionId, input: {} }),
      );
      if (!prepared.success) throw new WorkflowImageError("account");
      const [provider, ...parts] = prepared.data.input.model.split("/");
      const selected = registry.find(provider, parts.join("/"));
      if (!selected?.hostedImage || !native.isAuthenticated(await registry.getApiKey(selected, sessionId, { signal }))) {
        throw new WorkflowImageError("account");
      }
      // Keep the same credential restriction and retry resolver used by Desktop’s native image tool.
      apiKey = registry.resolver(selected, sessionId);
      model = { ...selected, provider: "openai-codex" };
      carrier = model;
    } else {
      apiKey = config.apiKey;
      model = catalog.buildModel({
        id: config.model,
        name: config.model,
        provider: "openai",
        api: "openai-images",
        kind: "image",
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 0,
        maxTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
    signal.throwIfAborted();
    const result = await ai.generateImage(model, { prompt: input.prompt, inputImages: input.images, count: 1 }, {
      apiKey, signal, carrier, sessionId, fetch: imageFetch(model.baseUrl, routedFetch),
    });
    signal.throwIfAborted();
    if (!result.images.length) throw new WorkflowImageError("noImage");
    const image = GeneratedImageSchema.safeParse(result.images[0]);
    if (result.images.length !== 1 || !image.success) throw new WorkflowImageError("invalidImage");
    return image.data;
  } finally {
    try { preferences?.dispose(); } finally { auth?.close(); }
  }
}

/** Called only by the private, single-use SDK child command, never by a chat turn. */
export async function runOmpWorkflowImageHost(): Promise<void> {
  if (!process.send) throw new WorkflowImageError("sdk");
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  process.once("disconnect", disconnect);
  const { promise, resolve: receive, reject } = Promise.withResolvers<HostRequest>();
  const cancel = () => reject(controller.signal.reason);
  process.once("message", receive);
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const request = await promise;
    const installation = await resolveOmpSdkInstallation().catch(() => {
      throw new WorkflowImageError("sdk");
    });
    const reply: HostReply = await generateInSdkHost(installation, request, controller.signal)
      .then((image) => ({ image }), (error: unknown) => ({
        error: error instanceof WorkflowImageError ? error.code : "failed",
      }));
    if (process.connected && !controller.signal.aborted) {
      const { promise: sent, resolve: done } = Promise.withResolvers<void>();
      process.send(reply, () => done());
      await sent;
    }
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    process.removeListener("message", receive);
    process.removeListener("disconnect", disconnect);
  }
}
