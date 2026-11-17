import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { Platform } from "react-native";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import { readValidatedJson } from "@/storage/validated-storage";

const STORAGE_KEY = "desktop-plugin-client-trust-v2";
const LEGACY_STORAGE_KEY = "desktop-plugin-client-trust-v1";
const schema = z.record(z.string(), z.object({ capabilities: z.array(z.string()) }).strict());
const legacySchema = z.record(
  z.string(),
  z.object({ bundleDigest: z.string(), capabilities: z.array(z.string()) }).strict(),
);
const legacyIdentitySchema = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);
const sourceIdentitySchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);
type TrustSource = Pick<DesktopPluginCatalogEntry, "id" | "packageId" | "source">;
let operations: Promise<void> = Promise.resolve();
const listeners = new Set<(installation: { hostId: string; installationId: string }) => void>();

function identity(hostId: string, plugin: TrustSource) {
  return JSON.stringify([hostId, plugin.id, plugin.packageId, plugin.source.path]);
}
function migrateLegacyTrust(legacy: z.infer<typeof legacySchema>): z.infer<typeof schema> {
  const migrated: z.infer<typeof schema> = {};
  for (const [key, approval] of Object.entries(legacy)) {
    const [hostId, installationId, packageId, sourcePath] = legacyIdentitySchema.parse(
      JSON.parse(key),
    );
    const sourceKey = JSON.stringify([hostId, installationId, packageId, sourcePath]);
    const saved = (migrated[sourceKey] ??= { capabilities: [] });
    // Every retained capability was explicitly approved for this same source.
    for (const capability of approval.capabilities) {
      if (!saved.capabilities.includes(capability)) saved.capabilities.push(capability);
    }
  }
  return migrated;
}
function withTrustStore<T>(operation: () => Promise<T>): Promise<T> {
  const pending = operations.then(() => {
    // Web storage is shared by windows; native AsyncStorage uses one JS runtime.
    // The previous WebCrypto digest already required a secure browser origin.
    if (Platform.OS === "web") {
      if (!navigator.locks) throw new Error("Secure browser storage locking is unavailable");
      return navigator.locks.request(STORAGE_KEY, operation);
    }
    return operation();
  });
  operations = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}
async function load() {
  // Always read inside the lock: another renderer may have revoked an approval.
  const saved = await readValidatedJson(AsyncStorage, STORAGE_KEY, schema, { invalid: "throw" });
  if (saved !== null) return saved;
  const legacy = await readValidatedJson(AsyncStorage, LEGACY_STORAGE_KEY, legacySchema, {
    invalid: "throw",
  });
  const next = migrateLegacyTrust(legacy ?? {});
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (legacy !== null) {
    try {
      await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (error) {
      // The durable v2 record is authoritative even if obsolete-key cleanup fails.
      console.warn("Failed to remove obsolete plugin device trust records", error);
    }
  }
  return next;
}
export async function hasPluginClientTrust(
  hostId: string,
  plugin: DesktopPluginCatalogEntry,
): Promise<boolean> {
  if (!plugin.clientBundle) return false;
  return withTrustStore(async () => {
    const saved = (await load())[identity(hostId, plugin)];
    return (
      !!saved &&
      plugin.declaredCapabilities.every((capability) => saved.capabilities.includes(capability))
    );
  });
}
export async function approvePluginClientTrust(
  hostId: string,
  plugin: TrustSource & Pick<DesktopPluginCatalogEntry, "declaredCapabilities">,
): Promise<void> {
  await withTrustStore(async () => {
    const next = await load();
    const approval = (next[identity(hostId, plugin)] ??= { capabilities: [] });
    for (const capability of plugin.declaredCapabilities) {
      if (!approval.capabilities.includes(capability)) approval.capabilities.push(capability);
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    for (const listener of listeners) listener({ hostId, installationId: plugin.id });
  });
}
export async function revokePluginClientTrust(
  hostId: string,
  installationId: string,
): Promise<void> {
  const prefix = `${JSON.stringify([hostId, installationId]).slice(0, -1)},`;
  await withTrustStore(async () => {
    const next = Object.fromEntries(
      Object.entries(await load()).filter(([key]) => !key.startsWith(prefix)),
    );
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    for (const listener of listeners) listener({ hostId, installationId });
  });
}
function notifySource(key: string) {
  const [hostId, installationId] = sourceIdentitySchema.parse(JSON.parse(key));
  for (const listener of listeners) listener({ hostId, installationId });
}
function onStorageChange(event: StorageEvent) {
  if (event.key !== STORAGE_KEY || event.storageArea !== window.localStorage) return;
  const before = schema.parse(event.oldValue === null ? {} : JSON.parse(event.oldValue));
  const after = schema.parse(event.newValue === null ? {} : JSON.parse(event.newValue));
  for (const [key, approval] of Object.entries(before)) {
    const next = after[key];
    if (
      !next ||
      approval.capabilities.length !== next.capabilities.length ||
      approval.capabilities.some((capability) => !next.capabilities.includes(capability))
    )
      notifySource(key);
  }
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) notifySource(key);
  }
}
export function subscribePluginClientTrust(
  listener: (installation: { hostId: string; installationId: string }) => void,
) {
  listeners.add(listener);
  if (Platform.OS === "web" && listeners.size === 1)
    window.addEventListener("storage", onStorageChange);
  return () => {
    listeners.delete(listener);
    if (Platform.OS === "web" && listeners.size === 0)
      window.removeEventListener("storage", onStorageChange);
  };
}
