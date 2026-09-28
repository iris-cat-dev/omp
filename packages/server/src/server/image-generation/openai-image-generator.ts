import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import { OpenAI } from "openai";
import type {
  ImageEditParamsNonStreaming,
  ImageGenerateParamsNonStreaming,
  ImagesResponse,
} from "openai/resources/images";

import type { ImageGenerationRuntimeConfig } from "../daemon-config-store.js";
import type { OmpSubscriptionCredentialResolver } from "./omp-subscription-credential.js";
import {
  MAX_IMAGE_GENERATION_REFERENCE_IMAGES,
  type GeneratedImage,
  type ImageGenerationBackground,
  type ImageGenerationContext,
  type ImageGenerationInput,
  type ImageGenerationOutputFormat,
  type ImageGenerationQuality,
  type ImageGenerationService,
  type ImageGenerationSize,
} from "./types.js";

const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_IMAGE_API_BASE_URL = "https://chatgpt.com/backend-api/codex/images";
const CODEX_IMAGE_GENERATION_ENDPOINT = `${CODEX_IMAGE_API_BASE_URL}/generations`;
const CODEX_IMAGE_EDIT_ENDPOINT = `${CODEX_IMAGE_API_BASE_URL}/edits`;
const CODEX_IMAGE_GENERATION_MODEL = "gpt-image-2";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const MIME_TYPE_BY_OUTPUT_FORMAT: Record<ImageGenerationOutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

interface ImageApiClient {
  generate(
    input: ImageGenerateParamsNonStreaming,
    options: { signal?: AbortSignal },
  ): Promise<ImagesResponse>;
  edit(
    input: ImageEditParamsNonStreaming,
    options: { signal?: AbortSignal },
  ): Promise<ImagesResponse>;
}

interface OpenAIImageGenerationDependencies {
  paseoHome: string;
  getConfig: () => ImageGenerationRuntimeConfig | null;
  logger: pino.Logger;
  createClient?: (config: ImageGenerationRuntimeConfig) => ImageApiClient;
  subscriptionCredentialResolver?: OmpSubscriptionCredentialResolver;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

function createOpenAIImageClient(config: ImageGenerationRuntimeConfig): ImageApiClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
  return {
    generate: (input, options) => client.images.generate(input, options),
    edit: (input, options) => client.images.edit(input, options),
  };
}

interface RequestSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}

function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Image generation request timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

interface ReferenceImage {
  filePath: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function referenceImageMimeType(bytes: Buffer): ReferenceImage["mimeType"] | null {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function inspectReferenceImage(filePath: string): Promise<ReferenceImage> {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`Reference image not found: ${filePath}`, { cause: error });
    }
    throw error;
  }
  if (!fileStats.isFile()) {
    throw new Error(`Reference image path is not a file: ${filePath}`);
  }
  if (fileStats.size <= 0) {
    throw new Error(`Reference image is empty: ${filePath}`);
  }
  if (fileStats.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(
      `Reference image is too large (${fileStats.size} bytes; max ${MAX_REFERENCE_IMAGE_BYTES}): ${filePath}`,
    );
  }

  const sample = Buffer.allocUnsafe(Math.min(12, fileStats.size));
  const handle = await open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const mimeType = referenceImageMimeType(sample.subarray(0, bytesRead));
    if (!mimeType) {
      throw new Error(`Reference image must be a PNG, JPEG, or WebP file: ${filePath}`);
    }
    return { filePath, mimeType };
  } finally {
    await handle.close();
  }
}

