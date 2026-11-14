import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow, Display, Rectangle } from "electron";

const FILE_BYTES = 8 * 1024 * 1024;
const RECORD_BYTES = 128 * 1024;
const QUEUE_BYTES = 512 * 1024;
const POLL_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;
const EVENT_COALESCE_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 2_000;

type Metadata = Record<string, unknown>;
interface DiagnosticLogger {
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

function errorCode(error: unknown): string {
  const code = object(error)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** One bounded, ordered asynchronous write queue; a failed disk disables it once. */
export class RenderingJsonlWriter {
  private tail: Promise<unknown> = Promise.resolve();
  private queuedBytes = 0;
  private fileBytes: number | null = null;
  private failed = false;
  private closed = false;
  private overflowReported = false;
  private dropped = 0;
  readonly currentPath: string;

  constructor(
    private readonly options: {
      directory: string;
      logger: DiagnosticLogger;
      maxFileBytes?: number;
      maxRecordBytes?: number;
      maxQueuedBytes?: number;
    },
  ) {
    this.currentPath = path.join(options.directory, "rendering.jsonl");
  }

  append(record: Metadata, critical = false): Promise<boolean> {
    if (this.failed || this.closed) return Promise.resolve(false);
    const limit = Math.min(
      this.options.maxFileBytes ?? FILE_BYTES,
      this.options.maxRecordBytes ?? RECORD_BYTES,
    );
    let line = `${JSON.stringify(record)}\n`;
    let bytes = Buffer.byteLength(line);
    if (bytes > limit) {
      line = `${JSON.stringify({ type: "record-omitted", reason: "record-too-large", bytes })}\n`;
      bytes = Buffer.byteLength(line);
      if (bytes > limit) {
        this.options.logger.warn(
          "[render-diagnostics] Record limit cannot hold an omission marker",
        );
        return Promise.resolve(false);
      }
    }
    const queueLimit = this.options.maxQueuedBytes ?? QUEUE_BYTES;
    // Reserve one record for issue/quit markers, without allowing unlimited critical writes.
    if (this.queuedBytes + bytes > queueLimit + (critical ? limit : 0)) {
      this.dropped += 1;
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.options.logger.warn("[render-diagnostics] Write queue full; dropping bounded records");
      }
      return Promise.resolve(false);
    }
    this.queuedBytes += bytes;
    const write = this.tail
      .then(async () => {
        if (this.failed) return false;
        try {
          if (this.fileBytes === null) {
            await mkdir(this.options.directory, { recursive: true });
            try {
              this.fileBytes = (await stat(this.currentPath)).size;
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error;
              this.fileBytes = 0;
            }
          }
          if (this.fileBytes + bytes > (this.options.maxFileBytes ?? FILE_BYTES))
            await this.rotate();
          await appendFile(this.currentPath, line, "utf8");
          this.fileBytes += bytes;
          if (this.dropped > 0 && this.queuedBytes === bytes) {
            this.options.logger.warn("[render-diagnostics] Write queue recovered", {
              droppedRecords: this.dropped,
            });
            this.dropped = 0;
            this.overflowReported = false;
          }
          return true;
        } catch (error) {
          this.failed = true;
          this.options.logger.error(
            "[render-diagnostics] Local recorder disabled after file I/O failure",
            { code: errorCode(error) },
          );
          return false;
        }
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
    this.tail = write;
    return write;
  }

  private async rotate(): Promise<void> {
    const archive = (index: number) =>
      path.join(this.options.directory, `rendering.${index}.jsonl`);
    await rm(archive(3), { force: true });
    await ignoreMissing(rename(archive(2), archive(3)));
    await ignoreMissing(rename(archive(1), archive(2)));
    await ignoreMissing(rename(this.currentPath, archive(1)));
    this.fileBytes = 0;
  }

  flush(): Promise<unknown> {
    return this.tail;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}

interface PendingQuery {
  id: string;
  documentId: string;
  timeout: NodeJS.Timeout;
  timedOut: boolean;
}
interface ObservedWindow {
  window: BrowserWindow | null;
  id: string;
  webContentsId: number;
  documentId: bigint;
  pending: PendingQuery | null;
  unsupported: boolean;
  listeners: Array<() => void>;
  reasons: Set<string>;
  eventTimer: NodeJS.Timeout | undefined;
  eventSequences: Map<string, string>;
}

export interface RenderingDiagnosticsOptions {
  directory: string;
  enabled: boolean;
  identity: Metadata;
  runtimeDirectory: string;
  logger: DiagnosticLogger;
  getDisplayForBounds: (bounds: Rectangle) => Display;
  openDirectory: (directory: string) => Promise<string>;
}

function rectangle(bounds: Rectangle): Metadata {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function displayMetadata(display: Display): Metadata {
  return {
    id: display.id,
    bounds: rectangle(display.bounds),
    workArea: rectangle(display.workArea),
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
    displayFrequency: display.displayFrequency,
    colorDepth: display.colorDepth,
  };
}

function object(value: unknown): Metadata | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Metadata)
    : null;
}

const VERSION = /^[a-zA-Z0-9.+_-]{1,100}$/;
const DECIMAL = /^\d{1,20}$/;

/** Read only an adjacent, bounded distribution manifest, never argv or arbitrary files. */
async function runtimeIdentity(directory: string): Promise<Metadata> {
  let file: FileHandle | undefined;
  try {
    file = await open(path.join(directory, "version.json"), "r");
    if ((await file.stat()).size > RECORD_BYTES) return { status: "metadata-too-large" };
    const data = object(JSON.parse(await file.readFile("utf8")));
    if (!data) return { status: "metadata-invalid" };
    const result: Metadata = { status: "available" };
    for (const key of [
      "runtimeVersion",
      "electronApiVersion",
      "chromiumVersion",
      "platform",
      "arch",
      "gitRevision",
      "sourceRevision",
    ]) {
      if (typeof data[key] === "string" && VERSION.test(data[key])) result[key] = data[key];
    }
    if (
      typeof data.chromiumMajorVersion === "number" &&
      Number.isSafeInteger(data.chromiumMajorVersion)
    ) {
      result.chromiumMajorVersion = data.chromiumMajorVersion;
    }
    const executableHash = object(data.files)?.["electron.exe"];
    if (typeof executableHash === "string" && /^[a-f0-9]{64}$/.test(executableHash)) {
      result.distributionExecutableSha256 = executableHash;
    }
    const features = object(data.features);
    if (features) {
      const capabilities: Metadata = {};
      for (const key of ["renderingDiagnostics", "compositorDiagnostics"]) {
        if (typeof features[key] === "number" && Number.isSafeInteger(features[key]))
          capabilities[key] = features[key];
      }
      result.diagnosticsCapabilities = capabilities;
    }
    return result;
  } catch (error) {
    return {
      status: errorCode(error) === "ENOENT" ? "metadata-unavailable" : "metadata-unreadable",
      code: errorCode(error),
    };
  } finally {
    await file?.close().catch(() => {});
  }
}

// Schema-one native fields are numeric metadata only. Unknown fields are discarded,
// even if a future runtime accidentally includes page data in its private API.
const NATIVE_NUMBERS = [
  "rendererPid",
  "width",
  "height",
  "scale",
  "error",
  "imageCacheSize",
  "canvasSaveCount",
  "x",
  "y",
  "layerCount",
  "layerId",
  "pendingWidth",
  "pendingHeight",
  "backingWidth",
  "backingHeight",
  "lastPresentResult",
  "deviceRemovedReason",
  "result",
  "eventHistoryCapacity",
] as const;
const NATIVE_BOOLEANS = [
  "available",
  "failed",
  "pendingSwap",
  "pendingPublished",
  "backingIsGpu",
  "waiting",
  "priming",
  "physicalScanoutObserved",
  "capturePending",
  "pendingAcknowledgement",
  "deferredPublish",
] as const;
const NATIVE_IDS = [
  "seq",
  "timeUs",
  "identity",
  "sourceId",
  "frameId",
  "readyValue",
  "viewId",
  "outputDeviceId",
  "consumerId",
  "presenterId",
  "retainedTextureId",
  "visualId",
  "swapChainId",
  "pendingSwapChainId",
  "presentedSourceId",
  "presentedFrameId",
  "presentedCpuGeneration",
  "awaitedFrameId",
  "pendingSourceId",
  "pendingFrameId",
  "pendingReadyValue",
  "backingResizes",
  "publishedSourceId",
  "publishedFrameId",
  "publishedReadyValue",
  "frames",
  "readbacks",
  "importedFrames",
  "rejectedFrames",
  "presentCalls",
  "commitCount",
  "commitFailures",
  "presentAttempts",
  "presentSuccesses",
  "presentBusy",
  "presentOccluded",
  "presentModeChange",
  "presentFailures",
  "eventHistoryFirstSeq",
  "eventHistoryLastSeq",
  "eventHistoryOverwrites",
] as const;

function nativeFields(value: unknown, depth = 0): Metadata {
  const input = object(value);
  const result: Metadata = {};
  if (!input || depth > 2) return result;
  for (const key of NATIVE_NUMBERS) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) result[key] = input[key];
  }
  for (const key of NATIVE_BOOLEANS) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  for (const key of NATIVE_IDS) {
    if (typeof input[key] === "string" && DECIMAL.test(input[key])) result[key] = input[key];
  }
  for (const key of ["lastDamage", "canvasClip"]) {
    if (object(input[key])) result[key] = nativeFields(input[key], depth + 1);
  }
  if (depth === 0 && Array.isArray(input.layers))
    result.layers = input.layers.slice(0, 16).map((layer) => nativeFields(layer, depth + 1));
  // Native types are fixed operation names; punctuation, URLs and paths are rejected.
  if (typeof input.type === "string" && /^[a-zA-Z0-9 _-]{1,96}$/.test(input.type))
    result.type = input.type;
  return result;
}

export class RenderingDiagnostics {
  readonly enabled: boolean;
  private readonly writer: RenderingJsonlWriter;
  private readonly sessionId = randomUUID();
  private sequence = 0n;
  private windowSequence = 0n;
  private querySequence = 0n;
  private readonly windows = new Map<BrowserWindow, ObservedWindow>();
  private readonly timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: RenderingDiagnosticsOptions) {
    this.enabled = options.enabled;
    this.writer = new RenderingJsonlWriter(options);
    this.timer = this.enabled
      ? setInterval(() => {
          for (const state of this.windows.values()) this.sample(state, "periodic");
        }, POLL_MS)
      : undefined;
    // mini-electron's idle Windows loop needs a referenced libuv deadline.
    // Shutdown clears this timer; unref would silently stop idle sampling.
    if (this.enabled) {
      void this.record("startup", {
        ...options.identity,
        intervalMs: POLL_MS,
        nativeQueryTimeoutMs: QUERY_TIMEOUT_MS,
        maxFileBytes: FILE_BYTES,
        archiveCount: 3,
        physicalScanoutObserved: false,
      });
      void runtimeIdentity(options.runtimeDirectory).then((identity) => {
        if (!this.stopped) void this.record("runtime-distribution", identity);
        return undefined;
      });
    }
  }

