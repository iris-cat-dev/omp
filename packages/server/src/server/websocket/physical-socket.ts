// OOM backstop for a socket whose client stopped draining. A daemon normally has
// 1-10 physical sockets (tens at the outside), so 64 MiB bounds abandoned queues
// without treating ordinary large frames as a protocol or frame-size violation.
export const MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024;

export class PhysicalSocketHighWaterError extends Error {
  readonly limit = MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;

  constructor(
    readonly frameBytes: number,
    readonly bufferedAmount: number,
  ) {
    super("Physical WebSocket exceeded its outbound high-water mark");
    this.name = "PhysicalSocketHighWaterError";
  }
}

// Current clients ping every 10 seconds. Four delayed cycles fit inside the
// lease without making an abandoned application socket linger for minutes.
export const APPLICATION_SOCKET_LEASE_MS = 45_000;
export const APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS = 10_000;

type Clock = () => number;

export class ApplicationSocketLease<TSocket extends object> {
  private readonly deadlines = new Map<TSocket, number>();

  constructor(private readonly clock: Clock = Date.now) {}

  claim(socket: TSocket): void {
    this.deadlines.set(socket, this.clock() + APPLICATION_SOCKET_LEASE_MS);
  }

  renew(socket: TSocket): void {
    if (this.deadlines.has(socket)) {
      this.claim(socket);
    }
  }

  release(socket: TSocket): void {
    this.deadlines.delete(socket);
  }

  listExpired(): TSocket[] {
    const now = this.clock();
    const expired: TSocket[] = [];
    for (const [socket, deadline] of this.deadlines) {
      if (deadline > now) continue;
      expired.push(socket);
    }
    return expired;
  }

  clear(): void {
    this.deadlines.clear();
  }
}

export function outboundFrameByteLength(data: string | Uint8Array | ArrayBuffer): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

export interface BoundedPhysicalSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
}

export async function sendBoundedPhysicalFrameAndWait(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const {
    socket,
    frame,
    frameBytes = outboundFrameByteLength(frame),
    onHighWater,
    signal,
  } = params;
  if (signal?.aborted) throw signal.reason;
  if (socket.readyState !== 1) return false;
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    onHighWater();
    return false;
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    if (error) reject(error);
    else resolve();
  };
  const onAbort = () => settle(signal?.reason ?? new Error("Physical WebSocket send cancelled"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = socket.send(frame, (error) => settle(error));
    if (result && typeof result.then === "function") {
      void result.then(
        () => settle(),
        (error: unknown) => settle(error),
      );
    } else if (socket.send.length < 2) {
      settle();
    }
  } catch (error) {
    settle(error);
  }
  await promise;
  return true;
}

export function physicalSocketHasCapacity(
  socket: Pick<BoundedPhysicalSocket, "bufferedAmount">,
  frameBytes: number,
): boolean {
  if (typeof socket.bufferedAmount !== "number") return true;
  return socket.bufferedAmount + frameBytes <= MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
}

export function sendBoundedPhysicalFrame(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
  onError: (error: Error) => void;
  onSent?: () => void;
}): boolean {
  const {
    socket,
    frame,
    frameBytes = outboundFrameByteLength(frame),
    onHighWater,
    onError,
    onSent,
  } = params;
  if (socket.readyState !== 1) return false;
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    onHighWater();
    return false;
  }
  let settled = false;
  const complete = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (error) onError(error instanceof Error ? error : new Error(String(error)));
    else onSent?.();
  };
  const result = socket.send(frame, complete);
  if (result && typeof result.then === "function") {
    void result.then(() => complete(), complete);
  } else if (socket.send.length < 2) {
    complete();
  }
  return true;
}
