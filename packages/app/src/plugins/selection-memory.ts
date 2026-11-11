import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";

export interface PluginContributionHostReference { readonly owner: "desktop" | "daemon"; readonly hostId: string }
const hostSchema: z.ZodType<PluginContributionHostReference> = z.object({ owner: z.enum(["desktop", "daemon"]), hostId: z.string() }).strict();
const storageKey = "desktop-plugin-contribution-hosts-v1";
let hosts: Readonly<Record<string, PluginContributionHostReference>> = {};
let ready = false;
let loading: Promise<void> | null = null;
let error: string | null = null;
let pending: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let snapshot: { ready: boolean; hosts: Readonly<Record<string, PluginContributionHostReference>>; error: string | null } = { ready, hosts, error };
function publish() {
  snapshot = { ready, hosts, error };
  for (const listener of listeners) listener();
}
export const pluginSelectionMemory = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async load() {
    if (ready) return;
    if (!loading) loading = readValidatedJson(AsyncStorage, storageKey, z.record(z.string(), hostSchema), { invalid: "throw" }).then((value) => {
      hosts = value ?? {};
      ready = true;
      error = null;
      publish();
    }).catch((failure) => {
      loading = null;
      error = failure instanceof Error ? failure.message : String(failure);
      publish();
      throw failure;
    });
    await loading;
  },
  async select(kind: "theme" | "surface" | "sidebar", id: string, hostId: string, owner: "desktop" | "daemon") {
    const operation = pending.then(async () => {
      await this.load();
      const next = { ...hosts, [`${kind}:${id}`]: Object.freeze({ hostId, owner }) };
      await AsyncStorage.setItem(storageKey, JSON.stringify(next));
      hosts = next;
      error = null;
      publish();
    });
    pending = operation.catch((failure) => {
      error = failure instanceof Error ? failure.message : String(failure);
      publish();
    });
    await operation;
  },
};
