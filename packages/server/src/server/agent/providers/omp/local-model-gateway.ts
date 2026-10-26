import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  LOCAL_MODEL_MAX_REQUEST_BYTES,
  LOCAL_MODEL_PROVIDER,
  LocalModelCatalogSchema,
  LocalModelInferenceRequestSchema,
  type LocalModel,
  type LocalModelInferenceRequest,
} from "@omp-desktop/protocol/local-models";
import type { OmpRuntimeSession, OmpStartSessionInput } from "./runtime.js";

export interface OmpLocalModelGateway {
  models: LocalModel[];
  request(body: LocalModelInferenceRequest, signal?: AbortSignal): Promise<Response>;
  close(): Promise<void>;
}

const WIRE_OPTIONS: Record<string, true> = {
  temperature: true,
  topP: true,
  topK: true,
  minP: true,
  presencePenalty: true,
  frequencyPenalty: true,
  repetitionPenalty: true,
  stopSequences: true,
  maxTokens: true,
  cacheRetention: true,
  reasoning: true,
  disableReasoning: true,
  forceReasoningOff: true,
  hideThinkingSummary: true,
  thinkingBudgets: true,
  toolChoice: true,
  serviceTier: true,
  sessionId: true,
  promptCacheKey: true,
  promptCache: true,
  statefulResponses: true,
  storeResponses: true,
  loopGuard: true,
  acceptEmptyResponse: true,
  metadata: true,
  anthropicCompaction: true,
  anthropicPrefixMismatchBehavior: true,
};

function extensionPath(): string {
  const compiled = fileURLToPath(new URL("./local-model-gateway-extension.js", import.meta.url));
  const source = fileURLToPath(new URL("./local-model-gateway-extension.ts", import.meta.url));
  return (existsSync(compiled) ? compiled : source).replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

/** One tool-free native host per source connection; closing it cancels every upstream request. */
export async function startOmpLocalModelGateway(
  startSession: (input: OmpStartSessionInput) => Promise<OmpRuntimeSession>,
): Promise<OmpLocalModelGateway> {
  const token = randomUUID();
  const runtime = await startSession({
    cwd: homedir(),
    protocolMode: "rpc",
    noSession: true,
    localModelGateway: true,
    env: { OMP_DESKTOP_LOCAL_MODEL_GATEWAY_TOKEN: token },
    extraArgs: [
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-title",
      "--extension",
      extensionPath(),
    ],
  });
  try {
    if (!runtime.getLocalModelGatewayPort)
      throw new Error("Local models require an updated OMP runtime");
    const port = await runtime.getLocalModelGatewayPort();
    const catalog = await runtime.getAvailableModels();
    const models = LocalModelCatalogSchema.parse(
      catalog
        .filter(
          (model) =>
            model.provider !== LOCAL_MODEL_PROVIDER &&
            model.provider !== "omp-desktop-bootstrap" &&
            (model.kind === undefined || model.kind === "chat"),
        )
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          api: model.api,
          reasoning: model.reasoning,
          input: model.input,
          thinking: model.thinking,
          cost: model.cost,
          serviceTiers: model.serviceTiers,
          contextWindow:
            typeof model.contextWindow === "number" && model.contextWindow > 0
              ? model.contextWindow
              : undefined,
          maxTokens:
            typeof model.maxTokens === "number" && model.maxTokens > 0
              ? model.maxTokens
              : undefined,
        })),
    );
    const allowed = new Set(models.map((model) => `${model.provider}/${model.id}`));
    let closed = false;
    return {
      models,
      async request(input, signal) {
        if (closed) throw new Error("Local model source is disconnected");
        const body = LocalModelInferenceRequestSchema.parse(input);
        if (!allowed.has(body.modelId)) throw new Error("Local model is unavailable");
        const options = Object.fromEntries(
          Object.entries(body.options ?? {}).filter(([key]) => Object.hasOwn(WIRE_OPTIONS, key)),
        );
        const serialized = JSON.stringify({ ...body, options });
        if (Buffer.byteLength(serialized) > LOCAL_MODEL_MAX_REQUEST_BYTES)
          throw new Error("Local model request is too large");
        return fetch(`http://127.0.0.1:${port}/v1/pi/stream`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: serialized,
          signal,
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        await runtime.close();
      },
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
