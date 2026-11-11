import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  LOCAL_MODEL_MAX_REQUEST_BYTES,
  LocalModelInferenceRequestSchema,
  type LocalModel,
  type LocalModelInferenceRequest,
} from "@omp-desktop/protocol/local-models";
import type { OmpRuntimeSession, OmpStartSessionInput } from "./runtime.js";
import { resolveOmpRuntimeHelperPath } from "./sdk-host-command.js";
import { projectOmpLocalModelCatalog } from "./local-model-catalog.js";

export interface OmpLocalModelGateway {
  models: LocalModel[];
  request(body: LocalModelInferenceRequest, signal?: AbortSignal): Promise<Response>;
  close(): Promise<void>;
}
export interface OmpLocalModelGatewaySource extends OmpLocalModelGateway {
  /** Private host launch data; provider credentials stay in the source process. */
  launchConfig: { baseUrl: string; token: string };
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

/** One tool-free native host per source connection; closing it cancels every upstream request. */
export async function startOmpLocalModelGateway(
  startSession: (input: OmpStartSessionInput) => Promise<OmpRuntimeSession>,
  signal?: AbortSignal,
): Promise<OmpLocalModelGatewaySource> {
  const token = randomUUID();
  signal?.throwIfAborted();
  const runtime = await startSession({
    cwd: homedir(),
    protocolMode: "rpc",
    noSession: true,
    localModelGateway: true,
    signal,
    env: { OMP_DESKTOP_LOCAL_MODEL_GATEWAY_TOKEN: token },
    extraArgs: [
      "--no-tools",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--extension",
      resolveOmpRuntimeHelperPath("local-model-gateway-extension", import.meta.url),
    ],
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    signal?.removeEventListener("abort", abort);
    return closePromise ??= runtime.close();
  };
  const abort = () => { void close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!runtime.getLocalModelGatewayPort)
      throw new Error("Local models require an updated OMP runtime");
    const port = await runtime.getLocalModelGatewayPort();
    const catalog = await runtime.getAvailableModels();
    signal?.throwIfAborted();
    const models = projectOmpLocalModelCatalog(catalog);
    const allowed = new Set(models.map((model) => `${model.provider}/${model.id}`));
    return {
      models,
      launchConfig: { baseUrl: `http://127.0.0.1:${port}`, token },
      async request(input, signal) {
        if (closePromise) throw new Error("Local model source is disconnected");
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
