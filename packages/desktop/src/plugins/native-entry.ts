import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import type { PluginCleanup, PluginDesktopNativeContext, PluginDesktopNativeSetup, PluginServiceSetup } from "@omp-desktop/plugin";
import type { PluginActivationScope } from "@omp-desktop/plugin/server";
import type { LocalPluginDirectoryInspection, LocalPluginRecord } from "@omp-desktop/protocol/desktop-local-plugins";

// Use Node's CommonJS loader, including mini-electron's Electron require bridge.
const nativeRequire = createRequire(__filename);
const documents = new Map<string, { html: string; scope: PluginActivationScope }>();
const trayItems = new Map<string, { label: string; click(): void; scope: PluginActivationScope }>();
const trayListeners = new Set<() => void>();
function trayChanged(): void { for (const listener of trayListeners) listener(); }

export function getPluginNativeTrayItems(): readonly { label: string; click(): void }[] {
  return [...trayItems.values()].filter(({ scope }) => !scope.signal.aborted).map(({ label, click }) => ({ label, click }));
}
export function onPluginNativeTrayItemsChanged(listener: () => void): () => void {
  trayListeners.add(listener);
  return () => { trayListeners.delete(listener); };
}
export function handlePluginNativeDocument(decodedPath: string): Response | undefined {
  const document = documents.get(decodedPath);
  if (!document || document.scope.signal.aborted) return undefined;
  return new Response(document.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export interface PluginNativeEntryDependencies {
  userDataPath: string;
  launchAtLogin: PluginDesktopNativeContext["desktop"]["launchAtLogin"];
  assertAuthorized(record: LocalPluginRecord, scope: PluginActivationScope): void;
  onError(id: string, message: string): void;
}
function dataDirectory(userDataPath: string, installationId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(installationId)) throw new Error("Invalid plugin installation identity.");
  return path.join(userDataPath, "desktop-plugins", "data", installationId, "native");
}
async function ownedDataDirectory(userDataPath: string, installationId: string): Promise<string> {
  const directory = dataDirectory(userDataPath, installationId);
  await mkdir(userDataPath, { recursive: true });
  const root = await realpath(userDataPath);
  let current = root;
  for (const component of ["desktop-plugins", "data", installationId]) {
    current = path.join(current, component);
    await mkdir(current, { recursive: true });
    if (await realpath(current) !== current) throw new Error("Plugin native data directory escapes its scope.");
  }
  try { if (await realpath(directory) !== path.join(root, "desktop-plugins", "data", installationId, "native")) throw new Error("Plugin native data directory escapes its scope."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return directory;
}
export async function clearPluginNativeData(userDataPath: string, installationId: string): Promise<void> {
  const directory = dataDirectory(userDataPath, installationId);
  try {
    const canonical = await realpath(directory), root = await realpath(userDataPath);
    if (canonical !== path.join(root, path.relative(path.resolve(userDataPath), path.resolve(directory)))) throw new Error("Plugin native data directory escapes its scope.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await rm(directory, { recursive: true, force: true });
}
function unloadPackage(directory: string): void {
  const prefix = `${directory}${path.sep}`;
  for (const filename of Object.keys(nativeRequire.cache)) {
    if (filename.startsWith(prefix) && !path.relative(directory, filename).split(path.sep).includes("node_modules")) delete nativeRequire.cache[filename];
  }
}

/** Inspection is static; this object never evaluates the entry until setup is activated. */
export function createPluginNativeEntry(record: LocalPluginRecord, scope: PluginActivationScope, inspected: LocalPluginDirectoryInspection, dependencies: PluginNativeEntryDependencies): { setup: PluginServiceSetup; prepareToStop(): Promise<void> } {
  const preparations = new Set<() => void | Promise<void>>();
  let preparing: Promise<void> | undefined;
  const authorize = () => {
    scope.assertCurrent();
    if (!record.installed || !record.enabled || !record.trusted || record.owner !== "desktop" || !record.declaredCapabilities.includes("native.main") || !record.grantedCapabilities.includes("native.main")) throw new Error("Plugin native.main execution is not approved and enabled.");
    dependencies.assertAuthorized(record, scope);
  };
  return {
    prepareToStop() {
      if (preparing) return preparing;
      preparing = (async () => { for (const prepare of [...preparations].reverse()) await prepare(); })().finally(() => { preparing = undefined; });
      return preparing;
    },
    setup: async (context) => {
      authorize();
      const directory = await realpath(inspected.directory);
      const entry = inspected.nativeEntry && await realpath(inspected.nativeEntry);
      if (!entry || !entry.startsWith(`${directory}${path.sep}`) || !/\.(?:cjs|js)$/.test(entry)) throw new Error("Plugin native entry escapes its CommonJS package.");
      const nativeData = await ownedDataDirectory(dependencies.userDataPath, record.id);
      authorize();
      const registeredDocuments = new Set<string>(), registeredTrayItems = new Set<string>();
      scope.own(() => unloadPackage(directory));
      const desktop: PluginDesktopNativeContext["desktop"] = {
        dataDirectory: nativeData,
        beforeStop(prepare) {
          authorize();
          preparations.add(prepare);
          return scope.own(() => { preparations.delete(prepare); });
        },
        registerDocument(id, html) {
          authorize();
          if (!id || typeof html !== "string") throw new TypeError("A native document requires an id and HTML.");
          if (registeredDocuments.has(id)) throw new Error(`Duplicate plugin native document: ${id}.`);
          registeredDocuments.add(id);
          const pathname = `/${record.id}/${scope.generation}/${randomUUID()}`;
          documents.set(pathname, { html, scope });
          scope.own(() => { documents.delete(pathname); registeredDocuments.delete(id); });
          return `omp-desktop://plugin-native${pathname}`;
        },
        addTrayItem(item) {
          authorize();
          if (!item.id || !item.label || typeof item.onSelect !== "function") throw new TypeError("A native tray item requires an id, label and callback.");
          if (registeredTrayItems.has(item.id)) throw new Error(`Duplicate plugin native tray item: ${item.id}.`);
          registeredTrayItems.add(item.id);
          const key = `${scope.id}:${item.id}`;
          trayItems.set(key, { label: item.label, scope, click() {
            if (scope.signal.aborted) return;
            try { authorize(); void Promise.resolve(item.onSelect()).catch((error) => dependencies.onError(record.id, String(error))); }
            catch (error) { dependencies.onError(record.id, String(error)); }
          } });
          const release: PluginCleanup = scope.own(() => { trayItems.delete(key); registeredTrayItems.delete(item.id); trayChanged(); });
          trayChanged();
          return release;
        },
        launchAtLogin: {
          get() { authorize(); return dependencies.launchAtLogin.get(); },
          set(enabled) { authorize(); return dependencies.launchAtLogin.set(enabled); },
        },
      };
      const loaded: unknown = nativeRequire(entry);
      const setup = typeof loaded === "function" ? loaded : loaded && typeof loaded === "object" ? Reflect.get(loaded, "default") : undefined;
      if (typeof setup !== "function") throw new Error("Plugin native entry must default-export a setup function.");
      return (setup as PluginDesktopNativeSetup)(Object.assign(Object.create(context) as PluginDesktopNativeContext, { desktop }));
    },
  };
}
