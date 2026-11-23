import type { PluginWorkspacePanelContribution } from "@omp-desktop/plugin";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import type { RegisteredPluginContribution } from "./registry";

export interface ResolvedPluginFilePanel extends RegisteredPluginContribution<"panel"> {
  contribution: Extract<PluginWorkspacePanelContribution, { context: "workspace" }>;
  filePath: string;
}

/** Select from active contributions in registry order, preferring the most specific suffix. */
export function resolvePluginFilePanel(
  panels: readonly RegisteredPluginContribution<"panel">[],
  hostId: string,
  location: { path: string; workspaceRoot: string },
): ResolvedPluginFilePanel | null {
  if (!panels.length) return null;
  const filePath = resolveWorkspaceFilePaths(location)?.relativePath;
  if (!filePath) return null;

  const normalizedPath = filePath.toLowerCase();
  let match: ResolvedPluginFilePanel | null = null;
  let longest = 0;
  for (const entry of panels) {
    const { instance, contribution } = entry;
    if (instance.installation.owner !== "desktop" && instance.hostId !== hostId) continue;
    if (contribution.context !== "workspace" || !contribution.fileSuffix) continue;
    const suffix = contribution.fileSuffix.toLowerCase();
    if (suffix.length <= longest || !normalizedPath.endsWith(suffix)) continue;
    match = { ...entry, contribution, filePath };
    longest = suffix.length;
  }
  return match;
}
