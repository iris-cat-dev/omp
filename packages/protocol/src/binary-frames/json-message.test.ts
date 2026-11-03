import { describe, expect, it } from "vitest";
import {
  JSON_MESSAGE_CHUNK_HEADER_BYTES,
  JSON_MESSAGE_CHUNK_OPCODE,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
  JsonMessageReassembler,
  decodeJsonMessageChunk,
  encodeJsonMessageChunk,
  type JsonMessageChunk,
} from "./json-message.js";

const encoder = new TextEncoder();

describe("JSON message chunk codec", () => {
  it("uses big-endian byte offsets and decodes views without copying the payload", () => {
    const chunk = {
      messageId: 0x12345678,
      totalBytes: 0x10203040,
      offset: 0x01020304,
      payload: encoder.encode("中"),
    };
    const encoded = encodeJsonMessageChunk(chunk);
    expect(Array.from(encoded.subarray(0, JSON_MESSAGE_CHUNK_HEADER_BYTES))).toEqual([
      JSON_MESSAGE_CHUNK_OPCODE,
      0x12,
      0x34,
      0x56,
      0x78,
      0x10,
      0x20,
      0x30,
      0x40,
      0x01,
      0x02,
      0x03,
      0x04,
    ]);
    const container = new Uint8Array(encoded.byteLength + 7);
    container.set(encoded, 7);
    const decoded = decodeJsonMessageChunk(container.subarray(7));
    expect(decoded).toEqual(chunk);
    expect(decoded?.payload.buffer).toBe(container.buffer);
  });

  it("encodes into offset target views and preserves aliased or overlapping payloads", () => {
    const backing = new Uint8Array(64).fill(0x7f);
    const target = backing.subarray(7, 57);
    const payload = encoder.encode("中🙂");
    target.set(payload, JSON_MESSAGE_CHUNK_HEADER_BYTES);
    const chunk = {
      messageId: 1,
      totalBytes: payload.byteLength,
      offset: 0,
      payload: target.subarray(
        JSON_MESSAGE_CHUNK_HEADER_BYTES,
        JSON_MESSAGE_CHUNK_HEADER_BYTES + payload.byteLength,
      ),
    };
    const encoded = encodeJsonMessageChunk(chunk, target);
    expect(encoded.buffer).toBe(backing.buffer);
    expect(encoded.byteOffset).toBe(target.byteOffset);
    expect(encoded.byteLength).toBe(JSON_MESSAGE_CHUNK_HEADER_BYTES + payload.byteLength);
    expect(decodeJsonMessageChunk(encoded)).toEqual({ ...chunk, payload });
    expect(backing.subarray(0, 7)).toEqual(new Uint8Array(7).fill(0x7f));
    expect(backing.subarray(7 + encoded.byteLength)).toEqual(
      new Uint8Array(64 - 7 - encoded.byteLength).fill(0x7f),
    );

    target.set(payload, 0);
    const overlapping = { ...chunk, payload: target.subarray(0, payload.byteLength) };
    expect(decodeJsonMessageChunk(encodeJsonMessageChunk(overlapping, target))?.payload).toEqual(
      payload,
    );
    expect(() =>
      encodeJsonMessageChunk(chunk, target.subarray(0, JSON_MESSAGE_CHUNK_HEADER_BYTES)),
    ).toThrow(/too small/);
  });

  it("accepts the exact frame limit but rejects empty, oversized, and overflowing chunks", () => {
    const payload = new Uint8Array(MAX_JSON_MESSAGE_CHUNK_BYTES - JSON_MESSAGE_CHUNK_HEADER_BYTES);
    const chunk = { messageId: 0xffffffff, totalBytes: payload.byteLength, offset: 0, payload };
    expect(encodeJsonMessageChunk(chunk).byteLength).toBe(MAX_JSON_MESSAGE_CHUNK_BYTES);
    expect(decodeJsonMessageChunk(encodeJsonMessageChunk(chunk))).toEqual(chunk);
    for (const invalid of [
      { ...chunk, messageId: -1 },
      { ...chunk, messageId: 0x100000000 },
      { ...chunk, totalBytes: 0 },
      { ...chunk, totalBytes: 1.5 },
      { ...chunk, totalBytes: 0x100000000 },
      { ...chunk, offset: 1 },
      { ...chunk, payload: new Uint8Array(0) },
      { ...chunk, payload: new Uint8Array(payload.byteLength + 1) },
    ]) {
      expect(() => encodeJsonMessageChunk(invalid)).toThrow();
    }
    const encoded = encodeJsonMessageChunk({
      messageId: 1,
      totalBytes: 1,
      offset: 0,
      payload: encoder.encode("a"),
    });
    expect(decodeJsonMessageChunk(encoded.subarray(0, JSON_MESSAGE_CHUNK_HEADER_BYTES))).toBeNull();
    expect(decodeJsonMessageChunk(new Uint8Array(MAX_JSON_MESSAGE_CHUNK_BYTES + 1))).toBeNull();
    encoded[0] = 0x21;
    expect(decodeJsonMessageChunk(encoded)).toBeNull();
    encoded[0] = JSON_MESSAGE_CHUNK_OPCODE;
    const header = new DataView(encoded.buffer);
    header.setUint32(5, 0);
    expect(decodeJsonMessageChunk(encoded)).toBeNull();
    header.setUint32(5, 0xffffffff);
    header.setUint32(9, 0xffffffff);
    expect(decodeJsonMessageChunk(encoded)).toBeNull();
  });
});

