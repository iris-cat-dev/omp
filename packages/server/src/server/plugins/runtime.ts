import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { PluginLogEntry } from "@omp-desktop/protocol/messages";
import { inspectPluginPackage, compilePlugin, compilePackageEntries, type InspectedPluginPackage, type CompiledPluginBundles } from "@omp-desktop/plugin/compiler";
import { PluginLogRedactor, type PluginInstallation } from "@omp-desktop/plugin/server";
import { getPluginWorkerUrl, PluginOutputCapture, type PluginProcessMessage, type PluginProcessRequest } from "@omp-desktop/plugin/worker";
import { PluginSessionSocket } from "./session-socket.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;

interface PluginOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface PluginChild {
  connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  stdout?: PluginOutputStream | null;
  stderr?: PluginOutputStream | null;
  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
  kill(signal?:NodeJS.Signals): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: PluginProcessMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disconnect", listener: () => void): this;
}

interface PendingInvocation {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface LoadedPlugin {
  id: string;
  clientBundle: string;
  installation: PluginInstallation;
  methods: ReadonlySet<string>;
  child: PluginChild;
  outputCapture: PluginOutputCapture;
  pending: Map<string, PendingInvocation>;
  sessionSocket: PluginSessionSocket;
  sessionClosed: Promise<void>;
}

interface PluginRuntimeDependencies {
  spawnChild?: () => PluginChild;
  sessionHost?: PluginOmpSessionHost;
  hostCall?: (pluginId: string, operation: string, input: unknown) => unknown | Promise<unknown>;
}

interface PluginLogTail {
  entries: PluginLogEntry[];
  bytes: number;
  nextSequence: number;
}


export interface PluginOmpSessionHost {
  attachPluginSocket(
    pluginId: string,
    socket: PluginSessionSocket,
  ): Promise<{ closed: Promise<void> }>;
}

function resolveWorkerUrl(): URL {
  return getPluginWorkerUrl();
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function spawnPluginChild(): PluginChild {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:"1"}:{})},
  }) as PluginChild;
}

function terminatePluginChild(child: PluginChild): void {
  if (child.connected) child.disconnect();
  child.kill("SIGKILL");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(child: PluginChild, message: PluginProcessRequest): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (!child.connected) {
    reject(new Error("Plugin worker IPC channel is closed"));
    return promise;
  }
  try {
    child.send(message, error => { if (error) reject(error); else resolve(); });
  } catch (error) {
    reject(error);
  }
  return promise;
}


