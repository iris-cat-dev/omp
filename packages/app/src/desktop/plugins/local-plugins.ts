import { LocalPluginSnapshotSchema, LocalPluginDirectoryInspectionSchema, LocalPluginLogEntrySchema, type LocalPluginPatch, type LocalPluginSnapshot, type LocalPluginDirectoryInstall, type LocalPluginDirectoryInspection, type LocalPluginLogEntry } from "@omp-desktop/protocol/desktop-local-plugins";
import type { WallpaperLegacyPluginInput } from "@omp-desktop/protocol/desktop-wallpaper";
import { getDesktopHost } from "@/desktop/host";

function requireLocalPlugins() { const plugins = getDesktopHost()?.plugins; if (!plugins) throw new Error("Local Desktop plugins require the native Desktop host."); return plugins; }
export async function getLocalPluginSnapshot(): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().getSnapshot()); }
export async function patchLocalPlugin(input: LocalPluginPatch): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().patch(input)); }
export async function reloadLocalPlugin(input: { installationId: string; expectedRevision: number }): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().reload(input)); }
export async function removeLocalPlugin(input: { installationId: string; expectedRevision: number }): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().remove(input)); }
export async function reinstallLocalPlugin(input: { installationId: string; expectedRevision: number }): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().reinstall(input)); }
export async function clearLocalPluginData(input: { installationId: string; expectedRevision: number }): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().clearData(input)); }
export async function selectLocalPluginBackground(input: { provider: { installationId: string; extensionId: string } | null; expectedRevision: number }): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().selectBackground(input)); }
export async function migrateLegacyWallpaperPlugin(input: WallpaperLegacyPluginInput): Promise<void> { await requireLocalPlugins().migrateLegacy({ wallpaper: input }); }
export async function inspectLocalPluginDirectory(input: { directory: string }): Promise<LocalPluginDirectoryInspection> { return LocalPluginDirectoryInspectionSchema.parse(await requireLocalPlugins().inspectDirectory(input)); }
export async function installLocalPluginDirectory(input: LocalPluginDirectoryInstall): Promise<LocalPluginSnapshot> { return LocalPluginSnapshotSchema.parse(await requireLocalPlugins().installDirectory(input)); }
export async function getLocalPluginLogs(input: { installationId: string }): Promise<LocalPluginLogEntry[]> { return (await requireLocalPlugins().getLogs(input)).map((entry) => LocalPluginLogEntrySchema.parse(entry)); }
export function subscribeLocalPlugins(listener: (snapshot: LocalPluginSnapshot) => void): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const events = getDesktopHost()?.events;
  if (!events?.on) return () => undefined;
  void Promise.resolve(events.on("desktop-plugins-changed", (value) => { if (!disposed) listener(LocalPluginSnapshotSchema.parse(value)); })).then((remove) => { if (disposed) remove(); else unsubscribe = remove; }).catch((error) => { console.error("[Desktop plugins] Catalog subscription failed", error); });
  return () => { disposed = true; unsubscribe?.(); };
}
