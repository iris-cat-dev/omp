import { expect, test, vi } from "vitest";
import {
  decodeJsonMessageChunk,
  JsonMessageReassembler,
  MAX_JSON_MESSAGE_CHUNK_BYTES,
} from "@omp-desktop/protocol/binary-frames/index";
import {
  JsonOutboundSender,
  MAX_QUEUED_JSON_BYTES,
  MAX_QUEUED_JSON_MESSAGES,
  MAX_QUEUED_JSON_ERRORS,
  MAX_QUEUED_JSON_ERROR_BYTES,
} from "./json-outbound-sender.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./physical-socket.js";

class ControlledSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly frames: Array<string | Uint8Array | ArrayBuffer> = [];
  readonly callbacks: Array<(error?: Error) => void> = [];

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    // Snapshot accepted bytes so later assertions can inspect completed
    // frames after the sender safely reuses its chunk buffer.
    if (typeof data === "string") this.frames.push(data);
    else if (data instanceof ArrayBuffer) this.frames.push(new Uint8Array(data.slice(0)));
    else this.frames.push(data.slice());
    if (callback) this.callbacks.push(callback);
  }

  async complete(error?: Error): Promise<void> {
    const callback = this.callbacks.shift();
    expect(callback).toBeDefined();
    callback?.(error);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

const metadata = { messageType: "fetch_agent_timeline_response", requestId: "history" };
const fragmentedJson = JSON.stringify({ history: "中😀".repeat(100_000) });

async function finish(socket: ControlledSocket): Promise<void> {
  for (let index = 0; index < 256 && socket.callbacks.length > 0; index += 1) {
    await socket.complete();
  }
  expect(socket.callbacks).toHaveLength(0);
}

function receivedJson(socket: ControlledSocket): string[] {
  const reassembler = new JsonMessageReassembler();
  const messages: string[] = [];
  for (const frame of socket.frames) {
    if (typeof frame === "string") {
      messages.push(frame);
      continue;
    }
    const chunk = decodeJsonMessageChunk(
      frame instanceof Uint8Array ? frame : new Uint8Array(frame),
    );
    expect(chunk).not.toBeNull();
    if (!chunk) throw new Error("Expected a JSON chunk");
    const completed = reassembler.push(chunk);
    if (completed) messages.push(completed.json);
  }
  return messages;
}

test("callback-paced chunks preserve Unicode and order with concurrent small and large JSON", async () => {
  const socket = new ControlledSocket();
  const onSent = vi.fn();
  const onError = vi.fn();
  const sender = new JsonOutboundSender(socket, vi.fn(), onError, onSent);
  sender.setChunkedJsonMessages(true);
  const directory = JSON.stringify({ directory: ["src", "中"] });
  const secondHistory = JSON.stringify({ history: "second".repeat(60_000) });

  expect(sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata)).toBe("accepted");
  expect(sender.send(directory, Buffer.byteLength(directory), { messageType: "directory" })).toBe(
    "accepted",
  );
  expect(
    sender.send(secondHistory, Buffer.byteLength(secondHistory), {
      ...metadata,
      requestId: "second",
    }),
  ).toBe("accepted");
  expect(socket.frames).toHaveLength(1);
  expect(onSent).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(socket.frames).toHaveLength(1);
  await socket.complete();
  expect(socket.frames).toHaveLength(2);
  expect(onSent).not.toHaveBeenCalled();

  await finish(socket);
  expect(receivedJson(socket)).toEqual([fragmentedJson, directory, secondHistory]);
  expect(onSent.mock.calls.map(([sent]) => sent.requestId)).toEqual([
    "history",
    undefined,
    "second",
  ]);
  expect(onError).not.toHaveBeenCalled();
  for (const frame of socket.frames) {
    if (typeof frame !== "string")
      expect(frame.byteLength).toBeLessThanOrEqual(MAX_JSON_MESSAGE_CHUNK_BYTES);
  }
});

test("disconnect aborts a stalled callback and queued work without blocking another or replacement socket", async () => {
  const stale = new ControlledSocket();
  const onError = vi.fn();
  const onSent = vi.fn();
  const onDrain = vi.fn();
  const sender = new JsonOutboundSender(stale, vi.fn(), onError, onSent, onDrain);
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  sender.send('"old queued response"', 21, { messageType: "queued" });

  const replacement = new ControlledSocket();
  const replacementSender = new JsonOutboundSender(replacement, vi.fn(), vi.fn());
  replacementSender.setChunkedJsonMessages(true);
  expect(replacementSender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata)).toBe(
    "accepted",
  );
  expect(replacement.frames).toHaveLength(1);
  sender.dispose();
  await stale.complete();
  expect(stale.frames).toHaveLength(1);
  expect(sender.send('"late"', 6, metadata)).toBe("closed");
  expect(onError).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(onDrain).not.toHaveBeenCalled();

  await finish(replacement);
  expect(receivedJson(replacement)).toEqual([fragmentedJson]);
});

