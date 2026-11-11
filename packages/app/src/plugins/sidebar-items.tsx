import { useMemo, useSyncExternalStore } from "react";
import { router, usePathname } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { usePluginContributions } from "./hooks";
import { pluginSelectionMemory } from "./selection-memory";
import { buildPluginSurfaceRoute } from "./routes";
import { resolvePluginIcon } from "./icons";
import { pluginClientRegistry } from "./registry";

export function PluginSidebarItems({ onNavigate }: { onNavigate?: () => void }) {
  const contributions = usePluginContributions("sidebar");
  const memory = useSyncExternalStore(pluginSelectionMemory.subscribe, pluginSelectionMemory.getSnapshot, pluginSelectionMemory.getSnapshot);
  const pathname = usePathname();
  const items = useMemo(() => {
    if (!memory.ready) return [];
    const selected = new Map<string, typeof contributions[number]>();
    for (const entry of contributions) {
      const id = `${entry.instance.installation.id}/sidebar/${entry.contribution.id}`;
      const preferred = memory.hosts[`sidebar:${id}`];
      if (preferred ? entry.instance.hostId === preferred.hostId && entry.instance.installation.owner === preferred.owner : !selected.has(id)) selected.set(id, entry);
    }
    return [...selected.values()];
  }, [contributions, memory]);
  return items.map(({ key, instance, contribution }) => {
    const id = `${instance.installation.id}/sidebar/${contribution.id}`;
    const route = buildPluginSurfaceRoute(instance.hostId, instance.installation.id, { kind: "sidebar", id: contribution.id }, instance.installation.owner);
    return <SidebarHeaderRow key={key} icon={resolvePluginIcon(contribution.icon)} label={contribution.title} variant="compact" testID={`plugin-sidebar-${instance.installation.id}-${contribution.id}`} isActive={pathname === route} onPress={() => {
      instance.scope.assertCurrent();
      void pluginSelectionMemory.select("sidebar", id, instance.hostId, instance.installation.owner).then(() => {
        instance.scope.assertCurrent();
        router.push(route);
        onNavigate?.();
      }).catch((error: unknown) => pluginClientRegistry.fail(instance.key, error, instance.scope));
    }} />;
  });
}
