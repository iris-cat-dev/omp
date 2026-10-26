import { randomUUID } from "node:crypto";
import {
  LOCAL_MODEL_MAX_REQUEST_BYTES,
  LocalModelCatalogSchema,
  type LocalModelInferenceRequest,
  type LocalModelStreamFrame,
} from "@omp-desktop/protocol/local-models";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { LocalModelBridge } from "../../local-model-bridge.js";
import type { OmpLocalModelGateway } from "../../agent/providers/omp/local-model-gateway.js";

interface SourceState {
  ownerId: string;
  gateway: Promise<OmpLocalModelGateway> | null;
  requests: Map<string, AbortController>;
  attached: boolean;
}
interface LocalModelSessionOptions {
  bridge?: LocalModelBridge;
  openGateway(): Promise<OmpLocalModelGateway>;
  refresh(): Promise<void>;
  retireRuntimes(): Promise<void>;
  emit(message: SessionOutboundMessage, source: object): void;
}

/** All model traffic is scoped to the physical authenticated source, not the shared session. */
export class LocalModelSession {
  private readonly sources = new Map<object, SourceState>();
  private readonly defaultSource = {};
  private readonly closing = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly options: LocalModelSessionOptions) {}

  handle(message: SessionInboundMessage, source = this.defaultSource): Promise<void> | undefined {
    if (!message.type.startsWith("local_model.")) return undefined;
    return this.dispatch(message, source).catch(() => {
      if (this.disposed || !this.sources.has(source)) return;
      this.options.emit(
        {
          type: "rpc_error",
          payload: {
            requestId: "requestId" in message ? String(message.requestId) : "",
            requestType: message.type,
            code: "handler_error",
            error:
              "Local model operation failed. Check the local model connection and configuration.",
          },
        },
        source,
      );
    });
  }

  disconnect(source: object): void {
    const state = this.sources.get(source);
    if (!state) return;
    this.sources.delete(source);
    this.options.bridge?.detach(state.ownerId);
    this.closeSource(source, state, false);
    if (state.attached && !this.disposed) {
      this.track(
        this.options
          .retireRuntimes()
          .then(() => this.options.refresh())
          .catch(() => undefined),
      );
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const source of this.sources.keys()) this.disconnect(source);
    await Promise.all(this.closing);
  }

  private state(source: object): SourceState {
    let state = this.sources.get(source);
    if (!state) {
      state = { ownerId: randomUUID(), gateway: null, requests: new Map(), attached: false };
      this.sources.set(source, state);
    }
    return state;
  }

  private async openSource(
    message: Extract<SessionInboundMessage, { type: "local_model.source.open" }>,
    source: object,
    state: SourceState,
  ): Promise<void> {
    const opening = (state.gateway ??= this.options.openGateway());
    let gateway: OmpLocalModelGateway;
    try {
      gateway = await opening;
    } catch (error) {
      if (state.gateway === opening) state.gateway = null;
      throw error;
    }
    if (this.sources.get(source) !== state) return;
    if (state.gateway !== opening) throw new Error("Local model source was closed");
    this.options.emit(
      {
        type: "local_model.source.open.response",
        payload: {
          requestId: message.requestId,
          models: LocalModelCatalogSchema.parse(gateway.models),
        },
      },
      source,
    );
  }

  private async attachModels(
    message: Extract<SessionInboundMessage, { type: "local_model.attach" }>,
    source: object,
    state: SourceState,
  ): Promise<void> {
    const bridge = this.options.bridge;
    if (!bridge) throw new Error("Local model bridge unavailable");
    await bridge.attach(state.ownerId, message.models, (event) => {
      if (this.sources.get(source) !== state || this.disposed) return;
      this.options.emit(
        event.type === "request"
          ? {
              type: "local_model.request",
              payload: { requestId: event.requestId, body: event.body },
            }
          : { type: "local_model.cancel", payload: { requestId: event.requestId } },
        source,
      );
    });
    if (this.sources.get(source) !== state || this.disposed) {
      bridge.detach(state.ownerId);
      if (!this.disposed) {
        await this.options.retireRuntimes();
        await this.options.refresh();
      }
      return;
    }
    state.attached = true;
    await this.options.retireRuntimes();
    await this.options.refresh();
    if (this.sources.get(source) !== state || this.disposed) return;
    this.options.emit(
      {
        type: "local_model.attach.response",
        payload: { requestId: message.requestId },
      },
      source,
    );
  }

  private async dispatch(message: SessionInboundMessage, source: object): Promise<void> {
    if (this.disposed) return;
    const state = this.state(source);
    switch (message.type) {
      case "local_model.source.open":
        await this.openSource(message, source, state);
        return;
      case "local_model.source.close":
        await this.closeSource(source, state, true);
        if (this.sources.get(source) === state && !this.disposed) {
          this.options.emit(
            {
              type: "local_model.source.close.response",
              payload: { requestId: message.requestId },
            },
            source,
          );
        }
        return;
      case "local_model.source.request":
        await this.request(source, state, message.requestId, message.body);
        return;
      case "local_model.source.cancel":
        state.requests.get(message.requestId)?.abort();
        state.requests.delete(message.requestId);
        return;
      case "local_model.attach":
        await this.attachModels(message, source, state);
        return;
      case "local_model.detach":
        this.options.bridge?.detach(state.ownerId, { disable: true });
        if (state.attached) {
          state.attached = false;
          await this.options.retireRuntimes();
          await this.options.refresh();
        }
        if (this.sources.get(source) === state && !this.disposed) {
          this.options.emit(
            { type: "local_model.detach.response", payload: { requestId: message.requestId } },
            source,
          );
        }
        return;
      case "local_model.frame":
        this.options.bridge?.receive(state.ownerId, message.requestId, message.frame);
        return;
    }
  }

  private closeSource(source: object, state: SourceState, notify: boolean): Promise<void> {
    for (const [requestId, controller] of state.requests) {
      controller.abort();
      if (notify)
        this.frame(source, requestId, {
          type: "error",
          message: "Local model source disconnected",
        });
    }
    state.requests.clear();
    const gateway = state.gateway;
    state.gateway = null;
    const operation = gateway
      ? gateway.then((value) => value.close()).catch(() => undefined)
      : Promise.resolve();
    this.track(operation);
    return operation;
  }

  private async request(
    source: object,
    state: SourceState,
    requestId: string,
    body: LocalModelInferenceRequest,
  ): Promise<void> {
    // Duplicates cannot replace or cancel another in-flight request.
    if (state.requests.has(requestId)) return;
    const controller = new AbortController();
    state.requests.set(requestId, controller);
    const active = () =>
      !controller.signal.aborted &&
      this.sources.get(source) === state &&
      state.requests.get(requestId) === controller;
    try {
      if (
        !state.gateway ||
        Buffer.byteLength(JSON.stringify(body), "utf8") > LOCAL_MODEL_MAX_REQUEST_BYTES
      ) {
        throw new Error("Unavailable local model request");
      }
      const gateway = await state.gateway;
      if (!active()) return;
      if (!gateway.models.some((model) => `${model.provider}/${model.id}` === body.modelId)) {
        throw new Error("Unavailable local model");
      }
      const response = await gateway.request(body, controller.signal);
      if (!active()) {
        await response.body?.cancel();
        return;
      }
      this.frame(source, requestId, {
        type: "headers",
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/x-ndjson",
      });
      if (response.body) {
        await this.streamBody(source, requestId, response.body, controller.signal, active);
      }
      if (active()) this.frame(source, requestId, { type: "end" });
    } catch {
      if (active())
        this.frame(source, requestId, { type: "error", message: "Local model inference failed" });
    } finally {
      if (state.requests.get(requestId) === controller) state.requests.delete(requestId);
    }
  }

  private async streamBody(
    source: object,
    requestId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    active: () => boolean,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const sendText = (text: string) => {
      // Keep UTF-16 surrogate pairs intact when slicing wire frames.
      for (let offset = 0; offset < text.length; ) {
        let end = Math.min(offset + 128 * 1024, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        if (active())
          this.frame(source, requestId, { type: "chunk", data: text.slice(offset, end) });
        offset = end;
      }
    };
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (active()) {
        const next = await reader.read();
        if (next.done) break;
        sendText(decoder.decode(next.value, { stream: true }));
      }
      sendText(decoder.decode());
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }

  private frame(source: object, requestId: string, frame: LocalModelStreamFrame): void {
    this.options.emit({ type: "local_model.source.frame", payload: { requestId, frame } }, source);
  }

  private track(operation: Promise<void>): void {
    this.closing.add(operation);
    void operation.finally(() => this.closing.delete(operation));
  }
}