async function inspectReferenceImages(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReferenceImage[]> {
  if (paths.length > MAX_IMAGE_GENERATION_REFERENCE_IMAGES) {
    throw new Error(
      `Image generation accepts at most ${MAX_IMAGE_GENERATION_REFERENCE_IMAGES} reference images.`,
    );
  }
  signal?.throwIfAborted();
  const images = await Promise.all(paths.map((filePath) => inspectReferenceImage(filePath)));
  signal?.throwIfAborted();
  return images;
}

function validateRequest(
  backend: ImageGenerationRuntimeConfig["backend"],
  model: string,
  input: ImageGenerationInput,
): void {
  if (!input.prompt.trim()) {
    throw new Error("Image generation prompt must not be empty.");
  }
  if (
    backend === "openai-api" &&
    (model === "gpt-image-2" || model.startsWith("gpt-image-2-")) &&
    input.background === "transparent"
  ) {
    throw new Error(`${model} does not support transparent backgrounds; use auto or opaque.`);
  }
  if (input.background === "transparent" && input.outputFormat === "jpeg") {
    throw new Error("Transparent image generation requires png or webp output.");
  }
  if (backend === "chatgpt-subscription" && input.outputFormat !== "png") {
    throw new Error("ChatGPT subscription image generation currently supports PNG output only.");
  }
}

function decodeBase64Image(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Image generation returned invalid base64 data.");
  }
  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  const decodedSize = (value.length / 4) * 3 - padding;
  if (decodedSize > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Generated image exceeds the 32 MiB output limit.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length !== decodedSize) {
    throw new Error("Image generation returned invalid base64 data.");
  }
  return bytes;
}

function hasExpectedSignature(bytes: Buffer, format: ImageGenerationOutputFormat): boolean {
  if (format === "png") {
    return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  }
  if (format === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

interface ResolvedImageGenerationRequest {
  prompt: string;
  size: ImageGenerationSize;
  quality: ImageGenerationQuality;
  background: ImageGenerationBackground;
  outputFormat: ImageGenerationOutputFormat;
}

function resolveImageGenerationRequest(
  config: ImageGenerationRuntimeConfig,
  input: ImageGenerationInput,
): ResolvedImageGenerationRequest {
  const requestedOutputFormat: ImageGenerationOutputFormat = input.outputFormat ?? "png";
  validateRequest(config.backend, config.model, {
    ...input,
    outputFormat: requestedOutputFormat,
  });
  return {
    prompt: input.prompt.trim(),
    size: input.size ?? "auto",
    quality: input.quality ?? "auto",
    background: input.background ?? "auto",
    outputFormat: config.backend === "chatgpt-subscription" ? "png" : requestedOutputFormat,
  };
}

function imageProviderEndpoint(
  config: ImageGenerationRuntimeConfig,
  hasReferenceImages: boolean,
): string {
  if (config.backend === "chatgpt-subscription") {
    const endpoint = hasReferenceImages
      ? CODEX_IMAGE_EDIT_ENDPOINT
      : CODEX_IMAGE_GENERATION_ENDPOINT;
    return new URL(endpoint).origin;
  }
  if (config.baseUrl) {
    return new URL(config.baseUrl).origin;
  }
  return "https://api.openai.com";
}

function outputDirectory(paseoHome: string, agentId: string): string {
  const agentKey = createHash("sha256").update(agentId).digest("hex").slice(0, 20);
  return path.join(paseoHome, "generated-images", agentKey);
}
function subscriptionErrorMessage(status: number, body: string): string {
  let providerMessage = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") providerMessage = message.trim();
      } else if (typeof error === "string") {
        providerMessage = error.trim();
      }
    }
  } catch {
    providerMessage = "";
  }
  if (status === 429) {
    return providerMessage
      ? `ChatGPT subscription image generation limit reached: ${providerMessage}`
      : "ChatGPT subscription image generation limit reached.";
  }
  const suffix = providerMessage ? `: ${providerMessage}` : "";
  return `ChatGPT subscription image generation failed (HTTP ${status})${suffix}`;
}

function parseSubscriptionResponse(value: unknown): ImagesResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ChatGPT subscription image generation returned an invalid response.");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error("ChatGPT subscription image generation returned an invalid response.");
  }
  const images = data.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const encoded = (item as Record<string, unknown>).b64_json;
    return typeof encoded === "string" ? [{ b64_json: encoded }] : [];
  });
  return {
    created:
      typeof (value as Record<string, unknown>).created === "number"
        ? (value as Record<string, number>).created
        : 0,
    data: images,
  };
}

