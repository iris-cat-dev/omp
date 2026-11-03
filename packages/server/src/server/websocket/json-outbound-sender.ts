import {
  encodeJsonMessageChunk,
  JSON_MESSAGE_CHUNK_HEADER_BYTES,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
} from "@omp-desktop/protocol/binary-frames/index";
import {
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  sendBoundedPhysicalFrame,
  sendBoundedPhysicalFrameAndWait,
  type BoundedPhysicalSocket,
} from "./physical-socket.js";

// Waiting work is separate from the one active logical response: a valid
// response larger than the physical backstop must not count as socket backlog.
export const MAX_QUEUED_JSON_BYTES = 128 * 1024 * 1024;
export const MAX_QUEUED_JSON_MESSAGES = 128;
export const MAX_QUEUED_JSON_ERROR_BYTES = 64 * 1024;
export const MAX_QUEUED_JSON_ERRORS = 16;
const MAX_JSON_TOTAL_BYTES = 0xffff_ffff;
const CHUNK_PAYLOAD_BYTES = MAX_JSON_MESSAGE_CHUNK_BYTES - JSON_MESSAGE_CHUNK_HEADER_BYTES;

export interface OutboundJsonMetadata {
  messageType: string;
  requestId?: string;
  agentStreamType?: string;
  agentStreamAgentId?: string;
}

interface PendingJsonMessage {
  json: string;
  byteLength: number;
  metadata: OutboundJsonMetadata;
  reservedError: boolean;
}

export type JsonSendResult = "accepted" | "closed" | "too_large" | "queue_full";

export class JsonOutboundSender {
  private chunkedJsonMessages = false;
  private disposed = false;
  private sending = false;
  private nextMessageId = 0;
  private readonly abort = new AbortController();
  private readonly queue: PendingJsonMessage[] = [];
  private queuedBytes = 0;
  private queuedMessages = 0;
  private queuedErrorBytes = 0;
  private queuedErrors = 0;
  private immediateSends = 0;
  private immediateDrain: PromiseWithResolvers<void> | null = null;

  constructor(
    private readonly socket: BoundedPhysicalSocket,
    private readonly onHighWater: (frameBytes: number, metadata: OutboundJsonMetadata) => void,
    private readonly onSendError: (error: Error, metadata: OutboundJsonMetadata) => void,
    private readonly onSent?: (metadata: OutboundJsonMetadata) => void,
  ) {}

  setChunkedJsonMessages(enabled: boolean): void {
    this.chunkedJsonMessages = enabled;
  }

  get maxMessageBytes(): number {
    return this.chunkedJsonMessages ? MAX_JSON_TOTAL_BYTES : MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
  }

  send(
    json: string,
    byteLength: number,
    metadata: OutboundJsonMetadata,
    reservedError = false,
  ): JsonSendResult {
    if (this.disposed || this.socket.readyState !== 1) return "closed";
    if (byteLength > this.maxMessageBytes) return "too_large";

    // ws preserves wire order for immediate writes. Keep the ordinary path
    // synchronous until a fragmented message requires callback-paced writes.
    if (!this.sending && byteLength <= MAX_JSON_MESSAGE_CHUNK_BYTES) {
      return this.sendImmediate(json, byteLength, metadata);
    }
    if (!this.chunkedJsonMessages && !this.sending) {
      return this.sendImmediate(json, byteLength, metadata);
    }

    const message = { json, byteLength, metadata, reservedError };
    if (!this.sending) {
      this.sending = true;
      void this.drain(message);
      return "accepted";
    }
    if (reservedError) {
      if (
        this.queuedErrors >= MAX_QUEUED_JSON_ERRORS ||
        this.queuedErrorBytes + byteLength > MAX_QUEUED_JSON_ERROR_BYTES
      ) {
        return "queue_full";
      }
      this.queuedErrors += 1;
      this.queuedErrorBytes += byteLength;
    } else {
      if (
        this.queuedMessages >= MAX_QUEUED_JSON_MESSAGES ||
        this.queuedBytes + byteLength > MAX_QUEUED_JSON_BYTES
      ) {
        return "queue_full";
      }
      this.queuedMessages += 1;
      this.queuedBytes += byteLength;
    }
    this.queue.push(message);
    return "accepted";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.queuedErrorBytes = 0;
    this.queuedErrors = 0;
    // A transport may never invoke a pending callback after disconnecting.
    // Abort that wait so the current JSON and chunk scratch are released too.
    const disconnected = new Error("Physical WebSocket disconnected");
    this.immediateDrain?.reject(disconnected);
    this.immediateDrain = null;
    this.abort.abort(disconnected);
  }

