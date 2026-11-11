import AsyncStorage from "@react-native-async-storage/async-storage";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { z } from "zod";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import { readValidatedJson } from "@/storage/validated-storage";

const STORAGE_KEY = "desktop-plugin-client-trust-v1";
const schema = z.record(z.string(), z.object({ bundleDigest: z.string(), capabilities: z.array(z.string()) }).strict());
let records: z.infer<typeof schema> | null = null;
let loading: Promise<z.infer<typeof schema>> | null = null;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<(installation: { hostId: string; installationId: string }) => void>();

function identity(hostId: string, plugin: DesktopPluginCatalogEntry) {
  return JSON.stringify([hostId, plugin.id, plugin.packageId, plugin.source.path, plugin.version]);
}
async function load() {
  if (records) return records;
  if (!loading) loading = readValidatedJson(AsyncStorage, STORAGE_KEY, schema, { invalid: "throw" }).then((value) => { records = value ?? {}; return records; });
  return loading;
}
async function digest(bundle: string) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, bundle);
}
export async function hasPluginClientTrust(hostId: string, plugin: DesktopPluginCatalogEntry): Promise<boolean> {
  if (!plugin.clientBundle) return false;
  const saved = (await load())[identity(hostId, plugin)];
  return !!saved && saved.bundleDigest === await digest(plugin.clientBundle) && plugin.declaredCapabilities.every((capability) => saved.capabilities.includes(capability));
}
export async function approvePluginClientTrust(hostId: string, plugin: DesktopPluginCatalogEntry): Promise<void> {
  if (!plugin.clientBundle) throw new Error("Plugin client bundle is unavailable");
  const approval = { bundleDigest: await digest(plugin.clientBundle), capabilities: [...plugin.declaredCapabilities] };
  const operation = writes.then(async () => {
    const next = { ...await load(), [identity(hostId, plugin)]: approval };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    records = next;
    for (const listener of listeners) listener({ hostId, installationId: plugin.id });
  });
  writes = operation.catch(() => undefined);
  await operation;
}
export async function revokePluginClientTrust(hostId: string, installationId: string): Promise<void> {
  const prefix = `${JSON.stringify([hostId, installationId]).slice(0, -1)},`;
  const operation = writes.then(async () => {
    const next = Object.fromEntries(Object.entries(await load()).filter(([key]) => !key.startsWith(prefix)));
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    records = next;
    for (const listener of listeners) listener({ hostId, installationId });
  });
  writes = operation.catch(() => undefined);
  await operation;
}
export function subscribePluginClientTrust(listener: (installation: { hostId: string; installationId: string }) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