export class OpenAIImageGenerationService implements ImageGenerationService {
  private readonly paseoHome: string;
  private readonly getConfig: () => ImageGenerationRuntimeConfig | null;
  private readonly logger: pino.Logger;
  private readonly createClient: (config: ImageGenerationRuntimeConfig) => ImageApiClient;
  private readonly subscriptionCredentialResolver?: OmpSubscriptionCredentialResolver;
  private readonly fetchApi: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(dependencies: OpenAIImageGenerationDependencies) {
    this.paseoHome = dependencies.paseoHome;
    this.getConfig = dependencies.getConfig;
    this.logger = dependencies.logger.child({ component: "image-generation", provider: "openai" });
    this.createClient = dependencies.createClient ?? createOpenAIImageClient;
    this.subscriptionCredentialResolver = dependencies.subscriptionCredentialResolver;
    this.fetchApi = dependencies.fetch ?? fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  }
  private async generateWithSubscription(
    config: ImageGenerationRuntimeConfig,
    input: {
      prompt: string;
      size: ImageGenerationSize;
      quality: ImageGenerationQuality;
      background: ImageGenerationBackground;
      referenceImages: readonly ReferenceImage[];
    },
    signal: AbortSignal,
  ): Promise<ImagesResponse> {
    const credentialId = config.subscriptionCredentialId;
    if (!credentialId) {
      throw new Error("Image generation requires an OpenAI Codex subscription account.");
    }
    if (!this.subscriptionCredentialResolver) {
      throw new Error("OpenAI Codex subscription credentials are unavailable on this host.");
    }

    let images: Array<{ image_url: string }> | undefined;
    const request = async (forceRefresh: boolean): Promise<Response> => {
      const credential = await this.subscriptionCredentialResolver?.resolve(credentialId, {
        forceRefresh,
        signal,
      });
      if (!credential) {
        throw new Error("OpenAI Codex subscription credentials are unavailable on this host.");
      }
      if (credential.planType === "free") {
        throw new Error("Image generation is unavailable for the selected free ChatGPT plan.");
      }
      const endpoint =
        input.referenceImages.length > 0
          ? CODEX_IMAGE_EDIT_ENDPOINT
          : CODEX_IMAGE_GENERATION_ENDPOINT;
      if (input.referenceImages.length > 0 && !images) {
        images = await Promise.all(
          input.referenceImages.map(async (image) => ({
            image_url: `data:${image.mimeType};base64,${(
              await readFile(image.filePath, { signal })
            ).toString("base64")}`,
          })),
        );
      }
      return await this.fetchApi(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-ID": credential.accountId,
          "Content-Type": "application/json",
          "x-codex-image-turn-id": randomUUID(),
        },
        body: JSON.stringify({
          prompt: input.prompt,
          background: input.background,
          model: CODEX_IMAGE_GENERATION_MODEL,
          quality: input.quality,
          size: input.size,
          ...(images ? { images } : {}),
        }),
        signal,
      });
    };

    let response = await request(false);
    if (response.status === 401) response = await request(true);
    if (!response.ok) {
      throw new Error(subscriptionErrorMessage(response.status, await response.text()));
    }
    return parseSubscriptionResponse(await response.json());
  }

  private async requestImage(
    config: ImageGenerationRuntimeConfig,
    input: ResolvedImageGenerationRequest,
    referenceImages: readonly ReferenceImage[],
    signal: AbortSignal,
  ): Promise<ImagesResponse> {
    if (config.backend === "chatgpt-subscription") {
      return await this.generateWithSubscription(
        config,
        {
          prompt: input.prompt,
          size: input.size,
          quality: input.quality,
          background: input.background,
          referenceImages,
        },
        signal,
      );
    }

    const client = this.createClient(config);
    if (referenceImages.length === 0) {
      return await client.generate(
        {
          prompt: input.prompt,
          model: config.model,
          n: 1,
          size: input.size,
          quality: input.quality,
          background: input.background,
          output_format: input.outputFormat,
          stream: false,
        },
        { signal },
      );
    }

    const streams = referenceImages.map((image) => createReadStream(image.filePath));
    try {
      return await client.edit(
        {
          image: streams,
          prompt: input.prompt,
          model: config.model,
          n: 1,
          size: input.size,
          quality: input.quality,
          background: input.background,
          output_format: input.outputFormat,
          stream: false,
        },
        { signal },
      );
    } finally {
      for (const stream of streams) stream.destroy();
    }
  }

  public async generate(
    input: ImageGenerationInput,
    context: ImageGenerationContext,
  ): Promise<GeneratedImage> {
    const config = this.getConfig();
    if (!config?.enabled) {
      throw new Error("Image generation is disabled in Host settings.");
    }

    const { prompt, size, quality, background, outputFormat } = resolveImageGenerationRequest(
      config,
      input,
    );
    context.signal?.throwIfAborted();
    const referenceImages = await inspectReferenceImages(
      input.referenceImagePaths ?? [],
      context.signal,
    );

    if (config.backend === "openai-api" && !config.apiKey) {
      throw new Error("Image generation requires an OpenAI API key in Host settings.");
    }

    const requestStartedAt = Date.now();
    const endpoint = imageProviderEndpoint(config, referenceImages.length > 0);
    const requestSignal = createRequestSignal(context.signal, this.requestTimeoutMs);
    this.logger.info(
      {
        model: config.model,
        size,
        quality,
        outputFormat,
        referenceImageCount: referenceImages.length,
        endpoint,
        timeoutMs: this.requestTimeoutMs,
      },
      "Image generation request started",
    );
    let response: ImagesResponse;
    try {
      response = await this.requestImage(
        config,
        { prompt, size, quality, background, outputFormat },
        referenceImages,
        requestSignal.signal,
      );
    } catch (error) {
      const durationMs = Date.now() - requestStartedAt;
      if (requestSignal.didTimeout()) {
        this.logger.warn(
          { model: config.model, endpoint, durationMs, timeoutMs: this.requestTimeoutMs },
          "Image generation request timed out",
        );
        throw new Error(
          `Image generation timed out after ${Math.ceil(this.requestTimeoutMs / 1000)} seconds while waiting for ${endpoint}. Try medium or low quality, or check the provider endpoint.`,
          { cause: error },
        );
      }
      this.logger.warn(
        { err: error, model: config.model, endpoint, durationMs },
        "Image generation request failed",
      );
      throw error;
    } finally {
      requestSignal.dispose();
    }
    context.signal?.throwIfAborted();

    const image = response.data?.[0];
    if (!image?.b64_json) {
      throw new Error("Image generation returned no image data.");
    }
    const bytes = decodeBase64Image(image.b64_json);
    if (!hasExpectedSignature(bytes, outputFormat)) {
      throw new Error(`Image generation returned data that is not valid ${outputFormat}.`);
    }

    const directory = outputDirectory(this.paseoHome, context.agentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const finalPath = path.join(directory, `${id}.${outputFormat}`);
    const temporaryPath = path.join(directory, `.${id}.tmp`);
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      context.signal?.throwIfAborted();
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    this.logger.info(
      {
        model: config.model,
        size,
        quality,
        outputFormat,
        filePath: finalPath,
        referenceImageCount: referenceImages.length,
        durationMs: Date.now() - requestStartedAt,
      },
      "Generated image",
    );
    return {
      prompt,
      model:
        config.backend === "chatgpt-subscription" ? CODEX_IMAGE_GENERATION_MODEL : config.model,
      filePath: finalPath,
      mimeType: MIME_TYPE_BY_OUTPUT_FORMAT[outputFormat],
      size,
      quality,
      background,
      outputFormat,
      ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
    };
  }
}
