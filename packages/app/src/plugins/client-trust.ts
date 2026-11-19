import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { Platform } from "react-native";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import {
  applyPluginClientTrust,
  PluginClientTrustDocumentSchema as schema,
  PluginClientTrustIdentitySchema,
  type PluginClientTrustDocument,
  type PluginClientTrustInstallation,
  type PluginClientTrustOperation,
} from "@omp-desktop/protocol/plugin-client-trust";
import { getDesktopHost } from "@/desktop/host";
import { readValidatedJson } from "@/storage/validated-storage";

const STORAGE_KEY = "desktop-plugin-client-trust-v2";
const LEGACY_STORAGE_KEY = "desktop-plugin-client-trust-v1";
const legacySchema = z.record(
  z.string(),
  z.object({ bundleDigest: z.string(), capabilities: z.array(z.string()) }).strict(),
);
const legacyIdentitySchema = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);
type TrustSource = Pick<DesktopPluginCatalogEntry, "id" | "packageId" | "source" | "declaredCapabilities">;
let operations: Promise<void> = Promise.resolve();
const listeners = new Set<(installation: PluginClientTrustInstallation) => void>();
let unsubscribeDesktop: (() => void) | undefined;

function notify(installation: PluginClientTrustInstallation) {
  for (const listener of listeners) listener(installation);
}
function migrateLegacyTrust(legacy: z.infer<typeof legacySchema>): PluginClientTrustDocument {
  const migrated: PluginClientTrustDocument = {};
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
    // Unlike desktop IPC, browser storage needs a lock shared across tabs.
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
function readCurrentTrust() {
  return readValidatedJson(AsyncStorage, STORAGE_KEY, schema, { invalid: "throw" });
}

function readLegacyTrust() {
  return readValidatedJson(AsyncStorage, LEGACY_STORAGE_KEY, legacySchema, {
    invalid: "throw",
  });
}

async function load() {
  // Always read inside the lock: another renderer may have revoked an approval.
  const saved = await readCurrentTrust();
  if (saved !== null) return saved;
  const legacy = await readLegacyTrust();
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
async function accessTrust(operation: PluginClientTrustOperation): Promise<boolean> {
  const desktop = getDesktopHost()?.pluginClientTrust;
  if (desktop) {
    const stored = await desktop.access({ operation });
    if (stored !== null) return stored;
    const initial = await readCurrentTrust() ?? migrateLegacyTrust(await readLegacyTrust() ?? {});
    const initialized = await desktop.access({ operation, initial });
    if (initialized === null) throw new Error("Plugin client trust initialization failed");
    return initialized;
  }

  return withTrustStore(async () => {
    const document = await load();
    const result = applyPluginClientTrust(document, operation);
    if (operation.action !== "check") {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(document));
      notify({ hostId: operation.hostId, installationId: operation.installationId });
    }
    return result;
  });
}

function describeSource(hostId: string, plugin: TrustSource) {
  return {
    hostId,
    installationId: plugin.id,
    packageId: plugin.packageId,
    sourcePath: plugin.source.path,
    capabilities: plugin.declaredCapabilities,
  };
}

export async function hasPluginClientTrust(hostId: string, plugin: DesktopPluginCatalogEntry): Promise<boolean> {
  return !!plugin.clientBundle && accessTrust({ action: "check", ...describeSource(hostId, plugin) });
}

export async function approvePluginClientTrust(hostId: string, plugin: TrustSource): Promise<void> {
  await accessTrust({ action: "approve", ...describeSource(hostId, plugin) });
}

export async function revokePluginClientTrust(hostId: string, installationId: string): Promise<void> {
  await accessTrust({ action: "revoke", hostId, installationId });
}

function notifySource(key: string) {
  const [hostId, installationId] = PluginClientTrustIdentitySchema.parse(JSON.parse(key));
  notify({ hostId, installationId });
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
export function subscribePluginClientTrust(listener: (installation: PluginClientTrustInstallation) => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const desktop = getDesktopHost()?.pluginClientTrust;
    if (desktop) unsubscribeDesktop = desktop.onChanged(notify);
    else if (Platform.OS === "web") window.addEventListener("storage", onStorageChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    if (unsubscribeDesktop) {
      unsubscribeDesktop();
      unsubscribeDesktop = undefined;
    } else if (Platform.OS === "web") {
      window.removeEventListener("storage", onStorageChange);
    }
  };
}