test("waiting count is bounded and reserved RPC errors remain FIFO behind accepted responses", async () => {
  const socket = new ControlledSocket();
  const sender = new JsonOutboundSender(socket, vi.fn(), vi.fn());
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  const queued: string[] = [];
  for (let index = 0; index < MAX_QUEUED_JSON_MESSAGES; index += 1) {
    const json = JSON.stringify({ index });
    queued.push(json);
    expect(sender.send(json, Buffer.byteLength(json), { messageType: "queued" })).toBe("accepted");
  }
  expect(sender.send('"overflow"', 10, metadata)).toBe("queue_full");
  expect(sender.rejectionLogFields(10)).toMatchObject({
    queuedMessages: MAX_QUEUED_JSON_MESSAGES,
    queuedBytes: queued.reduce((bytes, json) => bytes + Buffer.byteLength(json), 0),
    queuedErrors: 0,
    queuedErrorBytes: 0,
    queueBoundary: "messages",
    queueReserve: "ordinary",
    activeMessageType: metadata.messageType,
    activeElapsedMs: expect.any(Number),
    oldestQueuedWaitMs: expect.any(Number),
  });
  const errors: string[] = [];
  for (let index = 0; index < MAX_QUEUED_JSON_ERRORS; index += 1) {
    const json = JSON.stringify({ error: index });
    errors.push(json);
    expect(sender.send(json, Buffer.byteLength(json), { messageType: "rpc_error" }, true)).toBe(
      "accepted",
    );
  }
  expect(sender.send('"overflow"', 10, metadata, true)).toBe("queue_full");
  expect(sender.rejectionLogFields(10, true)).toMatchObject({
    queuedErrors: MAX_QUEUED_JSON_ERRORS,
    queueBoundary: "messages",
    queueReserve: "error",
  });
  await finish(socket);
  expect(receivedJson(socket)).toEqual([fragmentedJson, ...queued, ...errors]);
  expect(sender.send('"recovered"', 11, metadata)).toBe("accepted");
  await finish(socket);
});

test("waiting UTF-8 bytes and the separate error reserve are bounded independently of active JSON", () => {
  const socket = new ControlledSocket();
  const sender = new JsonOutboundSender(socket, vi.fn(), vi.fn());
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  // Reuse one real string, keeping the fixture small while exercising the
  // retained-byte budget rather than allocating a 128 MiB test history.
  const json = JSON.stringify("x".repeat(2 * 1024 * 1024 - 2));
  const bytes = Buffer.byteLength(json);
  for (let index = 0; index < MAX_QUEUED_JSON_BYTES / bytes; index += 1) {
    expect(sender.send(json, bytes, metadata)).toBe("accepted");
  }
  expect(sender.send('"more"', 6, metadata)).toBe("queue_full");
  expect(sender.rejectionLogFields(6)).toMatchObject({
    queuedBytes: MAX_QUEUED_JSON_BYTES,
    queueBoundary: "bytes",
  });
  const largeError = JSON.stringify("中".repeat(MAX_QUEUED_JSON_ERROR_BYTES / 3));
  expect(sender.send(largeError, Buffer.byteLength(largeError), metadata, true)).toBe("queue_full");
  expect(sender.send('"retry"', 7, { messageType: "rpc_error" }, true)).toBe("accepted");
  sender.dispose();
});

test("physical high-water still rejects actual chunk bytes with request metadata", () => {
  const socket = new ControlledSocket();
  socket.bufferedAmount = MAX_PHYSICAL_SOCKET_BUFFERED_BYTES - 1;
  const highWater = vi.fn();
  const sender = new JsonOutboundSender(
    socket,
    (bytes, message) => {
      highWater(bytes, message);
      sender.dispose();
      socket.readyState = 3;
    },
    vi.fn(),
  );
  sender.setChunkedJsonMessages(true);
  const json = JSON.stringify("x".repeat(MAX_JSON_MESSAGE_CHUNK_BYTES));
  sender.send(json, Buffer.byteLength(json), metadata);
  expect(socket.frames).toEqual([]);
  expect(highWater).toHaveBeenCalledWith(MAX_JSON_MESSAGE_CHUNK_BYTES, metadata);
});

