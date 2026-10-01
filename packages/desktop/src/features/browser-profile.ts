import { readdir } from "node:fs/promises";
import path from "node:path";

const BROWSER_PARTITION = "persist:omp-desktop-browser";
const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;

interface RetiredBrowserSession {
  getStoragePath(): string | null;
  clearStorageData(options: {
    storages: Array<
      | "cookies"
      | "filesystem"
      | "indexdb"
      | "localstorage"
      | "shadercache"
      | "serviceworkers"
      | "cachestorage"
      | "websql"
    >;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface ElectronSessions {
  fromPartition(partition: string): RetiredBrowserSession;
}

async function clearProfile(profile: RetiredBrowserSession): Promise<void> {
  await Promise.all([
    profile.clearStorageData({
      storages: [
        "cookies",
        "filesystem",
        "indexdb",
        "localstorage",
        "shadercache",
        "serviceworkers",
        "cachestorage",
        "websql",
      ],
    }),
    profile.clearCache(),
    profile.clearAuthCache(),
  ]);
}

/**
 * Only the retired browser's persistent partitions may be cleared here.
 * Never clear defaultSession: it also holds the main window's application state.
 */
export async function clearRetiredBrowserProfiles(
  sessions: ElectronSessions,
  onError: (partition: string, error: unknown) => void,
): Promise<void> {
  const shared = sessions.fromPartition(BROWSER_PARTITION);
  const sharedStoragePath = shared.getStoragePath();
  try {
    await clearProfile(shared);
  } catch (error) {
    onError(BROWSER_PARTITION, error);
  }

  // Older releases used one partition per browser ID. Only consider real
  // sibling directories of the shared partition's Electron-reported path;
  // never infer a location from userData or traverse symlinks.
  if (!sharedStoragePath) return;
  const parent = path.dirname(sharedStoragePath);
  const prefix = `${path.basename(sharedStoragePath)}-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const browserId = entry.name.slice(prefix.length);
    if (!LEGACY_BROWSER_ID_PATTERN.test(browserId)) continue;
    const partition = `${BROWSER_PARTITION}-${browserId}`;
    const legacy = sessions.fromPartition(partition);
    // Electron must confirm this partition maps to precisely this sibling.
    if (legacy.getStoragePath() !== path.join(parent, entry.name)) continue;
    try {
      await clearProfile(legacy);
    } catch (error) {
      onError(partition, error);
    }
  }
}
