import { JSON_MESSAGE_CHUNK_OPCODE } from "./binary-frames/json-message.js";

export const COMPRESSED_JSON_OPCODE = 0x21;
export const JSON_COMPRESSION_THRESHOLD_BYTES = 32 * 1024;
export const MAX_COMPRESSED_JSON_DECODED_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 6;
const TEXT = 0;
const CHUNK = 1;

export function supportsJsonCompression(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/** Compress only JSON text and existing JSON chunks, before transport encryption. */
export async function compressJsonFrame(frame: string | Uint8Array): Promise<Uint8Array | null> {
  if (typeof frame === "string") {
    if (frame.length * 3 < JSON_COMPRESSION_THRESHOLD_BYTES) return null;
  } else if (frame[0] !== JSON_MESSAGE_CHUNK_OPCODE) {
    throw new Error("Only JSON frames can be compressed");
  }
  const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  if (
    bytes.byteLength < JSON_COMPRESSION_THRESHOLD_BYTES ||
    bytes.byteLength > MAX_COMPRESSED_JSON_DECODED_BYTES
  )
    return null;

  const compressed = await transform(bytes, new CompressionStream("gzip"), bytes.byteLength);
  if (compressed === null || compressed.byteLength + HEADER_BYTES >= bytes.byteLength) return null;
  const result = new Uint8Array(HEADER_BYTES + compressed.byteLength);
  result[0] = COMPRESSED_JSON_OPCODE;
  result[1] = typeof frame === "string" ? TEXT : CHUNK;
  new DataView(result.buffer).setUint32(2, bytes.byteLength);
  result.set(compressed, HEADER_BYTES);
  return result;
}

/** Reject invalid/oversized output while inflating, not after allocating from a wire length. */
export async function decompressJsonFrame(frame: Uint8Array): Promise<string | Uint8Array> {
  if (
    frame.byteLength <= HEADER_BYTES ||
    frame[0] !== COMPRESSED_JSON_OPCODE ||
    (frame[1] !== TEXT && frame[1] !== CHUNK)
  )
    throw new Error("Invalid compressed JSON frame");
  const expectedBytes = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2);
  if (expectedBytes === 0 || expectedBytes > MAX_COMPRESSED_JSON_DECODED_BYTES) {
    throw new Error("Compressed JSON decoded size exceeds the limit");
  }
  const decoded = await transform(
    frame.subarray(HEADER_BYTES),
    new DecompressionStream("gzip"),
    expectedBytes,
  );
  if (decoded === null || decoded.byteLength !== expectedBytes) {
    throw new Error("Compressed JSON decoded size mismatch");
  }
  if (frame[1] === TEXT) return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  if (decoded[0] !== JSON_MESSAGE_CHUNK_OPCODE) {
    throw new Error("Compressed binary frame is not a JSON chunk");
  }
  return decoded;
}

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    const input =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    await writer.write(input);
    await writer.close();
  })();
  // Attach the rejection handler before reading; a malformed gzip can reject both sides.
  const writeResult = writing.then(
    () => null,
    (error: unknown) => error,
  );
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        exceeded = true;
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
    }
    const writeError = await writeResult;
    if (exceeded) return null;
    if (writeError !== null) throw writeError;
    if (chunks.length === 1) return chunks[0]!;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}
