import { realpath } from "node:fs/promises";
import { inspectPluginPackage, compilePlugin, compilePackageEntries } from "@omp-desktop/plugin/compiler";
import { IsolatedPluginWorker } from "@omp-desktop/plugin/worker";
import type { PluginActivationScope } from "@omp-desktop/plugin/host";
import type { LocalPluginRecord, LocalPluginDirectoryInspection } from "@omp-desktop/protocol/desktop-local-plugins";
import type { LocalPluginDefinition } from "./local-runtime.js";
import type { LocalPluginLogs } from "./logs.js";

export async function inspectLocalPluginDirectory(directory: string): Promise<LocalPluginDirectoryInspection> {
  const inspected = await inspectPluginPackage(await realpath(directory));
  if (inspected.metadata && inspected.metadata.owner !== "desktop") throw new Error("This package belongs to a daemon. Select a daemon installation target.");
  return inspected;
}
export interface LocalPluginWorkerBridge { invoke(method: string, input: unknown, generation: number): Promise<unknown>; emit(event: string, payload: unknown): void }
export interface ExternalLocalPluginDependencies {
  logs: LocalPluginLogs;
  hostCall(record: LocalPluginRecord, scope: PluginActivationScope, mode: "active" | "manage", worker: LocalPluginWorkerBridge, operation: string, input: unknown): Promise<unknown>;
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
  fail(id: string, generation: number, message: string): void;
  waiting(id: string, generation: number, reason: string | null): void;
  clearData(id: string): Promise<void>;
}
export async function loadExternalLocalPlugin(record: LocalPluginRecord, scope: PluginActivationScope, dependencies: ExternalLocalPluginDependencies): Promise<LocalPluginDefinition> {
  const inspected = await inspectLocalPluginDirectory(record.source.identity);
  scope.assertCurrent();
  if (inspected.id !== record.packageId || inspected.version !== record.version || inspected.capabilities.some((capability) => !record.grantedCapabilities.includes(capability))) throw new Error("Plugin source changed its version, identity or capabilities. Inspect and approve this source before reloading.");
  const bundles = inspected.format === "legacy" ? await compilePlugin(inspected.serviceEntry!) : await compilePackageEntries(inspected);
  scope.assertCurrent();
  let worker: IsolatedPluginWorker | undefined;
  let workerMode: "active" | "manage" | undefined;
  let starting: Promise<IsolatedPluginWorker> | undefined;
  const start = (mode: "active" | "manage") => {
    scope.assertCurrent();
    if (worker) { if (workerMode !== mode) throw new Error("Plugin management worker must stop before activation."); return Promise.resolve(worker); }
    if (starting) return starting;
    workerMode = mode;
    dependencies.logs.append(record.id, "host", `Starting ${mode} generation ${scope.generation}`);
    starting = IsolatedPluginWorker.start({ installation: record, format: inspected.format, signal: scope.signal, serviceEntry: inspected.serviceEntry!, serverBundle: bundles.serverBundle, mode,
      hostCall: (operation, input) => dependencies.hostCall(record, scope, mode, bridge, operation, input),
      onLog: (stream, message) => dependencies.logs.append(record.id, stream, message),
      onFailure: (error) => { dependencies.logs.append(record.id, "stderr", error.message); if (mode === "active") dependencies.fail(record.id, scope.generation, error.message); },
      onWaiting: (reason) => dependencies.waiting(record.id, scope.generation, reason),
    }).then(async (started) => {
      if (scope.signal.aborted) { await started.stop(); scope.assertCurrent(); }
      worker = started;
      scope.own(() => started.stop());
      scope.own(dependencies.subscribe(`storage:${record.id}`, (payload) => { started.emit("storage:changed", payload); started.emit("plugins:changed", payload); }));
      scope.own(dependencies.subscribe(`client:${record.id}:released`, (payload) => started.emit("client:released", payload)));
      scope.own(dependencies.subscribe("window:removed", (payload) => started.emit("window:removed", payload)));
      scope.own(dependencies.subscribe(`selection:${record.id}`, (payload) => started.emit("background:selectionChanged", payload)));
      return started;
    }).finally(() => { starting = undefined; });
    return starting;
  };
  const bridge: LocalPluginWorkerBridge = { invoke: (method, input, generation) => start(workerMode ?? "active").then((instance) => instance.invoke(method, input, generation)), emit: (event, payload) => worker?.emit(event, payload) };
  return {
    id: record.id,
    clientBundle: inspected.clientEntry || inspected.format === "legacy" ? bundles.clientBundle : undefined,
    setup: inspected.serviceEntry ? async () => { await start("active"); } : undefined,
    invoke: inspected.serviceEntry ? async (method, input, generation) => { const instance = await start("active"); return instance.invoke(method, input, generation); } : undefined,
    manageInvoke: inspected.serviceEntry ? async (method, input, generation) => { const instance = await start("manage"); return instance.invoke(method, input, generation); } : undefined,
    clearData: () => dependencies.clearData(record.id),
  };
}