test("callback failure stops fragmentation and reports rather than swallowing the send error", async () => {
  const socket = new ControlledSocket();
  const onError = vi.fn();
  const onSent = vi.fn();
  const onDrain = vi.fn();
  const sender = new JsonOutboundSender(socket, vi.fn(), onError, onSent, onDrain);
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  sender.send('"queued"', 8, metadata);
  const error = new Error("physical send failed");
  await socket.complete(error);
  expect(onError).toHaveBeenCalledWith(error, metadata);
  expect(onSent).not.toHaveBeenCalled();
  expect(socket.frames).toHaveLength(1);
  expect(sender.send('"late"', 6, metadata)).toBe("closed");
  expect(onDrain).not.toHaveBeenCalled();
});

test("Promise transports pace chunks and surface rejection without sending queued JSON", async () => {
  const sends: Array<PromiseWithResolvers<void>> = [];
  let frameCount = 0;
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (_frame: string | Uint8Array | ArrayBuffer) => {
      frameCount += 1;
      const completion = Promise.withResolvers<void>();
      sends.push(completion);
      return completion.promise;
    },
  };
  const onError = vi.fn();
  const sender = new JsonOutboundSender(socket, vi.fn(), onError);
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  sender.send('"queued"', 8, metadata);
  expect(frameCount).toBe(1);
  sends[0]!.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(frameCount).toBe(2);
  const error = new Error("relay send failed");
  sends[1]!.reject(error);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(onError).toHaveBeenCalledWith(error, metadata);
  expect(frameCount).toBe(2);
});

test("ordinary JSON keeps its text frame and records completion only after the physical callback", async () => {
  const socket = new ControlledSocket();
  const onSent = vi.fn();
  const onError = vi.fn();
  const onDrain = vi.fn();
  const sender = new JsonOutboundSender(socket, vi.fn(), onError, onSent, onDrain);
  sender.setChunkedJsonMessages(false);
  const json = JSON.stringify({ response: "small" });
  expect(sender.send(json, Buffer.byteLength(json), metadata)).toBe("accepted");
  expect(socket.frames).toEqual([json]);
  expect(onSent).not.toHaveBeenCalled();
  await socket.complete();
  expect(onSent).toHaveBeenCalledWith(metadata);
  expect(onDrain).not.toHaveBeenCalled();
  sender.send(json, Buffer.byteLength(json), metadata);
  const error = new Error("ordinary send failed");
  await socket.complete(error);
  expect(onError).toHaveBeenCalledWith(error, metadata);
  expect(onSent).toHaveBeenCalledTimes(1);
});

test("fragmentation waits for earlier immediate JSON callbacks without delaying other sockets", async () => {
  const socket = new ControlledSocket();
  const sender = new JsonOutboundSender(socket, vi.fn(), vi.fn());
  sender.setChunkedJsonMessages(true);
  const first = JSON.stringify({ first: true });
  const second = JSON.stringify({ second: true });
  sender.send(first, Buffer.byteLength(first), { messageType: "first" });
  sender.send(second, Buffer.byteLength(second), { messageType: "second" });
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  expect(socket.frames).toEqual([first, second]);

  const other = new ControlledSocket();
  const otherSender = new JsonOutboundSender(other, vi.fn(), vi.fn());
  otherSender.setChunkedJsonMessages(true);
  otherSender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  expect(other.frames).toHaveLength(1);
  otherSender.dispose();
  await socket.complete();
  expect(socket.frames).toHaveLength(2);
  await socket.complete();
  expect(socket.frames).toHaveLength(3);
  await finish(socket);
  expect(receivedJson(socket)).toEqual([first, second, fragmentedJson]);
});

test("drain runs after all accepted FIFO work and can synchronously start another async drain", async () => {
  const socket = new ControlledSocket();
  const onError = vi.fn();
  let drains = 0;
  const tail = '"queued during drain callback"';
  const sender = new JsonOutboundSender(socket, vi.fn(), onError, undefined, () => {
    drains += 1;
    expect(sender.rejectionLogFields(0)).toMatchObject({
      queuedMessages: 0,
      queuedBytes: 0,
      queuedErrors: 0,
      queuedErrorBytes: 0,
      activeMessageType: undefined,
    });
    if (drains === 1) {
      expect(sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata)).toBe(
        "accepted",
      );
      expect(sender.send(tail, Buffer.byteLength(tail), { messageType: "tail" })).toBe("accepted");
    }
  });
  sender.setChunkedJsonMessages(true);
  sender.send(fragmentedJson, Buffer.byteLength(fragmentedJson), metadata);
  sender.send('"before drain"', 14, { messageType: "queued" });
  expect(drains).toBe(0);
  await finish(socket);
  expect(drains).toBe(2);
  expect(receivedJson(socket)).toEqual([fragmentedJson, '"before drain"', fragmentedJson, tail]);
  expect(onError).not.toHaveBeenCalled();
});
