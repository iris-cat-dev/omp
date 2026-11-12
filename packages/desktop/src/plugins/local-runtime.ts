import { createActivationScope, type PluginActivationScope } from "@omp-desktop/plugin/server";
import type { PluginNativeApi, PluginServiceContext, PluginServiceSetup, PluginStorageSnapshot } from "@omp-desktop/plugin";
import type { DesktopSettingsStore } from "../settings/desktop-settings.js";
import type { LocalPluginDocument, LocalPluginRecord, LocalPluginSnapshot, LocalPluginStatus } from "./records.js";

export interface LocalPluginDefinition {
  id: string;
  setup?: PluginServiceSetup;
  clientBundle?: string;
  manage?: Readonly<Record<string, (input: unknown) => unknown | Promise<unknown>>>;
  invoke?: (method: string, input: unknown, generation: number) => Promise<unknown>;
  manageInvoke?: (method: string, input: unknown, generation: number) => Promise<unknown>;
  resource?: (pathname: string) => Promise<Response | null>;
  clearData?: () => Promise<void>;
}
interface Instance {
  record: LocalPluginRecord;
  scope: PluginActivationScope;
  definition?: LocalPluginDefinition;
  status: LocalPluginStatus;
  error: string | null;
  started: boolean;
  handlers: Map<string, (input: unknown) => Promise<unknown>>;
}
function executionIdentity(record: LocalPluginRecord): string {
  return JSON.stringify([record.installed, record.enabled, record.trusted, record.version, record.source, record.declaredCapabilities, record.grantedCapabilities]);
}
export class LocalPluginRuntime {
  private readonly instances = new Map<string, Instance>();
  private readonly definitions = new Map<string, LocalPluginDefinition>();
  private readonly listeners = new Set<(snapshot: LocalPluginSnapshot) => void>();
  private readonly revocations = new Set<(id: string, generation: number) => void>();
  private document: LocalPluginDocument = { revision: 0, backgroundProvider: null, backgroundSelectionEdited: false, installations: [] };
  private revision = 0;
  private ready = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  constructor(
    private readonly store: DesktopSettingsStore,
    private readonly native: (record: LocalPluginRecord, scope: PluginActivationScope) => PluginNativeApi,
    private readonly loadLocal: (record: LocalPluginRecord, scope: PluginActivationScope) => Promise<LocalPluginDefinition>,
    private readonly onError: (id: string, message: string) => void,
  ) {}
  register(definition: LocalPluginDefinition): void {
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate local plugin ${definition.id}.`);
    this.definitions.set(definition.id, definition);
  }
  async initialize(): Promise<void> {
    this.document = await this.store.getPlugins();
    this.revision = this.document.revision;
    this.unsubscribe = this.store.subscribePlugins((document) => {
      for (const record of document.installations) {
        const instance = this.instances.get(record.id);
        if (instance && executionIdentity(instance.record) !== executionIdentity(record)) {
          for (const listener of this.revocations) listener(record.id, instance.scope.generation);
          void instance.scope.dispose().catch((error) => this.onError(record.id, String(error)));
        }
      }
      this.document = document;
      this.publish();
      this.enqueue();
    });
    this.enqueue();
  }
  private enqueue(): void {
    this.queue = this.queue.then(() => this.reconcile()).catch((error) => this.onError("runtime", error instanceof Error ? error.message : String(error)));
  }
  startupReady(): void { this.ready = true; this.enqueue(); }
  getSnapshot(): LocalPluginSnapshot {
    return {
      revision: this.revision,
      backgroundProvider: this.document.backgroundProvider ? { ...this.document.backgroundProvider } : null,
      installations: this.document.installations.map((record) => {
        const instance = this.instances.get(record.id);
        const current = instance && executionIdentity(instance.record) === executionIdentity(record);
        const status = !record.installed ? "removed" : !record.enabled ? "disabled" : current ? instance.status : "waiting";
        return { ...structuredClone(record), generation: instance?.scope.generation ?? record.generation, status, error: current ? instance.error : null, ...(record.installed && record.trusted && current && instance.definition?.clientBundle ? { clientBundle: instance.definition.clientBundle } : {}) };
      }),
    };
  }
  subscribe(listener: (snapshot: LocalPluginSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeRevocations(listener: (id: string, generation: number) => void): () => void { this.revocations.add(listener); return () => { this.revocations.delete(listener); }; }
  private publish(): void {
    this.revision = Math.max(this.revision + 1, this.document.revision);
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
  private async stop(instance: Instance): Promise<void> {
    for (const listener of this.revocations) listener(instance.record.id, instance.scope.generation);
    await instance.scope.dispose();
    instance.handlers.clear();
  }
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    for (const listed of this.document.installations) {
      let instance = this.instances.get(listed.id);
      if (!instance || executionIdentity(instance.record) !== executionIdentity(listed)) {
        if (instance) await this.stop(instance);
        const updated = await this.store.advancePluginGeneration(listed.id);
        this.document = updated;
        const record = updated.installations.find(({ id }) => id === listed.id)!;
        instance = { record, scope: createActivationScope(record.generation), status: record.enabled ? "waiting" : "disabled", error: null, started: false, handlers: new Map() };
        this.instances.set(record.id, instance);
        if (!record.installed || !record.trusted) continue;
        try {
          instance.definition = record.source.type === "builtin" ? this.definitions.get(record.packageId) : await this.loadLocal(record, instance.scope);
          instance.scope.assertCurrent();
          if (!instance.definition) throw new Error("Plugin entry is unavailable.");
        } catch (error) {
          if (!instance.scope.signal.aborted) this.fail(record.id, instance.scope.generation, error instanceof Error ? error.message : String(error));
          continue;
        }
      } else instance.record = listed;
      const record = instance.record;
      if (!record.enabled || !record.installed || instance.started || instance.status === "failed" || instance.scope.signal.aborted) continue;
      if (!record.trusted || record.declaredCapabilities.some((capability) => !record.grantedCapabilities.includes(capability))) {
        instance.status = "waiting"; instance.error = "Trust and required capabilities must be approved."; continue;
      }
      if (this.ready) await this.activate(instance);
    }
    this.publish();
  }
  private async activate(instance: Instance): Promise<void> {
    if (!instance.definition || instance.started) return;
    instance.started = true;
    instance.status = "activating";
    instance.error = null;
    this.publish();
    const unsupported = () => { throw new Error("This contribution is unavailable in the local Desktop service role."); };
    const context: PluginServiceContext = {
      installation: instance.record, signal: instance.scope.signal, mode: "active", role: "service", own: instance.scope.own,
      get omp(): PluginServiceContext["omp"] { throw new Error("This local plugin does not have a selected daemon session."); },
      storage: {
        get: async <T>() => { instance.scope.assertCurrent(); const record = this.document.installations.find(({ id }) => id === instance.record.id)!; return { revision: record.revision, values: structuredClone(record.config) as T }; },
        patch: async <T>(patch: Partial<T>, expectedRevision: number): Promise<PluginStorageSnapshot<T>> => { instance.scope.assertCurrent(); const document = await this.store.patchPlugin({ installationId: instance.record.id, expectedRevision, patch: { config: patch as Record<string, unknown> } }, () => { instance.scope.assertCurrent(); this.assertAuthorized(instance.record.id, instance.scope.generation, "manage"); }); const record = document.installations.find(({ id }) => id === instance.record.id)!; return { revision: record.revision, values: structuredClone(record.config) as T }; },
      },
      secrets: {
        configured: async (key) => this.native(instance.record, instance.scope).invoke<boolean>("secret", { key, operation: "configured" }),
        get: async (key) => this.native(instance.record, instance.scope).invoke<string | null>("secret", { key, operation: "get" }),
        set: async (key, value) => { await this.native(instance.record, instance.scope).invoke("secret", { key, operation: "set", value }); },
        delete: async (key) => { await this.native(instance.record, instance.scope).invoke("secret", { key, operation: "delete" }); },
      },
      native: this.native(instance.record, instance.scope),
      handle: (contract, handler) => {
        if (instance.handlers.has(contract.name)) throw new Error(`Duplicate plugin RPC ${contract.name}.`);
        instance.handlers.set(contract.name, async (raw) => { instance.scope.assertCurrent(); const input = await contract.input.parseAsync(raw); const result = await handler(input, { get omp() { return context.omp; } }); instance.scope.assertCurrent(); return contract.output.parseAsync(result); });
      },
      waiting: (reason) => this.waiting(instance.record.id, instance.scope.generation, reason),
      addAgentTool: unsupported, addAgentPrompt: unsupported, addSurface: unsupported, addSidebarItem: unsupported, addWorkspacePanel: unsupported, addCommandCenterItem: unsupported, addAttachmentSource: unsupported, addTheme: unsupported,
    };
    try {
      const cleanup = await instance.definition.setup?.(context);
      if (instance.scope.signal.aborted) {
        try { await cleanup?.(); } catch (error) { this.onError(instance.record.id, String(error)); }
        return;
      }
      instance.scope.assertCurrent();
      if (cleanup) instance.scope.own(cleanup);
      if (instance.status === "activating") instance.status = "active";
    } catch (error) { if (!instance.scope.signal.aborted) this.fail(instance.record.id, instance.scope.generation, error instanceof Error ? error.message : String(error)); }
  }
  assertAuthorized(id: string, generation: number, purpose: "manage" | "background" | "active", capability?: string): LocalPluginRecord {
    if (this.stopped) throw new Error("Desktop plugins are stopping.");
    const record = this.document.installations.find((record) => record.id === id);
    const instance = this.instances.get(id);
    if (!record || (instance?.scope.generation ?? record.generation) !== generation) throw new Error("Plugin generation is no longer current.");
    if (!record.trusted) throw new Error("Plugin execution is not trusted.");
    if (capability && !record.grantedCapabilities.includes(capability)) throw new Error(`Plugin capability is not granted: ${capability}.`);
    if (purpose !== "manage" && (!record.installed || !record.enabled || !instance || instance.scope.signal.aborted || instance.status !== "active")) throw new Error("Plugin execution is not active.");
    if (purpose === "background" && this.document.backgroundProvider?.installationId !== id) throw new Error("Plugin is not the selected background provider.");
    return record;
  }
  assertServiceAuthorized(id: string, generation: number): LocalPluginRecord {
    const record = this.assertAuthorized(id, generation, "manage");
    const instance = this.instances.get(id);
    if (!record.installed || !record.enabled || !instance || instance.scope.signal.aborted || !["activating", "active", "waiting"].includes(instance.status)) throw new Error("Plugin service is not authorized.");
    return record;
  }
  async invoke(id: string, generation: number, operation: string, input: unknown): Promise<unknown> {
    const record = this.assertAuthorized(id, generation, "manage");
    const instance = this.instances.get(id);
    const definition = instance?.definition ?? (record.source.type === "builtin" ? this.definitions.get(record.packageId) : undefined);
    const manage = definition?.manage?.[operation];
    if (manage) return manage(input);
    if (definition?.manageInvoke && instance?.status !== "active") return definition.manageInvoke(operation, input, generation);
    this.assertAuthorized(id, generation, "active");
    if (definition?.invoke) return definition.invoke(operation, input, generation);
    const handler = instance!.handlers.get(operation);
    if (!handler) throw new Error(`Unknown plugin operation: ${operation}.`);
    return handler(input);
  }
  async resource(pathname: string): Promise<Response | null> { for (const definition of this.definitions.values()) { const response = await definition.resource?.(pathname); if (response) return response; } return null; }
  async whenIdle(): Promise<void> { for (;;) { const pending = this.queue; await pending; if (pending === this.queue) return; } }
  async reload(id: string): Promise<void> { const instance = this.instances.get(id); if (instance) { await this.stop(instance); this.instances.delete(id); } this.enqueue(); await this.whenIdle(); const current = this.instances.get(id); if (current?.status === "failed") throw new Error(current.error ?? "Plugin reload failed."); }
  fail(id: string, generation: number, message: string): void {
    const instance = this.instances.get(id);
    if (!instance || instance.scope.generation !== generation) return;
    instance.status = "failed"; instance.error = message;
    this.onError(id, message);
    for (const listener of this.revocations) listener(id, generation);
    void instance.scope.dispose().catch((error) => this.onError(id, String(error)));
    this.publish();
  }
  waiting(id: string, generation: number, reason: string | null): void { const instance = this.instances.get(id); if (!instance || instance.scope.generation !== generation || instance.scope.signal.aborted) return; instance.status = reason ? "waiting" : "active"; instance.error = reason; this.publish(); }
  async suspend(id: string): Promise<void> { const instance = this.instances.get(id); if (instance) await this.stop(instance); }
  async clearData(id: string): Promise<void> { const record = this.document.installations.find((record) => record.id === id); if (!record) throw new Error("Plugin installation is not installed."); const definition = this.instances.get(id)?.definition ?? this.definitions.get(record.packageId); await definition?.clearData?.(); }
  async dispose(): Promise<void> { if (this.stopped) return; this.stopped = true; this.unsubscribe?.(); await Promise.all([...this.instances.values()].map((instance) => this.stop(instance))); this.instances.clear(); }
}
