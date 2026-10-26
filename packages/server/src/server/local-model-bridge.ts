import { randomUUID } from "node:crypto";
import {
  createServer,
  validateHeaderValue,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import {
  LOCAL_MODEL_MAX_REQUEST_BYTES,
  LOCAL_MODEL_PROVIDER,
  LOCAL_MODEL_UNAVAILABLE_STATUS,
  LocalModelCatalogSchema,
  LocalModelInferenceRequestSchema,
  LocalModelStreamFrameSchema,
  type LocalModel,
  type LocalModelInferenceRequest,
  type LocalModelStreamFrame,
} from "@omp-desktop/protocol/local-models";

type BridgeEvent =
  | { type: "request"; requestId: string; body: LocalModelInferenceRequest }
  | { type: "cancel"; requestId: string };
interface Owner {
  id: string;
  models: LocalModel[];
  modelIds: Set<string>;
  emit: (event: BridgeEvent) => void;
}
interface PendingStream {
  owner: Owner;
  response: ServerResponse;
  headers: boolean;
}

export class LocalModelBridge {
  private owner: Owner | null = null;
  private readonly pending = new Map<string, PendingStream>();
  private readonly token = randomUUID();
  private server: Server | null = null;
  private listening: Promise<string> | null = null;
  private closed = false;
  private enabledOwnerId: string | null = null;

  isEnabled(): boolean {
    return this.enabledOwnerId !== null;
  }

  async attach(ownerId: string, models: LocalModel[], emit: Owner["emit"]): Promise<void> {
    if (this.closed) throw new Error("Local model bridge is closed");
    if (this.owner && this.owner.id !== ownerId) {
      throw new Error("Local models are already attached by another connection");
    }
    const catalog = LocalModelCatalogSchema.parse(models);
    if (catalog.some((model) => model.provider === LOCAL_MODEL_PROVIDER)) {
      throw new Error("A local model bridge cannot use another local model bridge as its source");
    }
    this.detach(ownerId);
    this.owner = {
      id: ownerId,
      models: catalog,
      modelIds: new Set(catalog.map((model) => `${model.provider}/${model.id}`)),
      emit,
    };
    this.enabledOwnerId = ownerId;
    try {
      await this.listen();
      if (this.closed) throw new Error("Local model bridge is closed");
    } catch (error) {
      this.detach(ownerId);
      throw error;
    }
  }

  detach(ownerId: string, options?: { disable?: boolean }): void {
    if (options?.disable && this.enabledOwnerId === ownerId) this.enabledOwnerId = null;
    if (!this.owner || this.owner.id !== ownerId) return;
    const owner = this.owner;
    this.owner = null;
    for (const [requestId, stream] of this.pending) {
      if (stream.owner !== owner) continue;
      this.pending.delete(requestId);
      this.fail(stream.response, "Local model source disconnected", LOCAL_MODEL_UNAVAILABLE_STATUS);
      this.cancel(owner, requestId);
    }
  }

  receive(ownerId: string, requestId: string, input: LocalModelStreamFrame): void {
    const stream = this.pending.get(requestId);
    if (!stream || stream.owner !== this.owner || stream.owner.id !== ownerId) return;
    const parsed = LocalModelStreamFrameSchema.safeParse(input);
    if (!parsed.success) {
      this.finishWithError(requestId, stream, "Invalid local model stream");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "headers") {
      if (stream.headers || frame.status < 200 || /[\r\n]/.test(frame.contentType)) {
        this.finishWithError(requestId, stream, "Invalid local model stream headers");
        return;
      }
      try {
        validateHeaderValue("content-type", frame.contentType);
      } catch {
        this.finishWithError(requestId, stream, "Invalid local model stream headers");
        return;
      }
      stream.headers = true;
      stream.response.writeHead(frame.status, {
        "content-type": frame.contentType || "application/x-ndjson",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      stream.response.flushHeaders();
    } else if (frame.type === "error") {
      this.finishWithError(
        requestId,
        stream,
        "Local model source unavailable. Reconnect OMP Desktop.",
        LOCAL_MODEL_UNAVAILABLE_STATUS,
      );
    } else if (!stream.headers) {
      this.finishWithError(requestId, stream, "Local model stream headers missing");
    } else if (frame.type === "end") {
      this.pending.delete(requestId);
      stream.response.end();
    } else {
      if (stream.response.writableLength > 4 * 1024 * 1024) {
        this.finishWithError(requestId, stream, "Local model consumer is too slow");
        return;
      }
      stream.response.write(frame.data, "utf8");
    }
  }

  async getLaunchConfig(): Promise<{
    baseUrl: string;
    token: string;
    models: LocalModel[];
  } | null> {
    if (!this.owner || this.closed) return null;
    const owner = this.owner;
    const baseUrl = await this.listen();
    return this.owner === owner && !this.closed
      ? { baseUrl, token: this.token, models: owner.models }
      : null;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.owner) this.detach(this.owner.id);
    const server = this.server;
    if (!server) return;
    await this.listening?.catch(() => undefined);
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    server.closeAllConnections();
    await promise;
    this.server = null;
  }

  private listen(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Local model bridge is closed"));
    if (this.listening) return this.listening;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() =>
        this.fail(response, "Invalid local model request", 400),
      );
    });
    this.server = server;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.listening = promise;
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local model listener unavailable"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
    return this.listening;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      request.headers.origin !== undefined ||
      request.headers.authorization !== `Bearer ${this.token}`
    ) {
      this.fail(response, "Unauthorized", 403);
      request.resume();
      return;
    }
    const owner = this.owner;
    if (!owner || this.closed) {
      this.fail(response, "Local model source unavailable", LOCAL_MODEL_UNAVAILABLE_STATUS);
      request.resume();
      return;
    }
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(owner.models));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/pi/stream") {
      this.fail(response, "Not found", 404);
      request.resume();
      return;
    }
    const contentLength = Number(request.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > LOCAL_MODEL_MAX_REQUEST_BYTES) {
      this.fail(response, "Local model request too large", 413);
      request.resume();
      return;
    }
    const bytes = await this.readBody(request, response);
    if (!bytes) return;
    const parsed = LocalModelInferenceRequestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) {
      this.fail(response, "Invalid local model request", 400);
      return;
    }
    const prefix = `${LOCAL_MODEL_PROVIDER}/`;
    const modelId = parsed.data.modelId.startsWith(prefix)
      ? parsed.data.modelId.slice(prefix.length)
      : "";
    if (!owner.modelIds.has(modelId)) {
      this.fail(response, "Local model is not available", 400);
      return;
    }
    if (this.owner !== owner || response.destroyed) {
      this.fail(response, "Local model source unavailable", 503);
      return;
    }
    const requestId = randomUUID();
    const stream: PendingStream = { owner, response, headers: false };
    this.pending.set(requestId, stream);
    response.on("close", () => {
      if (!this.pending.delete(requestId)) return;
      this.cancel(owner, requestId);
    });
    try {
      owner.emit({ type: "request", requestId, body: { ...parsed.data, modelId } });
    } catch {
      this.finishWithError(requestId, stream, "Local model source unavailable");
    }
  }

  private readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | null> {
    const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>();
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > LOCAL_MODEL_MAX_REQUEST_BYTES) {
        cleanup();
        this.fail(response, "Local model request too large", 413);
        request.resume();
        resolve(null);
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      resolve(null);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    return promise;
  }

  private finishWithError(
    requestId: string,
    stream: PendingStream,
    message: string,
    status = 502,
  ): void {
    this.pending.delete(requestId);
    this.fail(stream.response, message, status);
    this.cancel(stream.owner, requestId);
  }

  private cancel(owner: Owner, requestId: string): void {
    try {
      owner.emit({ type: "cancel", requestId });
    } catch {
      /* disconnected owner */
    }
  }

  private fail(response: ServerResponse, message: string, status = 502): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          error: {
            type:
              status === LOCAL_MODEL_UNAVAILABLE_STATUS
                ? "local_model_source_unavailable"
                : "local_model_error",
            message,
          },
        }),
      );
    }
  }
}
