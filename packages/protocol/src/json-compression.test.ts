import { gzipSync, gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { encodeJsonMessageChunk } from "./binary-frames/json-message.js";
import {
  COMPRESSED_JSON_OPCODE,
  compressJsonFrame,
  decompressJsonFrame,
  MAX_COMPRESSED_JSON_DECODED_BYTES,
} from "./json-compression.js";

function gzipFrame(bytes: Uint8Array, kind = 0, expectedBytes = bytes.byteLength): Uint8Array {
  const gzip = gzipSync(bytes);
  const frame = new Uint8Array(6 + gzip.byteLength);
  frame[0] = COMPRESSED_JSON_OPCODE;
  frame[1] = kind;
  new DataView(frame.buffer).setUint32(2, expectedBytes);
  frame.set(gzip, 6);
  return frame;
}

test("large Unicode JSON uses standard gzip without changing any characters", async () => {
  const json = JSON.stringify({ text: '中文🙂"\\\n'.repeat(20_000) });
  const encoded = await compressJsonFrame(json);
  expect(encoded).not.toBeNull();
  expect(gunzipSync(encoded!.subarray(6)).toString("utf8")).toBe(json);
  expect(await decompressJsonFrame(gzipFrame(new TextEncoder().encode(json)))).toBe(json);
});

test("independent JSON chunks retain their binary headers and split UTF-8 bytes", async () => {
  const chunk = encodeJsonMessageChunk({
    messageId: 19,
    totalBytes: 400_000,
    offset: 1,
    payload: new Uint8Array(64 * 1024).fill(0x80),
  });
  const compressed = await compressJsonFrame(chunk);
  expect(await decompressJsonFrame(compressed!)).toEqual(chunk);
});

test("small JSON and incompressible chunks retain their original wire format", async () => {
  expect(await compressJsonFrame('{"text":"中文🙂"}')).toBeNull();
  const payload = new Uint8Array(64 * 1024);
  let state = 0x12345678;
  for (let index = 0; index < payload.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[index] = state & 0xff;
  }
  const chunk = encodeJsonMessageChunk({
    messageId: 1,
    totalBytes: payload.length,
    offset: 0,
    payload,
  });
  expect(await compressJsonFrame(chunk)).toBeNull();
});

test("gzip corruption, truncated bodies and forged output sizes fail explicitly", async () => {
  const payload = new TextEncoder().encode("bounded output".repeat(10_000));
  const frame = gzipFrame(payload);
  const corrupt = frame.slice();
  corrupt[corrupt.length - 1] ^= 0xff;
  await expect(decompressJsonFrame(corrupt)).rejects.toThrow();
  await expect(decompressJsonFrame(frame.subarray(0, frame.length - 4))).rejects.toThrow();
  await expect(decompressJsonFrame(gzipFrame(payload, 0, 1))).rejects.toThrow("size mismatch");
  await expect(decompressJsonFrame(gzipFrame(payload, 0, payload.length + 1))).rejects.toThrow(
    "size mismatch",
  );
  await expect(
    decompressJsonFrame(gzipFrame(payload, 0, MAX_COMPRESSED_JSON_DECODED_BYTES + 1)),
  ).rejects.toThrow("limit");
});

test("compressed envelopes cannot smuggle terminal frames, unknown kinds or invalid UTF-8", async () => {
  await expect(compressJsonFrame(new Uint8Array([1, 2, 3]))).rejects.toThrow("Only JSON");
  await expect(decompressJsonFrame(gzipFrame(new Uint8Array([1, 2, 3]), 1))).rejects.toThrow(
    "not a JSON chunk",
  );
  await expect(decompressJsonFrame(gzipFrame(new Uint8Array([1]), 2))).rejects.toThrow(
    "Invalid compressed",
  );
  await expect(decompressJsonFrame(gzipFrame(new Uint8Array([0xc3, 0x28])))).rejects.toThrow();
});