  private record(
    type: string,
    data: Metadata = {},
    state?: ObservedWindow,
    critical = false,
  ): Promise<boolean> {
    if (!this.enabled || this.stopped) return Promise.resolve(false);
    return this.writer.append(
      {
        ...data,
        schemaVersion: 1,
        sessionId: this.sessionId,
        seq: String(++this.sequence),
        time: new Date().toISOString(),
        uptimeMs: Math.round(performance.now()),
        type,
        ...(state
          ? {
              windowId: state.id,
              webContentsId: state.webContentsId,
              documentId: String(state.documentId),
            }
          : {}),
      },
      critical,
    );
  }

  recordAppEvent(type: "quit-requested"): void {
    void this.record(type);
  }

  observeWindow(window: BrowserWindow): void {
    if (!this.enabled || this.stopped || this.windows.has(window) || window.isDestroyed()) return;
    const state: ObservedWindow = {
      window,
      id: String(++this.windowSequence),
      webContentsId: window.webContents.id,
      documentId: 1n,
      pending: null,
      unsupported: false,
      listeners: [],
      reasons: new Set(),
      eventTimer: undefined,
      eventSequences: new Map(),
    };
    this.windows.set(window, state);
    const listen = <Args extends unknown[]>(
      target: NodeJS.EventEmitter,
      event: string,
      callback: (...args: Args) => void,
    ) => {
      target.on(event, callback);
      state.listeners.push(() => target.removeListener(event, callback));
    };
    for (const event of [
      "show",
      "hide",
      "minimize",
      "restore",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
      "focus",
      "blur",
      "resize",
      "move",
      "unresponsive",
      "responsive",
    ]) {
      listen(window, event, () => this.scheduleEvent(state, event));
    }
    listen(
      window.webContents,
      "did-start-navigation",
      (_event, _url, isSameDocument, isMainFrame) => {
        if (!isMainFrame || isSameDocument) return;
        state.documentId += 1n;
        state.unsupported = false;
        state.eventSequences.clear();
        this.scheduleEvent(state, "document-started");
      },
    );
    listen(window.webContents, "did-finish-load", () =>
      this.scheduleEvent(state, "document-loaded"),
    );
    listen(
      window.webContents,
      "render-process-gone",
      (_event, details: { reason?: unknown; exitCode?: unknown }) => {
        state.documentId += 1n;
        state.unsupported = false;
        state.eventSequences.clear();
        const reasons = [
          "clean-exit",
          "abnormal-exit",
          "killed",
          "crashed",
          "oom",
          "launch-failed",
          "integrity-failure",
        ];
        void this.record(
          "renderer-gone",
          {
            reason:
              typeof details.reason === "string" && reasons.includes(details.reason)
                ? details.reason
                : "unknown",
            ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
          },
          state,
        );
      },
    );
    listen(window.webContents, "destroyed", () => this.retire(state, "webcontents-destroyed"));
    listen(window, "closed", () => this.retire(state, "window-closed"));
    void this.record("window-created", this.windowMetadata(state), state);
    this.scheduleEvent(state, "created");
  }

