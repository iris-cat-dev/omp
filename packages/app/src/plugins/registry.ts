import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSourceContribution,
  PluginBackgroundContribution,
  PluginClientContext,
  PluginCommandCenterItemContribution,
  PluginInstallation,
  PluginMenuItemContribution,
  PluginOverlayContribution,
  PluginSettingsPageContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginThemeContribution,
  PluginTurnMetricContribution,
  PluginWorkspacePanelContribution,
} from "@omp-desktop/plugin";
import type { PluginActivationScope } from "@omp-desktop/plugin/host";

export interface PluginContributions {
  surface: PluginSurfaceContribution;
  sidebar: PluginSidebarContribution;
  panel: PluginWorkspacePanelContribution;
  command: PluginCommandCenterItemContribution;
  attachment: PluginAttachmentSourceContribution;
  theme: PluginThemeContribution;
  settings: PluginSettingsPageContribution;
  menu: PluginMenuItemContribution;
  metric: PluginTurnMetricContribution;
  background: PluginBackgroundContribution;
  overlay: PluginOverlayContribution;
}

export interface PluginClientInstance {
  key: string;
  hostId: string;
  installation: PluginInstallation;
  scope: PluginActivationScope;
  mode: "manage" | "active";
  format: "legacy" | "package";
  queryClient: QueryClient;
  context: PluginClientContext;
  contributions: { [K in keyof PluginContributions]: readonly PluginContributions[K][] };
  invoke(method: string, input: unknown): Promise<unknown>;
}

export interface RegisteredPluginContribution<K extends keyof PluginContributions> {
  key: string;
  instance: PluginClientInstance;
  contribution: PluginContributions[K];
}

export interface PluginClientSnapshot {
  revision: number;
  instances: readonly PluginClientInstance[];
  errors: ReadonlyMap<string, string>;
  backgroundSelection: string | null;
}

export function pluginInstanceKey(hostId: string, installationId: string, owner: PluginInstallation["owner"]): string {
  return JSON.stringify([owner, hostId, installationId]);
}

export function pluginExtensionKey(instanceKey: string, kind: keyof PluginContributions, id: string): string {
  return JSON.stringify([instanceKey, kind, id]);
}

export function emptyPluginContributions(): PluginClientInstance["contributions"] {
  return { surface: [], sidebar: [], panel: [], command: [], attachment: [], theme: [], settings: [], menu: [], metric: [], background: [], overlay: [] };
}

export function createPluginClientRegistry() {
  const instances = new Map<string, PluginClientInstance>();
  const scopes = new Map<string, PluginActivationScope>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let backgroundSelection: string | null = null;
  let snapshot: PluginClientSnapshot = { revision: 0, instances: [], errors: new Map(), backgroundSelection };

  function publish() {
    snapshot = {
      revision: snapshot.revision + 1,
      instances: [...instances.values()].sort((a, b) => a.key.localeCompare(b.key)),
      errors: new Map(errors),
      backgroundSelection,
    };
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    changed(key: string) {
      if (instances.has(key)) publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(key: string, scope: PluginActivationScope) {
      scope.assertCurrent();
      scopes.set(key, scope);
      if (errors.delete(key)) publish();
    },
    replace(instance: PluginClientInstance) {
      instance.scope.assertCurrent();
      const previous = instances.get(instance.key);
      if (previous && previous !== instance) throw new Error("Stop the previous plugin client before replacing it");
      instances.set(instance.key, instance);
      scopes.set(instance.key, instance.scope);
      errors.delete(instance.key);
      publish();
    },
    remove(key: string, scope?: PluginActivationScope) {
      const current = instances.get(key);
      if (!current || (scope && current.scope !== scope)) return;
      instances.delete(key);
      publish();
    },
    fail(key: string, error: unknown, scope?: PluginActivationScope) {
      if (scope && scopes.get(key) !== scope) return;
      if (!scope) scopes.delete(key);
      errors.set(key, error instanceof Error ? error.message : String(error));
      publish();
    },
    selectBackground(key: string | null) {
      if (backgroundSelection === key) return;
      backgroundSelection = key;
      publish();
    },
  };
}

export const pluginClientRegistry = createPluginClientRegistry();

export function collectPluginContributions<K extends keyof PluginContributions>(
  snapshot: PluginClientSnapshot,
  kind: K,
  hostId?: string,
  owner?: PluginInstallation["owner"],
): RegisteredPluginContribution<K>[] {
  const result: RegisteredPluginContribution<K>[] = [];
  for (const instance of snapshot.instances) {
    if (instance.scope.signal.aborted || (hostId !== undefined && instance.hostId !== hostId) || (owner !== undefined && instance.installation.owner !== owner)) continue;
    if (kind !== "settings" && instance.mode !== "active") continue;
    for (const contribution of instance.contributions[kind]) {
      result.push({ key: pluginExtensionKey(instance.key, kind, contribution.id), instance, contribution });
    }
  }
  return result.sort((a, b) => {
    const left = "order" in a.contribution ? a.contribution.order as number | undefined : undefined;
    const right = "order" in b.contribution ? b.contribution.order as number | undefined : undefined;
    return (left ?? 0) - (right ?? 0) || a.key.localeCompare(b.key);
  });
}