  private sendImmediate(
    json: string,
    byteLength: number,
    metadata: OutboundJsonMetadata,
  ): JsonSendResult {
    this.immediateSends += 1;
    let completed = false;
    const finishImmediate = () => {
      if (completed) return;
      completed = true;
      this.immediateSends -= 1;
      if (this.immediateSends === 0) {
        this.immediateDrain?.resolve();
        this.immediateDrain = null;
      }
    };
    try {
      const sent = sendBoundedPhysicalFrame({
        socket: this.socket,
        frame: json,
        frameBytes: byteLength,
        onHighWater: () => this.onHighWater(byteLength, metadata),
        onError: (error) => {
          finishImmediate();
          if (this.disposed) return;
          this.dispose();
          this.onSendError(error, metadata);
        },
        onSent: () => {
          finishImmediate();
          if (!this.disposed) this.onSent?.(metadata);
        },
      });
      if (!sent) finishImmediate();
      return sent ? "accepted" : "closed";
    } catch (error) {
      finishImmediate();
      this.dispose();
      this.onSendError(error instanceof Error ? error : new Error(String(error)), metadata);
      return "closed";
    }
  }

  private async drain(current: PendingJsonMessage | undefined): Promise<void> {
    try {
      if (this.immediateSends > 0) {
        this.immediateDrain = Promise.withResolvers<void>();
        await this.immediateDrain.promise;
      }
      while (current && !this.disposed) {
        if (current.byteLength <= MAX_JSON_MESSAGE_CHUNK_BYTES) {
          const { byteLength, metadata } = current;
          const sent = await sendBoundedPhysicalFrameAndWait({
            socket: this.socket,
            frame: current.json,
            frameBytes: current.byteLength,
            signal: this.abort.signal,
            onHighWater: () => this.onHighWater(byteLength, metadata),
          });
          if (!sent) {
            this.dispose();
            return;
          }
        } else {
          await this.sendChunks(current);
        }
        if (this.disposed) return;
        this.onSent?.(current.metadata);
        current = this.queue.shift();
        if (current?.reservedError) {
          this.queuedErrors -= 1;
          this.queuedErrorBytes -= current.byteLength;
        } else if (current) {
          this.queuedMessages -= 1;
          this.queuedBytes -= current.byteLength;
        }
      }
    } catch (error) {
      if (!this.disposed && current) {
        const metadata = current.metadata;
        this.dispose();
        this.onSendError(error instanceof Error ? error : new Error(String(error)), metadata);
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendChunks(message: PendingJsonMessage): Promise<void> {
    const messageId = this.nextMessageId;
    this.nextMessageId = (messageId + 1) >>> 0;
    const encoder = new TextEncoder();
    const frameBuffer = new Uint8Array(MAX_JSON_MESSAGE_CHUNK_BYTES);
    const scratch = frameBuffer.subarray(JSON_MESSAGE_CHUNK_HEADER_BYTES);
    let characterOffset = 0;
    let byteOffset = 0;
    while (byteOffset < message.byteLength) {
      // Slice at most one chunk's code units, never the full remaining JSON.
      // Do not turn a surrogate split at the slice edge into replacement UTF-8.
      let end = Math.min(message.json.length, characterOffset + CHUNK_PAYLOAD_BYTES);
      if (end < message.json.length) {
        const last = message.json.charCodeAt(end - 1);
        const next = message.json.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      }
      const { read, written } = encoder.encodeInto(
        message.json.slice(characterOffset, end),
        scratch,
      );
      if (written === 0) throw new Error("JSON chunk encoder made no progress");
      const frame = encodeJsonMessageChunk(
        {
          messageId,
          totalBytes: message.byteLength,
          offset: byteOffset,
          payload: scratch.subarray(0, written),
        },
        frameBuffer,
      );
      const sent = await sendBoundedPhysicalFrameAndWait({
        socket: this.socket,
        frame,
        frameBytes: frame.byteLength,
        signal: this.abort.signal,
        onHighWater: () => this.onHighWater(frame.byteLength, message.metadata),
      });
      if (!sent) {
        this.dispose();
        return;
      }
      characterOffset += read;
      byteOffset += written;
    }
  }
}