  private windowMetadata(state: ObservedWindow): Metadata {
    const window = state.window;
    if (!window || window.isDestroyed()) return { windowUnavailable: true };
    try {
      const bounds = window.getBounds();
      return {
        bounds: rectangle(bounds),
        contentBounds: rectangle(window.getContentBounds()),
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen(),
        focused: window.isFocused(),
        display: displayMetadata(this.options.getDisplayForBounds(bounds)),
        // mini-electron exposes the OS PID in native producer/consumer snapshots.
        rendererPid: window.webContents.getOSProcessId?.() || undefined,
        zoomFactor: window.webContents.getZoomFactor(),
      };
    } catch {
      return { windowMetadataUnavailable: true };
    }
  }

  recordDisplayEvent(
    type: "display-added" | "display-removed" | "display-metrics-changed",
    display: Display,
  ): void {
    void this.record(type, { display: displayMetadata(display) });
    for (const state of this.windows.values()) this.scheduleEvent(state, "display-changed");
  }

  private scheduleEvent(state: ObservedWindow, reason: string): void {
    if (this.stopped || !state.window) return;
    state.reasons.add(reason);
    if (state.eventTimer) return;
    state.eventTimer = setTimeout(() => {
      state.eventTimer = undefined;
      const events = [...state.reasons];
      state.reasons.clear();
      void this.record("window-events", { events, ...this.windowMetadata(state) }, state);
      this.sample(state, "lifecycle");
    }, EVENT_COALESCE_MS);
    state.eventTimer.unref();
  }

