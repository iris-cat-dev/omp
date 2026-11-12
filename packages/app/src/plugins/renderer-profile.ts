import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { z } from "zod";
import { agentSpeedBuiltinDescriptor } from "@omp-desktop/plugin-agent-speed/builtin";
import { LocalPluginDocumentSchema, LocalPluginPatchSchema, LocalPluginActionSchema, type LocalPluginDocument, type LocalPluginPatch, type LocalPluginRecord, type LocalPluginSnapshot, type LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
import { readValidatedJson } from "@/storage/validated-storage";

export const RENDERER_PLUGIN_PROFILE_KEY = "omp.local-renderer-plugins.v1";
type Action = { installationId: string; expectedRevision: number };
export interface RendererProfileStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
type Exclusive = <T>(operation: () => Promise<T>) => Promise<T>;
const descriptor = agentSpeedBuiltinDescriptor;
const ProfileSchema = LocalPluginDocumentSchema.refine((document) => document.backgroundProvider === null && document.installations.length === 1 && document.installations.every((record) => record.id === descriptor.id && record.packageId === descriptor.id && record.format === "builtin" && record.metadata === null && record.source.type === "builtin" && record.source.identity === `builtin:${descriptor.id}` && record.declaredCapabilities.length === 0 && !Object.hasOwn(record.config, "enabled")), "Invalid renderer-only plugin profile.");
function defaults(): LocalPluginDocument {
  return ProfileSchema.parse({ revision: 0, installations: [{ id: descriptor.id, packageId: descriptor.id, owner: "desktop", version: descriptor.version, generation: 0, enabled: descriptor.defaultEnabled, installed: true, trusted: true, source: { type: "builtin", identity: `builtin:${descriptor.id}` }, config: descriptor.defaultConfig, declaredCapabilities: [...descriptor.capabilities], grantedCapabilities: [...descriptor.capabilities], revision: 0, migrationVersion: 1 }] });
}
function advance(value: number) {
  if (value === Number.MAX_SAFE_INTEGER) throw new RangeError("Plugin revision exhausted.");
  return value + 1;
}

/** One physical client profile, never a daemon or a simulated native host. */
export class RendererPluginProfile {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private logs = new Map<string, LocalPluginLogEntry[]>();
  private failures = new Map<string, { generation: number; message: string }>();
  constructor(private storage: RendererProfileStorage, private exclusive?: Exclusive) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.exclusive ? this.exclusive(operation) : operation();
    const result = this.queue.then(run, run);
    this.queue = result;
    return result;
  }
  private snapshot(document: LocalPluginDocument): LocalPluginSnapshot {
    return { revision: document.revision, backgroundProvider: null, installations: document.installations.map((record) => {
      const failure = this.failures.get(record.id);
      const error = failure?.generation === record.generation ? failure.message : null;
      return { ...record, status: !record.installed ? "removed" : !record.enabled ? "disabled" : error ? "failed" : record.trusted ? "active" : "waiting", error };
    }) };
  }
  getSnapshot(): Promise<LocalPluginSnapshot> {
    return this.serial(async () => {
      let document = await readValidatedJson(this.storage, RENDERER_PLUGIN_PROFILE_KEY, ProfileSchema, { invalid: "throw" });
      if (!document) {
        document = defaults();
        await this.storage.setItem(RENDERER_PLUGIN_PROFILE_KEY, JSON.stringify(document));
      }
      return this.snapshot(document);
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify() { for (const listener of this.listeners) listener(); }
  private mutate(input: Action, change: (record: LocalPluginRecord) => void, authorize?: (record: LocalPluginRecord) => void): Promise<LocalPluginSnapshot> {
    return this.serial(async () => {
      const document = await readValidatedJson(this.storage, RENDERER_PLUGIN_PROFILE_KEY, ProfileSchema, { invalid: "throw" }) ?? defaults();
      const record = document.installations.find(({ id }) => id === input.installationId);
      if (!record) throw new Error("Plugin installation is not installed.");
      if (record.revision !== input.expectedRevision) throw new Error("Plugin configuration changed. Reload it before saving.");
      authorize?.(record);
      change(record);
      record.revision = advance(record.revision);
      document.revision = advance(document.revision);
      const next = ProfileSchema.parse(document);
      await this.storage.setItem(RENDERER_PLUGIN_PROFILE_KEY, JSON.stringify(next));
      this.notify();
      return this.snapshot(next);
    });
  }
  patch(raw: LocalPluginPatch, authorize?: (record: LocalPluginRecord) => void) {
    const input = LocalPluginPatchSchema.parse(raw);
    return this.mutate(input, (record) => {
      const patch = input.patch;
      if (patch.enabled && !record.installed) throw new Error("Reinstall the plugin before enabling it.");
      if (patch.config) {
        if (Object.hasOwn(patch.config, "enabled")) throw new TypeError("Plugin enabled state is not configuration.");
        record.config = { ...record.config, ...patch.config };
      }
      if (patch.enabled !== undefined || patch.trusted !== undefined || patch.grantedCapabilities !== undefined) record.generation = advance(record.generation);
      if (patch.enabled !== undefined) record.enabled = patch.enabled;
      if (patch.trusted !== undefined) record.trusted = patch.trusted;
      if (patch.grantedCapabilities !== undefined) record.grantedCapabilities = [...new Set(patch.grantedCapabilities)];
    }, authorize);
  }
  reload(raw: Action) { return this.action(raw, "reload"); }
  remove(raw: Action) { return this.action(raw, "remove"); }
  reinstall(raw: Action) { return this.action(raw, "reinstall"); }
  clearData(raw: Action) { return this.action(raw, "clearData"); }
  private action(raw: Action, action: "reload" | "remove" | "reinstall" | "clearData") {
    const input = LocalPluginActionSchema.parse(raw);
    return this.mutate(input, (record) => {
      record.generation = advance(record.generation);
      if (action === "clearData") record.config = { ...descriptor.defaultConfig };
      else if (action !== "reload") { record.installed = action === "reinstall"; record.enabled = false; }
    }).then((snapshot) => {
      if (action === "clearData") this.logs.delete(input.installationId);
      return snapshot;
    });
  }
  async getLogs(input: { installationId: string }): Promise<LocalPluginLogEntry[]> {
    const { installationId } = z.object({ installationId: z.string() }).parse(input);
    const snapshot = await this.getSnapshot();
    if (!snapshot.installations.some(({ id }) => id === installationId)) throw new Error("Plugin installation is not installed.");
    return (this.logs.get(installationId) ?? []).map((entry) => ({ ...entry }));
  }
  fail(id: string, generation: number, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.failures.set(id, { generation, message });
    const entries = this.logs.get(id) ?? [];
    entries.push({ timestamp: new Date().toISOString(), stream: "host", message });
    this.logs.set(id, entries.slice(-200));
    this.notify();
  }
}

let lockDatabase: Promise<IDBDatabase> | undefined;
async function browserProfileExclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(RENDERER_PLUGIN_PROFILE_KEY, operation);
  // Only the mutex lives in IndexedDB; all profile data remains in AsyncStorage.
  if (!lockDatabase) {
    const pending = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("omp-plugin-profile-locks", 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore("mutex"); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); lockDatabase = undefined; };
      pending.resolve(request.result);
    };
    request.onerror = () => { lockDatabase = undefined; pending.reject(request.error); };
    request.onblocked = () => {
      blocked = true;
      lockDatabase = undefined;
      pending.reject(new Error("Client plugin profile lock database is blocked by another document."));
    };
    lockDatabase = pending.promise;
  }
  const database = await lockDatabase;
  const pending = Promise.withResolvers<T>();
  const transaction = database.transaction("mutex", "readwrite");
  const store = transaction.objectStore("mutex");
  let started = false;
  let finished = false;
  let result: T;
  let failure: unknown;
  let failed = false;
  // IDB requests keep the transaction/lock alive while awaiting AsyncStorage.
  // Each request yields to the event loop, rather than spinning synchronously.
  const keepAlive = () => {
    const request = store.get(RENDERER_PLUGIN_PROFILE_KEY);
    request.onsuccess = () => {
      if (!started) {
        started = true;
        void operation().then((value) => { result = value; finished = true; }, (error: unknown) => { failure = error; failed = true; finished = true; });
      }
      if (!finished) keepAlive();
    };
  };
  transaction.oncomplete = () => { if (failed) pending.reject(failure); else pending.resolve(result!); };
  transaction.onabort = () => pending.reject(transaction.error ?? new Error("Client plugin profile lock transaction was aborted."));
  keepAlive();
  return pending.promise;
}


let profile: RendererPluginProfile | undefined;
export function getRendererPluginProfile() {
  if (!profile) {
    // Serialize reads and writes across same-origin documents, including initialization.
    const exclusive: Exclusive = async (operation) => {
      if (Platform.OS !== "web" || typeof window === "undefined") return operation();
      return browserProfileExclusive(operation);
    };
    profile = new RendererPluginProfile(AsyncStorage, exclusive);
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("storage", (event) => { if (event.key === RENDERER_PLUGIN_PROFILE_KEY || event.key === null) profile!.notify(); });
      window.addEventListener("focus", () => profile!.notify());
    }
  }
  return profile;
}