describe("JSON message reassembly", () => {
  it("completes single and multi-frame messages only after all UTF-8 bytes arrive", () => {
    const reassembler = new JsonMessageReassembler();
    for (const json of ['{"ok":true}', '{"text":"中🙂é"}']) {
      const bytes = encoder.encode(json);
      for (let offset = 0; offset < bytes.byteLength; offset += 1) {
        const result = reassembler.push({
          messageId: 1,
          totalBytes: bytes.byteLength,
          offset,
          payload: bytes.subarray(offset, offset + 1),
        });
        expect(result).toEqual(
          offset + 1 === bytes.byteLength ? { json, byteLength: bytes.byteLength } : null,
        );
      }
      expect(
        reassembler.push({ messageId: 2, totalBytes: bytes.byteLength, offset: 0, payload: bytes }),
      ).toEqual({ json, byteLength: bytes.byteLength });
    }
  });

  it.each(["gap", "duplicate", "total", "id"])(
    "rejects %s and releases the partial message",
    (violation) => {
      const reassembler = new JsonMessageReassembler();
      const first: JsonMessageChunk = {
        messageId: 1,
        totalBytes: 3,
        offset: 0,
        payload: encoder.encode("a"),
      };
      expect(reassembler.push(first)).toBeNull();
      const next = { ...first, offset: 1 };
      if (violation === "gap") next.offset = 2;
      if (violation === "duplicate") next.offset = 0;
      if (violation === "total") next.totalBytes = 4;
      if (violation === "id") next.messageId = 2;
      expect(() => reassembler.push(next)).toThrow();
      expect(
        reassembler.push({ messageId: 3, totalBytes: 2, offset: 0, payload: encoder.encode("{}") }),
      ).toEqual({ json: "{}", byteLength: 2 });
    },
  );

  it("rejects a missing first chunk, invalid headers, and malformed or incomplete UTF-8", () => {
    const reassembler = new JsonMessageReassembler();
    expect(() =>
      reassembler.push({ messageId: 1, totalBytes: 2, offset: 1, payload: encoder.encode("}") }),
    ).toThrow();
    for (const payload of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0xe4, 0xb8]),
    ]) {
      expect(() =>
        reassembler.push({ messageId: 1, totalBytes: payload.byteLength, offset: 0, payload }),
      ).toThrow();
      expect(
        reassembler.push({ messageId: 2, totalBytes: 2, offset: 0, payload: encoder.encode("{}") }),
      ).toEqual({ json: "{}", byteLength: 2 });
    }
    expect(
      reassembler.push({ messageId: 1, totalBytes: 3, offset: 0, payload: new Uint8Array([0xe4]) }),
    ).toBeNull();
    expect(() =>
      reassembler.push({ messageId: 1, totalBytes: 3, offset: 1, payload: encoder.encode("ab") }),
    ).toThrow();
    expect(
      reassembler.push({ messageId: 2, totalBytes: 3, offset: 0, payload: encoder.encode("a") }),
    ).toBeNull();
    expect(() =>
      reassembler.push({ messageId: 2, totalBytes: 0, offset: 1, payload: encoder.encode("b") }),
    ).toThrow();
    expect(
      reassembler.push({ messageId: 3, totalBytes: 2, offset: 0, payload: encoder.encode("{}") }),
    ).toEqual({ json: "{}", byteLength: 2 });
  });

  it("clears partial UTF-8 on reset and allocates only for bytes actually received", () => {
    const reassembler = new JsonMessageReassembler();
    expect(
      reassembler.push({
        messageId: 1,
        totalBytes: 0xffffffff,
        offset: 0,
        payload: new Uint8Array([0xe4]),
      }),
    ).toBeNull();
    reassembler.reset();
    expect(() =>
      reassembler.push({
        messageId: 1,
        totalBytes: 0xffffffff,
        offset: 1,
        payload: new Uint8Array([0xb8]),
      }),
    ).toThrow();
    expect(
      reassembler.push({ messageId: 1, totalBytes: 2, offset: 0, payload: encoder.encode("{}") }),
    ).toEqual({ json: "{}", byteLength: 2 });
  });
});