export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly starting = new Map<string, { cancel(): void; completed: Promise<void> }>();
  private readonly logTails = new Map<string, PluginLogTail>();
  private readonly logger: pino.Logger;
  private readonly logRedactors = new Map<string, PluginLogRedactor>();
  private readonly spawnChild: () => PluginChild;
  private sessionHost: PluginOmpSessionHost | null;
  private readonly listeners = new Set<(pluginId: string, error?: string) => void>();
  private readonly generations = new Map<string,number>();
  private readonly waitingReasons = new Map<string,string>();
  private hostCall: NonNullable<PluginRuntimeDependencies["hostCall"]>;

  constructor(logger: pino.Logger, dependencies: PluginRuntimeDependencies = {}) {
    this.logger = logger.child({ module: "plugins" });
    this.spawnChild = dependencies.spawnChild ?? spawnPluginChild;
    this.sessionHost = dependencies.sessionHost ?? null;
    this.hostCall = dependencies.hostCall ?? (() => {throw new Error("Plugin host capabilities are unavailable");});
  }

  bindOmpSessionHost(sessionHost: PluginOmpSessionHost): void {
    if (this.plugins.size > 0)
      throw new Error("Cannot replace the plugin session host while running");
    this.sessionHost = sessionHost;
  }

  bindHostCall(handler: NonNullable<PluginRuntimeDependencies["hostCall"]>): void { this.hostCall=handler; }
  generation(id:string):number {return this.generations.get(id)??0;}
  invalidateGeneration(id:string):void {this.generations.set(id,this.generation(id)+1);}
  waitingReason(id:string):string|undefined {return this.waitingReasons.get(id);}

  private logRedactor(id: string): PluginLogRedactor {
    let redactor = this.logRedactors.get(id);
    if (!redactor) {
      redactor = new PluginLogRedactor();
      this.logRedactors.set(id, redactor);
    }
    return redactor;
  }

  subscribe(listener: (pluginId: string, error?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startPlugin(
    pluginId: string,
    configuredPath: string,
    canPublish: () => boolean = () => true,
    packageInfo?: InspectedPluginPackage,
    grantedCapabilities: readonly string[] = [],
    mode: "manage" | "active" = "active",
    preparedBundles?:CompiledPluginBundles,
  ): Promise<void> {
    if (this.plugins.has(pluginId) || this.starting.has(pluginId)) throw new Error(`Plugin is already running: ${pluginId}`);
    let cancelled = false;
    let interrupt = () => {};
    const completion = Promise.withResolvers<void>();
    const starting = { cancel() { cancelled = true; interrupt(); }, completed: completion.promise };
    this.starting.set(pluginId, starting);
    const publish = () => !cancelled && canPublish();
    try {
      this.appendLog(pluginId, "stdout", "[omp] Loading plugin");
      const loaded = await this.loadDirectoryPlugin(pluginId, configuredPath, packageInfo, grantedCapabilities, publish, mode, preparedBundles, cancel => {
        interrupt = cancel;
        if (cancelled) cancel();
      }).catch((error) => {
        this.appendLog(pluginId, "stderr", `[omp] Plugin failed to load: ${describeError(error)}`);
        throw error;
      });
      if (!publish()) {
        await this.stopPlugin(loaded);
        throw new Error(`Plugin start cancelled: ${pluginId}`);
      }
      this.plugins.set(pluginId, loaded);
      this.appendLog(pluginId, "stdout", "[omp] Plugin ready");
    } finally {
      this.starting.delete(pluginId);
      completion.resolve();
    }
  }

  async stopPluginById(pluginId: string): Promise<boolean> {
    const starting = this.starting.get(pluginId);
    if (starting) { starting.cancel(); await starting.completed; return true; }
    const loaded = this.plugins.get(pluginId);
    if (!loaded) return false;
    this.plugins.delete(pluginId);
    this.waitingReasons.delete(pluginId);
    this.rejectPending(loaded, `Plugin stopped: ${pluginId}`);
    await this.stopPlugin(loaded);
    return true;
  }

  catalog(): Array<{ id: string; clientBundle: string }> {
    return [...this.plugins.values()]
      .map(({ id, clientBundle }) => ({ id, clientBundle }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getLogs(pluginId: string): PluginLogEntry[] {
    return (
      this.logTails.get(pluginId)?.entries.map((entry) => ({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        stream: entry.stream,
        message: entry.message,
      })) ?? []
    );
  }

  clearLogs(pluginId: string): void {
    this.logTails.delete(pluginId);
  }

  async invoke(pluginId: string, method: string, input: unknown, generation?: number): Promise<unknown> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not available: ${pluginId}`);
    if(loaded.installation.generation!==this.generation(pluginId)||(generation!==undefined && generation!==loaded.installation.generation))throw new Error("Plugin generation is no longer active");
    if (!loaded.methods.has(method))
      throw new Error(`Plugin ${pluginId} does not contribute RPC ${method}`);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        loaded.pending.delete(requestId);
        reject(new Error(`Plugin RPC timed out: ${pluginId}.${method}`));
      }, REQUEST_TIMEOUT_MS);
      loaded.pending.set(requestId, { resolve, reject, timeout });
      void send(loaded.child, { type: "invoke", requestId, method, input }).catch((error) => {
        clearTimeout(timeout);
        loaded.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async stopAll(): Promise<void> {
    const starting = [...this.starting.values()];
    for (const plugin of starting) plugin.cancel();
    const loaded = [...this.plugins.values()];
    this.plugins.clear();
    for (const plugin of loaded) {
      this.rejectPending(plugin, `Plugin stopped: ${plugin.id}`);
    }
    await Promise.all([...starting.map(plugin => plugin.completed), ...loaded.map((plugin) => this.stopPlugin(plugin))]);
  }

  private async loadDirectoryPlugin(
    pluginId: string,
    configuredPath: string,
    suppliedPackage?: InspectedPluginPackage,
    grantedCapabilities: readonly string[] = [],
    canPublish: () => boolean = () => true,
    mode: "manage" | "active" = "active",
    preparedBundles?:CompiledPluginBundles,
    registerCancel: (cancel: () => void) => void = () => {},
  ): Promise<LoadedPlugin> {
    const directory = path.resolve(configuredPath);
    const packageInfo=suppliedPackage??await inspectPluginPackage(directory);
    if(packageInfo.metadata?.owner==="desktop")throw new Error("Desktop-owned service must run in the Desktop profile, not daemon");
    const serviceEntry = packageInfo.serviceEntry;
    if(!serviceEntry)throw new Error("Plugin does not declare a service entry");
    const generation=(this.generations.get(pluginId)??0)+(mode==="manage"?0:1);
    this.generations.set(pluginId,generation);
    const installation:PluginInstallation={id:pluginId,packageId:packageInfo.id,owner:"daemon",version:packageInfo.version,generation,enabled:mode==="active",declaredCapabilities:packageInfo.capabilities,grantedCapabilities};
    const bundles=preparedBundles??(packageInfo.format==="legacy"?await compilePlugin(packageInfo.serviceEntry!):await compilePackageEntries(packageInfo));
    if(!canPublish())throw new Error(`Plugin start cancelled: ${pluginId}`);
    const sessionHost = this.sessionHost;
    if (!sessionHost) throw new Error("Plugin Omp session host is not attached");
    const child = this.spawnChild();
    const outputCapture = new PluginOutputCapture(child, (stream, message, truncated) => {
      this.appendLog(pluginId, stream, message, truncated);
    });
    const sessionSocket = new PluginSessionSocket(child);
    const pending = new Map<string, PendingInvocation>();
    const sessionAttachment = await sessionHost
      .attachPluginSocket(pluginId, sessionSocket)
      .catch((error) => {
        sessionSocket.peerClosed();
        terminatePluginChild(child);
        throw error;
      });
    let loaded: LoadedPlugin | null = null;
    let methods: string[];
    try {
      methods = await new Promise<string[]>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(
          () => fail(new Error(`Plugin ${pluginId} did not initialize`)),
          REQUEST_TIMEOUT_MS,
        );
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        };
        registerCancel(() => fail(new Error(`Plugin start cancelled: ${pluginId}`)));
        child.on("error", error => {
          if (loaded) { void this.stopPluginById(pluginId); this.notify(pluginId, describeError(error)); }
          else fail(error);
        });
        child.on("message", (message) => {
          if(message.type==="host_call") {
            void Promise.resolve().then(() => {
              if(!canPublish() || (loaded && this.plugins.get(pluginId)!==loaded))throw new Error("Plugin generation is no longer active");
              const capability=message.operation==="secret"?"secrets.scoped":message.operation.startsWith("storage.")?"storage.scoped":message.operation.startsWith("files.")?"files.scoped":message.operation==="agent.tool.register"?"agents.tools":message.operation==="agent.prompt.register"?"agents.prompt":message.operation;
              if(packageInfo.format!=="legacy" && !message.operation.startsWith("storage.") && !grantedCapabilities.includes(capability))throw new Error(`Plugin capability is not granted: ${capability}`);
              if(message.operation==="secret")this.logRedactor(pluginId).rememberSecret(message.input);
              return this.hostCall(pluginId,message.operation,message.input);
            }).then(output => {if(message.operation==="secret")this.logRedactor(pluginId).rememberSecret(message.input,output);return send(child,{type:"host_result",requestId:message.requestId,output});},error => send(child,{type:"host_result",requestId:message.requestId,error:this.logRedactor(pluginId).redact(describeError(error))})).catch(error=>{if(loaded){void this.stopPluginById(pluginId);this.notify(pluginId,describeError(error));}else fail(error);});
            return;
          }
          if(message.type==="waiting") {if(message.reason)this.waitingReasons.set(pluginId,this.logRedactor(pluginId).redact(message.reason));else this.waitingReasons.delete(pluginId);this.notify(pluginId);return;}
          if (message.type === "omp_frame") {
            sessionSocket.receive(message.data, message.isBinary);
          } else if (message.type === "omp_close") {
            sessionSocket.peerClosed();
          } else if (message.type === "ready") {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(message.methods);
          } else if (message.type === "fatal") {
            if(loaded)this.handleChildMessage(loaded,message);else fail(new Error(this.logRedactor(pluginId).redact(message.error)));
          } else if (loaded) {
            this.handleChildMessage(loaded, message);
          }
        });
        child.on("disconnect", () => {
          sessionSocket.peerClosed();
          if (!loaded) fail(new Error(`Plugin ${pluginId} IPC channel closed during initialization`));
        });
        child.on("exit", () => {
          sessionSocket.peerClosed();
          if (!loaded) {
            fail(new Error(`Plugin ${pluginId} exited during initialization`));
            return;
          }
          void this.handleChildExit(loaded);
        });
        if (!canPublish()) { fail(new Error(`Plugin start cancelled: ${pluginId}`)); return; }
        void send(child, {
          type: "initialize",
          pluginId,
          bundle: bundles.serverBundle,
          serviceEntry,
          format: packageInfo.format,
          installation,
          mode,
        }).catch(fail);
      });
    } catch (error) {
      await this.stopChild(child, sessionSocket);
      await sessionAttachment.closed;
      throw error;
    }
    loaded = {
      id: pluginId,
      clientBundle: bundles.clientBundle,
      installation,
      methods: new Set(methods),
      child,
      outputCapture,
      pending,
      sessionSocket,
      sessionClosed: sessionAttachment.closed,
    };
    this.logger.info({ pluginId, methods }, "Loaded plugin");
    return loaded;
  }

  private handleChildMessage(loaded: LoadedPlugin, message: PluginProcessMessage): void {
    if(message.type==="fatal"){void this.stopPluginById(loaded.id);this.notify(loaded.id,message.error);return;}
    if (message.type !== "result" && message.type !== "error") return;
    const pending = loaded.pending.get(message.requestId);
    if (!pending) return;
    loaded.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.type === "result") pending.resolve(message.output);
    else pending.reject(new Error(this.logRedactor(loaded.id).redact(message.error)));
  }

  private async handleChildExit(loaded: LoadedPlugin): Promise<void> {
    loaded.sessionSocket.peerClosed();
    const wasPublished = this.plugins.get(loaded.id) === loaded;
    if (wasPublished) {
      this.plugins.delete(loaded.id);
    }
    this.rejectPending(loaded, `Plugin process exited: ${loaded.id}`);
    await loaded.sessionClosed;
    if (wasPublished) this.notify(loaded.id, `Plugin process exited: ${loaded.id}`);
  }

  private async stopPlugin(loaded: LoadedPlugin): Promise<void> {
    this.appendLog(loaded.id, "stdout", "[omp] Stopping plugin");
    await this.stopChild(loaded.child, loaded.sessionSocket);
    await loaded.sessionClosed;
    this.appendLog(loaded.id, "stdout", "[omp] Plugin stopped");
  }

  private async stopChild(child: PluginChild, socket: PluginSessionSocket): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      socket.peerClosed();
      return;
    }
    const exited = Promise.withResolvers<void>();
    // IPC disconnect may prevent a later close event even after process exit.
    // Process lifetime is independent of the stdout/stderr capture lifetime.
    child.on("exit", () => exited.resolve());
    const timer = setTimeout(() => {
      terminatePluginChild(child);
      socket.peerClosed();
      exited.resolve();
    }, 3_000);
    if (child.connected) void send(child, { type: "shutdown" }).catch(() => {
      terminatePluginChild(child);
      socket.peerClosed();
      exited.resolve();
    });
    else {
      terminatePluginChild(child);
      socket.peerClosed();
      exited.resolve();
    }
    await exited.promise;
    clearTimeout(timer);
    socket.peerClosed();
  }

  private rejectPending(loaded: LoadedPlugin, message: string): void {
    for (const invocation of loaded.pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(new Error(message));
    }
    loaded.pending.clear();
  }

  private appendLog(pluginId: string, stream: PluginLogEntry["stream"], message: string, truncated = false): void {
    const boundedMessage = Buffer.from(this.logRedactor(pluginId).redact(message, truncated)).subarray(0, MAX_LOG_LINE_BYTES).toString("utf8");
    let tail = this.logTails.get(pluginId);
    if (!tail) {
      tail = { entries: [], bytes: 0, nextSequence: 1 };
      this.logTails.set(pluginId, tail);
    }
    const entry: PluginLogEntry = {
      sequence: tail.nextSequence++,
      timestamp: new Date().toISOString(),
      stream,
      message: boundedMessage,
    };
    tail.entries.push(entry);
    tail.bytes += Buffer.byteLength(boundedMessage);
    while (tail.entries.length > MAX_LOG_ENTRIES || tail.bytes > MAX_LOG_BYTES) {
      const removed = tail.entries.shift();
      if (!removed) break;
      tail.bytes -= Buffer.byteLength(removed.message);
    }
    this.logger.info({ pluginId, ...entry }, "Plugin output");
  }

  private notify(pluginId: string, error?: string): void {
    for (const listener of this.listeners) listener(pluginId, error ? this.logRedactor(pluginId).redact(error) : undefined);
  }
}