  /** Persists the marker before invoking any native API; never waits for a renderer. */
  async recordIssue(window?: BrowserWindow | null): Promise<void> {
    const state = window ? this.windows.get(window) : undefined;
    await this.record(
      "issue-marker",
      {
        ...(state ? this.windowMetadata(state) : { windowUnavailable: true }),
        nativeQueryPending: !!state?.pending,
        nativeQueryTimedOut: state?.pending?.timedOut ?? false,
      },
      state,
      true,
    );
    if (state) this.sample(state, "manual");
  }

  private sample(state: ObservedWindow, reason: string): void {
    const window = state.window;
    if (this.stopped || !window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    let nativeStatus = "query-requested";
    if (state.unsupported) {
      nativeStatus = "schema-unavailable";
    } else if (state.pending) {
      nativeStatus = state.pending.timedOut ? "timed-out-unresolved" : "query-pending";
    }
    void this.record(
      "window-snapshot",
      {
        reason,
        ...this.windowMetadata(state),
        nativeStatus,
      },
      state,
    );
    if (state.pending || state.unsupported) return;
    const contents = window.webContents as typeof window.webContents & {
      _getCompositorInfo?: () => unknown;
    };
    if (typeof contents._getCompositorInfo !== "function") {
      state.unsupported = true;
      void this.record("native-schema-unavailable", { reason: "method-unavailable" }, state);
      return;
    }
    const pending: PendingQuery = {
      id: String(++this.querySequence),
      documentId: String(state.documentId),
      timedOut: false,
      timeout: setTimeout(() => {
        pending.timedOut = true;
        if (!this.stopped && state.window) {
          void this.record(
            "native-query-timeout",
            {
              queryId: pending.id,
              queryDocumentId: pending.documentId,
              queryDocumentRetired: String(state.documentId) !== pending.documentId,
              timeoutMs: QUERY_TIMEOUT_MS,
            },
            state,
          );
        }
        // Deliberately retain the single-flight slot until the actual promise settles.
      }, QUERY_TIMEOUT_MS),
    };
    pending.timeout.unref();
    state.pending = pending;
    let result: unknown;
    try {
      result = contents._getCompositorInfo();
    } catch {
      result = Promise.reject(new Error("native-query-failed"));
    }
    void Promise.resolve(result)
      .then(
        (reply) => {
          if (this.stopped || !state.window || String(state.documentId) !== pending.documentId)
            return undefined;
          const diagnostics = object(object(reply)?.diagnostics);
          if (diagnostics?.schemaVersion !== 1) {
            state.unsupported = true;
            void this.record(
              "native-schema-unavailable",
              { reason: "schema-one-unavailable", queryId: pending.id },
              state,
            );
            return undefined;
          }
          const snapshot: Metadata = { schemaVersion: 1 };
          for (const role of ["producer", "consumer", "presenter"]) {
            const raw = object(diagnostics[role]);
            const fields = nativeFields(raw);
            if (Array.isArray(raw?.events)) {
              const stream = `${String(fields.rendererPid ?? "")}:${String(fields.outputDeviceId ?? fields.consumerId ?? fields.presenterId ?? "")}`;
              const previous = state.eventSequences.get(role);
              const prefix = `${stream}:`;
              const previousSeq = previous?.startsWith(prefix)
                ? previous.slice(prefix.length)
                : undefined;
              const events = raw.events
                .slice(-64)
                .map((event) => nativeFields(event))
                .filter(
                  (event) =>
                    typeof event.seq === "string" &&
                    (!previousSeq ||
                      event.seq.length > previousSeq.length ||
                      (event.seq.length === previousSeq.length && event.seq > previousSeq)),
                );
              if (events.length)
                state.eventSequences.set(
                  role,
                  `${prefix}${String(events[events.length - 1]!.seq)}`,
                );
              fields.events = events;
            }
            snapshot[role] = fields;
          }
          void this.record(
            "native-snapshot",
            {
              reason,
              queryId: pending.id,
              timedOut: pending.timedOut,
              diagnostics: snapshot,
              physicalScanoutObserved: false,
            },
            state,
          );
          return undefined;
        },
        () => {
          if (!this.stopped && state.window && String(state.documentId) === pending.documentId) {
            void this.record("native-query-failed", { queryId: pending.id }, state);
          }
        },
      )
      .finally(() => {
        clearTimeout(pending.timeout);
        if (state.pending === pending) state.pending = null;
      });
  }

  private retire(state: ObservedWindow, reason: string): void {
    if (!state.window) return;
    void this.record(reason, { nativeQueryPending: !!state.pending }, state);
    this.windows.delete(state.window);
    state.window = null;
    clearTimeout(state.eventTimer);
    if (state.pending) clearTimeout(state.pending.timeout);
    for (const remove of state.listeners) remove();
    state.listeners.length = 0;
    state.reasons.clear();
    state.eventSequences.clear();
  }

  async openLogs(): Promise<void> {
    try {
      await mkdir(this.options.directory, { recursive: true });
      const error = await this.options.openDirectory(this.options.directory);
      if (error)
        this.options.logger.error("[render-diagnostics] Could not open rendering logs directory");
    } catch (error) {
      this.options.logger.error("[render-diagnostics] Could not open rendering logs directory", {
        code: errorCode(error),
      });
    }
  }

  flush(): Promise<unknown> {
    return this.writer.flush();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    void this.record("shutdown", {}, undefined, true);
    this.stopped = true;
    clearInterval(this.timer);
    for (const state of this.windows.values()) this.retire(state, "shutdown");
    this.shutdownPromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = Promise.withResolvers<void>();
      try {
        timer = setTimeout(() => {
          this.options.logger.warn(
            "[render-diagnostics] Timed out flushing local files during shutdown",
          );
          deadline.resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        await Promise.race([this.writer.close(), deadline.promise]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.shutdownPromise;
  }
}
