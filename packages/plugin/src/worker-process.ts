import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { createRequire } from "node:module";
import {
  defineRpc,
  type PluginHandlerContext,
  type PluginRpcContract,
} from "@omp-desktop/plugin/server";
import { createOmpApi, type OmpApi } from "@omp-desktop/client";
import { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import { isPluginSdkSpecifier, PLUGIN_FORBIDDEN_HOST_SPECIFIER } from "./plugin-sdk-specifiers.js";
import { createActivationScope, createPluginOmpApi } from "@omp-desktop/plugin/server";
import type { PluginServiceContext, PluginStorageSnapshot } from "@omp-desktop/plugin/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as pluginServerRuntime from "@omp-desktop/plugin/server";
import * as clientRuntime from "@omp-desktop/client";
import * as z from "zod";

let scope = createActivationScope(0);
let managementOnly=false;
const nativeListeners=new Map<string,Set<(payload:unknown)=>void>>();
const hostCalls = new Map<string, { releaseOnly:boolean;resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
function hostCall(operation: string, input?: unknown): Promise<unknown> {
  const releaseOnly=pluginServerRuntime.isPluginReleaseOperation(operation,input);
  if(!releaseOnly)scope.assertCurrent();
  const requestId = randomUUID();
  const {promise,resolve,reject}=Promise.withResolvers<unknown>();
  const timer=setTimeout(() => {hostCalls.delete(requestId);reject(new Error(`Plugin host operation timed out: ${operation}`));},30_000);
  hostCalls.set(requestId,{releaseOnly,resolve,reject,timer});
  send({type:"host_call",requestId,operation,input});
  return promise;
}

interface RegisteredRpc {
  invoke(input: unknown, context: PluginHandlerContext): Promise<unknown>;
}

const handlers = new Map<string, RegisteredRpc>();
let initializing: Promise<void> | null = null;
let daemonClient: DaemonClient | null = null;
let omp: OmpApi | null = null;
let stopping = false;
const nodeRequire = createRequire(import.meta.url);

function send(message: PluginProcessMessage): void {
  if (!process.connected || !process.send) return;
  try {
    process.send(message, error => {
      if (error) {
        console.error("Plugin IPC send failed", error);
        void shutdown();
      }
    });
  } catch (error) {
    console.error("Plugin IPC send failed", error);
    void shutdown();
  }
}

function sendAndWait(message: PluginProcessMessage): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (!process.connected || !process.send) {
    resolve();
    return promise;
  }
  try {
    process.send(message, error => {
      if (error) console.error("Plugin IPC send failed", error);
      resolve();
    });
  } catch (error) {
    console.error("Plugin IPC send failed", error);
    resolve();
  }
  return promise;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateMethod(method: string): string {
  const normalized = method.trim();
  if (!/^[a-z][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid plugin RPC method: ${method}`);
  }
  if (handlers.has(normalized)) {
    throw new Error(`Duplicate plugin RPC method: ${normalized}`);
  }
  return normalized;
}

function register<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  contract: PluginRpcContract<InputSchema, OutputSchema>,
  handler: (input: z.output<InputSchema>, context: PluginHandlerContext) => z.input<OutputSchema> | Promise<z.input<OutputSchema>>,
): void {
  scope.assertCurrent();
  if (typeof handler !== "function") {
    throw new Error(`Plugin RPC ${contract.name} must provide a handler`);
  }
  const method = validateMethod(contract.name);
  // Capture each schema/handler pair before storing its unknown wire boundary.
  handlers.set(method, {
    async invoke(raw, context) {
      const input = await contract.input.parseAsync(raw) as z.output<InputSchema>;
      scope.assertCurrent();
      const output = await handler(input, context);
      scope.assertCurrent();
      return contract.output.parseAsync(output);
    },
  });
}

const pluginAuthorRuntime = pluginServerRuntime;

function createRuntimeRequire(serviceEntry: string): NodeRequire {
  const installedRequire = createRequire(serviceEntry);
  const assertPublicImport = (name: string) => {
    if (PLUGIN_FORBIDDEN_HOST_SPECIFIER.test(name)) throw new Error(`Plugin must use the public Desktop SDK, not host internals or a second OMP SDK: ${name}`);
  };
  const runtimeRequire = Object.assign((name: string): unknown => {
    assertPublicImport(name);
    if (isPluginSdkSpecifier(name)) return pluginAuthorRuntime;
    if (name === "@omp-desktop/client") return clientRuntime;
    if (name === "zod") return z;
    if (name.startsWith("zod/")) return nodeRequire(name);
    return installedRequire(name);
  }, installedRequire);
  runtimeRequire.resolve = Object.assign((name: string, options?: Parameters<NodeRequire["resolve"]>[1]) => {
    assertPublicImport(name);
    if (isPluginSdkSpecifier(name)) return nodeRequire.resolve("@omp-desktop/plugin/server");
    if (name === "@omp-desktop/client") return nodeRequire.resolve("@omp-desktop/client");
    if (name === "zod" || name.startsWith("zod/")) return nodeRequire.resolve(name);
    return installedRequire.resolve(name, options);
  }, { paths: installedRequire.resolve.paths });
  return runtimeRequire;
}

async function evaluateBundle(bundle: string, installation: NonNullable<Extract<PluginProcessRequest, {type:"initialize"}>["installation"]>, serviceEntry: string, format: "legacy" | "package"): Promise<void> {
  scope.assertCurrent();
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(createRuntimeRequire(serviceEntry), serviceEntry, path.dirname(serviceEntry));
  const setup = managementOnly
    ? (exports !== null && (typeof exports === "object" || typeof exports === "function") ? Reflect.get(exports, "manage") : undefined)
    : (typeof exports === "function" ? exports : exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined);
  if (typeof setup !== "function") throw new Error(managementOnly ? "Plugin does not expose disabled management" : "Plugin server bundle must default export a function");
  scope.assertCurrent();
  if (!omp && !managementOnly && installation.owner!=="desktop") throw new Error("Plugin host connection unavailable");
  const unsupported = () => { throw new Error("Client contribution cannot register in service role"); };
  const context: PluginServiceContext = {
    installation,signal:scope.signal,mode:"active",role:"service",get omp(){if(!omp)throw new Error("This local service has no selected daemon host connection");return omp;},
    handle: register,own:scope.own,waiting:reason => send({type:"waiting",reason}),
    addAgentTool(contribution) {
      scope.assertCurrent();
      if(managementOnly)throw new Error("Agent tools are unavailable in management mode");
      const name=validateMethod(`agent-tool.${contribution.name}`);
      const contract=defineRpc({name,input:z.object({input:z.unknown(),agentId:z.string(),turnId:z.string().nullable()}),output:z.unknown()});
      register(contract,async envelope=>{const input=await contribution.input.parseAsync(envelope.input);scope.assertCurrent();return contribution.handler(input,{agentId:envelope.agentId,turnId:envelope.turnId,signal:scope.signal});});
      void hostCall("agent.tool.register",{name:contribution.name,description:contribution.description,inputJsonSchema:z.toJSONSchema(contribution.input)}).catch(error=>{send({type:"fatal",error:describeError(error)});});
      return scope.own(()=>{handlers.delete(name);});
    },
    addAgentPrompt(contribution){
      scope.assertCurrent();if(managementOnly)throw new Error("Agent prompt hooks are unavailable in management mode");
      const name=`agent-prompt.${contribution.id}`;
      const contract=defineRpc({name,input:z.object({agentId:z.string(),turnId:z.string().nullable()}),output:z.union([z.string(),z.null(),z.object({text:z.string().optional(),skills:z.array(z.string()).optional(),tools:z.array(z.string()).optional()}).strict()])});
      register(contract,async input=>contribution.handler({...input,signal:scope.signal}));
      void hostCall("agent.prompt.register",{id:contribution.id}).catch(error=>send({type:"fatal",error:describeError(error)}));
      return scope.own(()=>{handlers.delete(name);});
    },
    storage:{get:<T>() => hostCall("storage.get") as Promise<PluginStorageSnapshot<T>>,patch:<T>(patch:Partial<T>,expectedRevision:number) => hostCall("storage.patch",{patch,expectedRevision}) as Promise<PluginStorageSnapshot<T>>},
    secrets:{get:key => hostCall("secret",{key,operation:"get"}) as Promise<string|null>,configured:key => hostCall("secret",{key,operation:"configured"}) as Promise<boolean>,set:async(key,value) => {await hostCall("secret",{key,operation:"set",value});},delete:async key => {await hostCall("secret",{key,operation:"delete"});}},
    native:{invoke:(operation,input) => hostCall(operation,input) as Promise<never>,subscribe(event,listener){scope.assertCurrent();const listeners=nativeListeners.get(event)??new Set();listeners.add(listener);nativeListeners.set(event,listeners);return scope.own(()=>{listeners.delete(listener);});}},
    addSurface:unsupported,addSidebarItem:unsupported,addWorkspacePanel:unsupported,addCommandCenterItem:unsupported,addAttachmentSource:unsupported,addTheme:unsupported,
  };
  const managementContext={installation,signal:scope.signal,mode:"manage",role:"management",storage:context.storage,secrets:context.secrets,handle:register,own:scope.own};
  const contributedCleanup=await setup(managementOnly ? managementContext : context);
  if(format==="legacy" && typeof contributedCleanup!=="function")throw new Error("Plugin server contribution must return a cleanup function");
  if(contributedCleanup!==undefined && typeof contributedCleanup!=="function")throw new Error("Plugin setup must return cleanup or void");
  if (scope.signal.aborted) {
    await contributedCleanup?.();
    scope.assertCurrent();
  }
  if(contributedCleanup)scope.own(contributedCleanup);
}

const transportFactory = createPluginDaemonTransportFactory({
  send,
  onMessage(handler) {
    process.on("message", handler);
    return () => process.off("message", handler);
  },
});

async function initialize(message: Extract<PluginProcessRequest, { type: "initialize" }>) {
  const installation=message.installation;
  scope=createActivationScope(installation.generation);
  managementOnly=message.mode==="manage";
  if(installation.owner==="daemon"){
    daemonClient = new DaemonClient({url:`ipc://plugin/${encodeURIComponent(message.pluginId)}`,clientId:`plugin:${message.pluginId}`,clientType:"cli",reconnect:{enabled:false},transportFactory});
    omp=createPluginOmpApi(createOmpApi(daemonClient),installation,scope,{mode:managementOnly?"manage":"active",legacy:message.format==="legacy"});
    if(!managementOnly)await daemonClient.connect();
  }
  scope.assertCurrent();
  await evaluateBundle(message.bundle,installation,message.serviceEntry,message.format);
  send({ type: "ready", methods: [...handlers.keys()].sort() });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  handlers.clear();
  // Revoke execution before waiting for setup or invoking any contributed cleanup.
  const disposal = scope.dispose();
  const released = disposal.catch(error => console.error("Plugin cleanup failed", error));
  for (const [id, call] of hostCalls) {
    if (call.releaseOnly) continue;
    clearTimeout(call.timer);
    call.reject(new Error("Plugin stopped"));
    hostCalls.delete(id);
  }
  await initializing?.catch(() => undefined);
  await released;
  await daemonClient?.close().catch(() => undefined);
  await sendAndWait({ type: "omp_close" });
  daemonClient = null;
  omp = null;
  if (process.connected) process.disconnect();
}

process.on("message", (message: PluginProcessRequest) => {
  if(message.type==="host_event"){if(!scope.signal.aborted)for(const listener of nativeListeners.get(message.event)??[])listener(message.payload);return;}
  if(message.type==="host_result") {
    const call=hostCalls.get(message.requestId);if(!call)return;
    hostCalls.delete(message.requestId);clearTimeout(call.timer);
    try {if(!call.releaseOnly)scope.assertCurrent();if(message.error)call.reject(new Error(message.error));else call.resolve(message.output);}catch(error){call.reject(error as Error);}
    return;
  }
  if (message.type === "initialize") {
    initializing = initialize(message).catch(async (error) => {
      if (!stopping) send({ type: "fatal", error: describeError(error) });
      throw error;
    });
    void initializing.catch(() => { void shutdown(); });
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  if (message.type === "omp_frame" || message.type === "omp_close") return;
  if (stopping) return;
  const registered = handlers.get(message.method);
  if (!registered) {
    send({
      type: "error",
      requestId: message.requestId,
      error: `Unknown RPC method: ${message.method}`,
    });
    return;
  }
  const handlerContext: PluginHandlerContext = {
    get omp() {
      if (!omp) throw new Error("This local service has no selected daemon host connection");
      return omp;
    },
  };
  void registered.invoke(message.input, managementOnly ? {} as PluginHandlerContext : handlerContext)
    .then(
      (output) => send({ type: "result", requestId: message.requestId, output }),
      (error) => send({ type: "error", requestId: message.requestId, error: describeError(error) }),
    );
});

process.on("disconnect", () => { void shutdown(); });
