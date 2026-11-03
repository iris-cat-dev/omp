export const JSON_MESSAGE_CHUNK_OPCODE = 0x20;
export const JSON_MESSAGE_CHUNK_HEADER_BYTES = 13;
export const MAX_JSON_MESSAGE_CHUNK_BYTES = 256 * 1024;

export interface JsonMessageChunk {
  messageId: number;
  totalBytes: number;
  offset: number;
  payload: Uint8Array;
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isValidChunk(chunk: JsonMessageChunk): boolean {
  return (
    isUint32(chunk.messageId) &&
    isUint32(chunk.totalBytes) &&
    chunk.totalBytes > 0 &&
    isUint32(chunk.offset) &&
    chunk.payload.byteLength > 0 &&
    chunk.payload.byteLength <= MAX_JSON_MESSAGE_CHUNK_BYTES - JSON_MESSAGE_CHUNK_HEADER_BYTES &&
    chunk.offset + chunk.payload.byteLength <= chunk.totalBytes
  );
}

export function encodeJsonMessageChunk(chunk: JsonMessageChunk, target?: Uint8Array): Uint8Array {
  if (!isValidChunk(chunk)) {
    throw new Error("Invalid JSON message chunk");
  }
  const frameBytes = JSON_MESSAGE_CHUNK_HEADER_BYTES + chunk.payload.byteLength;
  if (target && target.byteLength < frameBytes) {
    throw new Error("JSON message chunk target is too small");
  }
  const bytes = target
    ? target.byteLength === frameBytes
      ? target
      : target.subarray(0, frameBytes)
    : new Uint8Array(frameBytes);
  if (
    chunk.payload.buffer !== bytes.buffer ||
    chunk.payload.byteOffset !== bytes.byteOffset + JSON_MESSAGE_CHUNK_HEADER_BYTES
  ) {
    // Copy before writing the header so other overlapping source views remain valid.
    bytes.set(chunk.payload, JSON_MESSAGE_CHUNK_HEADER_BYTES);
  }
  bytes[0] = JSON_MESSAGE_CHUNK_OPCODE;
  const header = new DataView(bytes.buffer, bytes.byteOffset, frameBytes);
  header.setUint32(1, chunk.messageId);
  header.setUint32(5, chunk.totalBytes);
  header.setUint32(9, chunk.offset);
  return bytes;
}

export function decodeJsonMessageChunk(bytes: Uint8Array): JsonMessageChunk | null {
  if (
    bytes[0] !== JSON_MESSAGE_CHUNK_OPCODE ||
    bytes.byteLength <= JSON_MESSAGE_CHUNK_HEADER_BYTES ||
    bytes.byteLength > MAX_JSON_MESSAGE_CHUNK_BYTES
  ) {
    return null;
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk: JsonMessageChunk = {
    messageId: header.getUint32(1),
    totalBytes: header.getUint32(5),
    offset: header.getUint32(9),
    payload: bytes.subarray(JSON_MESSAGE_CHUNK_HEADER_BYTES),
  };
  return isValidChunk(chunk) ? chunk : null;
}

export class JsonMessageReassembler {
  private partial: {
    messageId: number;
    totalBytes: number;
    receivedBytes: number;
    decoder: TextDecoder;
    parts: string[];
  } | null = null;

  push(chunk: JsonMessageChunk): { json: string; byteLength: number } | null {
    try {
      if (!isValidChunk(chunk)) {
        throw new Error("Invalid JSON message chunk");
      }
      if (!this.partial) {
        if (chunk.offset !== 0) {
          throw new Error("JSON message chunk does not start at offset zero");
        }
        // Retain only bytes actually received, never allocate from an untrusted totalBytes.
        this.partial = {
          messageId: chunk.messageId,
          totalBytes: chunk.totalBytes,
          receivedBytes: 0,
          decoder: new TextDecoder("utf-8", { fatal: true }),
          parts: [],
        };
      }
      const partial = this.partial;
      if (
        chunk.messageId !== partial.messageId ||
        chunk.totalBytes !== partial.totalBytes ||
        chunk.offset !== partial.receivedBytes
      ) {
        throw new Error("Out-of-order JSON message chunk");
      }
      partial.receivedBytes += chunk.payload.byteLength;
      const complete = partial.receivedBytes === partial.totalBytes;
      const text = partial.decoder.decode(chunk.payload, { stream: !complete });
      if (text.length > 0) partial.parts.push(text);
      if (!complete) return null;
      const result = { json: partial.parts.join(""), byteLength: partial.receivedBytes };
      this.reset();
      return result;
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  reset(): void {
    this.partial = null;
  }
}
