import { listWorkspaceArchivePendingIds } from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  normalizeProjectLayoutZones,
  normalizeLayout,
  type SplitNode,
  type WorkspaceLayout,
  removeTabFromTree,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
} from "@/workspace-tabs/identity";
import { buildProjectLayoutKey, type WorkspaceTab } from "@/workspace-tabs/model";
import { isWorkspaceSidePanelToolTarget } from "@/workspace-tabs/side-panel-target";

export function resolveProjectLayoutKeyFromWorkspaces(input: {
  serverId: string;
  workspaceId: string;
  workspaces: ReadonlyMap<string, Pick<WorkspaceDescriptor, "id" | "projectId">> | undefined;
}): string | null {
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId || !input.workspaces) return null;
  const workspace = input.workspaces.get(workspaceId);
  if (workspace && normalizeWorkspaceOpaqueId(workspace.id) === workspaceId) {
    return buildProjectLayoutKey({ serverId: input.serverId, projectId: workspace.projectId });
  }
  for (const item of input.workspaces.values()) {
    if (normalizeWorkspaceOpaqueId(item.id) === workspaceId) {
      return buildProjectLayoutKey({ serverId: input.serverId, projectId: item.projectId });
    }
  }
  return null;
}

export function resolveProjectLayoutKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  return resolveProjectLayoutKeyFromWorkspaces({
    ...input,
    workspaces: useSessionStore.getState().sessions[input.serverId]?.workspaces,
  });
}

/** Facts from the current catalogs; a missing ID proves deletion only when its catalog is complete. */
export interface ProjectLayoutOwnershipSnapshot {
  agentWorkspaceIds?: ReadonlyMap<string, string>;
  terminalWorkspaceIds?: ReadonlyMap<string, string>;
  knownAgentIds?: ReadonlySet<string>;
  knownTerminalIds?: ReadonlySet<string>;
  agentsHydrated?: boolean;
  terminalsHydrated?: boolean;
}

export interface PendingProjectLayoutTab {
  legacyWorkspaceKey: string;
  tab: WorkspaceTab;
  reason: "workspace-unknown" | "owner-unknown";
}

interface MigrationInput extends ProjectLayoutOwnershipSnapshot {
  serverId: string;
  layouts: Record<string, WorkspaceLayout>;
  workspaces: ReadonlyMap<
    string,
    Pick<WorkspaceDescriptor, "id" | "projectId"> &
      Partial<Pick<WorkspaceDescriptor, "workspaceDirectory" | "projectRootPath">>
  >;
  sidePanelPaneIds?: Record<string, string | null>;
}

type Ownership =
  | { kind: "owned"; workspaceId: string }
  | { kind: "pending"; reason: PendingProjectLayoutTab["reason"] }
  | { kind: "dead" };

const owned = (workspaceId: string): Ownership => ({ kind: "owned", workspaceId });
const pending = (reason: PendingProjectLayoutTab["reason"]): Ownership => ({
  kind: "pending",
  reason,
});

function findAbsoluteFileWorkspace(
  path: string,
  workspaces: MigrationInput["workspaces"],
  contextualWorkspaceId: string | null,
): Ownership | null {
  const normalizedPath = path.replace(/\\/g, "/");
  let bestLength = 0;
  const matches = new Set<string>();
  for (const workspace of workspaces.values()) {
    for (const root of [workspace.workspaceDirectory, workspace.projectRootPath]) {
      if (!root) continue;
      const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
      if (
        !normalizedRoot ||
        !(normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))
      )
        continue;
      if (normalizedRoot.length > bestLength) {
        bestLength = normalizedRoot.length;
        matches.clear();
      }
      if (normalizedRoot.length === bestLength) matches.add(workspace.id);
    }
  }
  if (!matches.size) return null;
  if (matches.size === 1) return owned(matches.values().next().value!);
  return contextualWorkspaceId && matches.has(contextualWorkspaceId)
    ? owned(contextualWorkspaceId)
    : pending("owner-unknown");
}

function selectTabs(
  layout: WorkspaceLayout,
  tabs: ReadonlyMap<string, WorkspaceTab>,
  preserveExternalParents = false,
): WorkspaceLayout {
  function selectNode(node: SplitNode): SplitNode {
    if (node.kind === "group") {
      return {
        kind: "group",
        group: { ...node.group, children: node.group.children.map(selectNode) },
      };
    }
    const retained = node.pane.tabIds.flatMap((id) => {
      const tab = tabs.get(id);
      return tab ? [tab] : [];
    });
    const pane = {
      ...node.pane,
      tabs: retained,
      tabIds: retained.map((tab) => tab.tabId),
      focusedTabId:
        (node.pane.focusedTabId ? tabs.get(node.pane.focusedTabId)?.tabId : null) ??
        retained[0]?.tabId ??
        null,
    };
    return { kind: "pane", pane };
  }
  const parents = Object.fromEntries(
    Object.entries(layout.parentTabIdByTabId ?? {}).flatMap(([child, parent]) => {
      const childTab = tabs.get(child);
      const parentTab = tabs.get(parent);
      return childTab && (parentTab || preserveExternalParents)
        ? [[childTab.tabId, parentTab?.tabId ?? parent]]
        : [];
    }),
  );
  const selected = normalizeLayout({
    ...layout,
    root: selectNode(layout.root),
    parentTabIdByTabId: parents,
  });
  return preserveExternalParents && Object.keys(parents).length
    ? { ...selected, parentTabIdByTabId: parents }
    : selected;
}

function mergeProjectLayout(existing: WorkspaceLayout, incoming: WorkspaceLayout): WorkspaceLayout {
  const existingById = new Map(collectAllTabs(existing.root).map((tab) => [tab.tabId, tab]));
  const newTabs = collectAllTabs(incoming.root).filter((tab) => !existingById.has(tab.tabId));
  if (newTabs.length === 0) return existing;
  const paneId = findPaneById(existing.root, existing.focusedPaneId)?.id;
  if (!paneId) return existing;
  function append(node: SplitNode): SplitNode {
    if (node.kind === "group") {
      return { kind: "group", group: { ...node.group, children: node.group.children.map(append) } };
    }
    if (node.pane.id !== paneId) return node;
    const pane = {
      ...node.pane,
      tabs: [
        ...node.pane.tabIds.flatMap((id) => {
          const tab = existingById.get(id);
          return tab ? [tab] : [];
        }),
        ...newTabs,
      ],
      tabIds: [...node.pane.tabIds, ...newTabs.map((tab) => tab.tabId)],
      focusedTabId: node.pane.focusedTabId ?? newTabs[0]?.tabId ?? null,
    };
    return { kind: "pane", pane };
  }
  return normalizeLayout({
    ...existing,
    root: append(existing.root),
    parentTabIdByTabId: { ...existing.parentTabIdByTabId, ...incoming.parentTabIdByTabId },
  });
}

function correctKnownProjectResourceOwners(input: MigrationInput): {
  layouts: Record<string, WorkspaceLayout>;
  sidePanelPaneIds: Record<string, string | null>;
} {
  let result = input.layouts;
  let sidePanelPaneIds = input.sidePanelPaneIds ?? {};
  const prefix = `${input.serverId}:project:`;
  const incoming: Array<{ projectKey: string; sourceKey: string; layout: WorkspaceLayout }> = [];
  const occupied = new Map<string, Set<string>>();
  for (const [key, layout] of Object.entries(input.layouts)) {
    if (key.startsWith(prefix)) {
      occupied.set(key, new Set(collectAllTabs(layout.root).map((tab) => tab.tabId)));
    }
  }
  for (const [sourceKey, original] of Object.entries(input.layouts)) {
    if (!sourceKey.startsWith(prefix)) continue;
    const allTabs = collectAllTabs(original.root);
    const retained = new Map<string, WorkspaceTab>();
    const moving = new Map<string, Map<string, WorkspaceTab>>();
    let changed = false;
    for (const tab of allTabs) {
      const target = tab.target;
      const agentId =
        target.kind === "agent" || target.kind === "background_process"
          ? target.agentId
          : target.kind === "provider_subagent"
            ? target.parentAgentId
            : target.kind === "plugin" && target.context === "agent"
              ? target.agentId
              : null;
      const actual = agentId
        ? input.agentWorkspaceIds?.get(agentId)
        : target.kind === "terminal"
          ? input.terminalWorkspaceIds?.get(target.terminalId)
          : null;
      if (!actual || actual === target.workspaceId) {
        retained.set(tab.tabId, tab);
        continue;
      }
      const projectKey = resolveProjectLayoutKeyFromWorkspaces({
        serverId: input.serverId,
        workspaceId: actual,
        workspaces: input.workspaces,
      });
      if (!projectKey || (projectKey !== sourceKey && occupied.get(projectKey)?.has(tab.tabId))) {
        retained.set(tab.tabId, tab);
        continue;
      }
      const corrected = { ...tab, target: { ...target, workspaceId: actual } };
      if (projectKey === sourceKey) retained.set(tab.tabId, corrected);
      else {
        const targetTabs = moving.get(projectKey) ?? new Map<string, WorkspaceTab>();
        targetTabs.set(tab.tabId, corrected);
        moving.set(projectKey, targetTabs);
        const used = occupied.get(projectKey) ?? new Set<string>();
        used.add(tab.tabId);
        occupied.set(projectKey, used);
      }
      changed = true;
    }
    if (!changed) continue;
    if (result === input.layouts) result = { ...result };
    result[sourceKey] = selectTabs(original, retained);
    for (const [projectKey, tabs] of moving) {
      incoming.push({ projectKey, sourceKey, layout: selectTabs(original, tabs) });
    }
  }
  for (const { projectKey, sourceKey, layout } of incoming) {
    result[projectKey] = normalizeProjectLayoutZones(
      result[projectKey] ? mergeProjectLayout(result[projectKey], layout) : layout,
      sidePanelPaneIds[projectKey] ?? sidePanelPaneIds[sourceKey],
    );
    if (!sidePanelPaneIds[projectKey] && sidePanelPaneIds[sourceKey]) {
      if (sidePanelPaneIds === input.sidePanelPaneIds) sidePanelPaneIds = { ...sidePanelPaneIds };
      sidePanelPaneIds[projectKey] = sidePanelPaneIds[sourceKey];
    }
  }
  return { layouts: result, sidePanelPaneIds };
}

export function migrateLegacyProjectLayouts(input: MigrationInput): {
  layouts: Record<string, WorkspaceLayout>;
  pending: PendingProjectLayoutTab[];
  migratedLegacyKeys: string[];
  sidePanelPaneIds: Record<string, string | null>;
} {
  const corrected = correctKnownProjectResourceOwners(input);
  const currentLayouts = corrected.layouts;
  const prefix = `${input.serverId}:`;
  const legacyEntries = Object.entries(input.layouts).filter(
    ([key]) => key.startsWith(prefix) && !key.startsWith(`${prefix}project:`),
  );
  if (!legacyEntries.length) {
    return {
      layouts: currentLayouts,
      pending: [],
      migratedLegacyKeys: [],
      sidePanelPaneIds: corrected.sidePanelPaneIds,
    };
  }
  let layouts = currentLayouts;
  const pendingTabs: PendingProjectLayoutTab[] = [];
  const migratedLegacyKeys: string[] = [];
  let sidePanelPaneIds = corrected.sidePanelPaneIds;
  type TabLocation = { tab: WorkspaceTab; layout: WorkspaceLayout; sourceId: string };
  const tabsById = new Map<string, TabLocation>();
  const tabsByLayout = new Map<WorkspaceLayout, Map<string, TabLocation>>();
  const projectTabIds = new Map<string, Set<string>>();
  for (const [key, layout] of Object.entries(currentLayouts)) {
    if (!key.startsWith(`${prefix}project:`)) continue;
    const tabIds = new Set<string>();
    const localTabs = new Map<string, TabLocation>();
    for (const tab of collectAllTabs(layout.root)) {
      const location = { tab, layout, sourceId: "" };
      tabsById.set(tab.tabId, location);
      localTabs.set(tab.tabId, location);
      tabIds.add(tab.tabId);
    }
    projectTabIds.set(key, tabIds);
    tabsByLayout.set(layout, localTabs);
  }
  // Index before partitioning: an opener may be in a different raw layout, or migrate first.
  for (const [key, layout] of legacyEntries) {
    const localTabs = new Map<string, TabLocation>();
    for (const tab of collectAllTabs(layout.root)) {
      const location = { tab, layout, sourceId: key.slice(prefix.length) };
      localTabs.set(tab.tabId, location);
      if (!tabsById.has(tab.tabId)) tabsById.set(tab.tabId, location);
    }
    tabsByLayout.set(layout, localTabs);
  }
  const resolved = new Map<TabLocation, Ownership>();
  const resolving = new Set<TabLocation>();
  const projectFor = (workspaceId: string) =>
    resolveProjectLayoutKeyFromWorkspaces({
      serverId: input.serverId,
      workspaceId,
      workspaces: input.workspaces,
    });
  function focusedContextId(layout: WorkspaceLayout, tabId: string): string | null {
    const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
    const directId = focusedPane?.focusedTabId;
    const direct = directId && directId !== tabId ? tabsByLayout.get(layout)?.get(directId) : null;
    const isCheckoutContext = (tab: WorkspaceTab) =>
      Boolean(tab.target.workspaceId) ||
      tab.target.kind === "agent" ||
      tab.target.kind === "provider_subagent" ||
      tab.target.kind === "background_process" ||
      tab.target.kind === "terminal" ||
      (tab.target.kind === "plugin" && tab.target.context === "agent");
    if (
      direct?.layout === layout &&
      (isCheckoutContext(direct.tab) || direct.tab.target.kind === "draft")
    ) {
      return directId!;
    }
    for (const pane of collectAllPanes(layout.root)) {
      if (pane.id === focusedPane?.id || !pane.focusedTabId || pane.focusedTabId === tabId)
        continue;
      const candidate = tabsByLayout.get(layout)?.get(pane.focusedTabId);
      if (candidate?.layout === layout && isCheckoutContext(candidate.tab))
        return pane.focusedTabId;
    }
    return direct?.layout === layout ? directId! : null;
  }

  function resolve(id: string, context?: WorkspaceLayout): Ownership {
    const entry = (context ? tabsByLayout.get(context)?.get(id) : null) ?? tabsById.get(id);
    if (!entry || resolving.has(entry)) return pending("owner-unknown");
    const cached = resolved.get(entry);
    if (cached) return cached;
    resolving.add(entry);
    const { tab, layout, sourceId } = entry;
    const { target } = tab;
    const bound = normalizeWorkspaceOpaqueId(target.workspaceId);
    const agentId =
      target.kind === "agent" || target.kind === "background_process"
        ? target.agentId
        : target.kind === "provider_subagent"
          ? target.parentAgentId
          : target.kind === "plugin" && target.context === "agent"
            ? target.agentId
            : null;
    let answer: Ownership | null = null;
    if (agentId) {
      if (input.agentsHydrated && input.knownAgentIds && !input.knownAgentIds.has(agentId)) {
        answer = { kind: "dead" };
      } else {
        const actual = input.agentWorkspaceIds?.get(agentId);
        answer = actual ? owned(actual) : bound ? owned(bound) : pending("owner-unknown");
      }
    } else if (target.kind === "terminal") {
      if (
        input.terminalsHydrated &&
        input.knownTerminalIds &&
        !input.knownTerminalIds.has(target.terminalId)
      ) {
        answer = { kind: "dead" };
      } else {
        const actual = input.terminalWorkspaceIds?.get(target.terminalId);
        answer = actual ? owned(actual) : bound ? owned(bound) : pending("owner-unknown");
      }
    } else if (bound) {
      // File/tool/draft contexts already saved with a checkout are immutable.
      answer = owned(bound);
    } else if (target.kind === "file") {
      const isAbsolute = /^(?:\/|[A-Za-z]:[\\/])/.test(target.path);
      if (!isAbsolute) {
        const parentId = layout.parentTabIdByTabId?.[id];
        if (parentId && tabsById.has(parentId)) {
          const parent = resolve(parentId, layout);
          if (parent.kind === "owned") answer = parent;
          else if (parent.kind === "pending") answer = parent;
        }
      }
      // The recorded pane focus (or focused main conversation behind a tool) is the opening context.
      const focusedTabId = focusedContextId(layout, id);
      const focusedOwner = focusedTabId ? resolve(focusedTabId, layout) : null;
      const contextId =
        focusedOwner?.kind === "owned"
          ? focusedOwner.workspaceId
          : focusedOwner?.kind === "pending"
            ? null
            : sourceId;
      if (isAbsolute) {
        answer =
          findAbsoluteFileWorkspace(target.path, input.workspaces, contextId) ??
          (focusedOwner?.kind === "pending" ? focusedOwner : owned(sourceId));
      } else {
        answer ??=
          focusedOwner?.kind === "owned" || focusedOwner?.kind === "pending"
            ? focusedOwner
            : owned(sourceId);
      }
    } else if (
      target.kind === "files" ||
      target.kind === "working_diff" ||
      target.kind === "pull_request" ||
      target.kind === "commit_diff" ||
      (target.kind === "plugin" && target.context === "workspace")
    ) {
      const focusedTabId = focusedContextId(layout, id);
      const focusedOwner = focusedTabId ? resolve(focusedTabId, layout) : null;
      answer =
        focusedOwner?.kind === "owned" || focusedOwner?.kind === "pending"
          ? focusedOwner
          : owned(sourceId);
    } else {
      answer = owned(sourceId);
    }
    if (answer.kind === "owned" && !projectFor(answer.workspaceId)) {
      answer = pending("workspace-unknown");
    }
    resolving.delete(entry);
    resolved.set(entry, answer);
    return answer;
  }

  for (const [legacyWorkspaceKey, layout] of legacyEntries) {
    const byProject = new Map<string, Map<string, WorkspaceTab>>();
    const retained = new Map<string, WorkspaceTab>();
    const tabs = collectAllTabs(layout.root);
    for (const tab of tabs) {
      const owner = resolve(tab.tabId, layout);
      if (owner.kind === "dead") continue;
      if (owner.kind === "pending") {
        pendingTabs.push({ legacyWorkspaceKey, tab, reason: owner.reason });
        retained.set(tab.tabId, tab);
        continue;
      }
      const projectKey = projectFor(owner.workspaceId);
      const target = normalizeWorkspaceTabTarget({ ...tab.target, workspaceId: owner.workspaceId });
      if (!projectKey || !target) {
        pendingTabs.push({ legacyWorkspaceKey, tab, reason: "owner-unknown" });
        retained.set(tab.tabId, tab);
        continue;
      }
      let nextTabId = tab.tabId;
      const occupied = projectTabIds.get(projectKey);
      if (occupied?.has(nextTabId)) {
        const identity = buildDeterministicWorkspaceTabId(target);
        const existing = collectAllTabs(layouts[projectKey].root).find(
          (item) => item.tabId === nextTabId,
        );
        // Same resource follows normal reveal/deduplication rules; a different
        // checkout sharing an old ID gets the current workspace-scoped identity.
        if (existing && buildDeterministicWorkspaceTabId(existing.target) === identity) continue;
        nextTabId = identity;
        if (occupied.has(nextTabId)) continue;
      }
      const projectTabs = byProject.get(projectKey) ?? new Map<string, WorkspaceTab>();
      projectTabs.set(tab.tabId, { ...tab, tabId: nextTabId, target });
      byProject.set(projectKey, projectTabs);
    }
    for (const [projectKey, projectTabs] of byProject) {
      const projectIds = projectTabIds.get(projectKey) ?? new Set<string>();
      for (const migrated of projectTabs.values()) projectIds.add(migrated.tabId);
      projectTabIds.set(projectKey, projectIds);
      if (layouts === currentLayouts) layouts = { ...layouts };
      const partition = selectTabs(layout, projectTabs);
      layouts[projectKey] = normalizeProjectLayoutZones(
        layouts[projectKey] ? mergeProjectLayout(layouts[projectKey], partition) : partition,
        sidePanelPaneIds[projectKey] ?? sidePanelPaneIds[legacyWorkspaceKey],
      );
      if (!sidePanelPaneIds[projectKey] && sidePanelPaneIds[legacyWorkspaceKey]) {
        if (sidePanelPaneIds === input.sidePanelPaneIds) sidePanelPaneIds = { ...sidePanelPaneIds };
        sidePanelPaneIds[projectKey] = sidePanelPaneIds[legacyWorkspaceKey];
      }
    }
    if (retained.size === 0) {
      if (layouts === currentLayouts) layouts = { ...layouts };
      delete layouts[legacyWorkspaceKey];
      migratedLegacyKeys.push(legacyWorkspaceKey);
    } else if (retained.size !== tabs.length) {
      if (layouts === currentLayouts) layouts = { ...layouts };
      layouts[legacyWorkspaceKey] = selectTabs(layout, retained, true);
    }
  }
  return { layouts, pending: pendingTabs, migratedLegacyKeys, sidePanelPaneIds };
}

export function ensureProjectLayoutsMigrated(
  serverId: string,
  ownership: ProjectLayoutOwnershipSnapshot = {},
): PendingProjectLayoutTab[] {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session?.hasHydratedWorkspaces || !useWorkspaceLayoutStore.persist.hasHydrated()) return [];
  const layoutStore = useWorkspaceLayoutStore.getState();
  const agentWorkspaceIds = new Map(ownership.agentWorkspaceIds);
  for (const agent of session.agents.values()) {
    if (agent.workspaceId) agentWorkspaceIds.set(agent.id, agent.workspaceId);
  }
  for (const agent of session.agentDetails.values()) {
    if (agent.workspaceId) agentWorkspaceIds.set(agent.id, agent.workspaceId);
  }
  const result = migrateLegacyProjectLayouts({
    serverId,
    layouts: layoutStore.layoutByWorkspace,
    workspaces: session.workspaces,
    sidePanelPaneIds: layoutStore.sidePanelPaneIdByWorkspace,
    ...ownership,
    agentWorkspaceIds,
  });
  const preservedWorkspaceIds = new Set(listWorkspaceArchivePendingIds(serverId));
  const prunedLayouts = prunePlaceholderTabsOwnedByMissingWorkspaces({
    serverId,
    layouts: result.layouts,
    workspaces: session.workspaces,
    // Optimistic archives hide the record before the request completes and may
    // restore it on failure; their drafts must survive that window.
    preservedWorkspaceIds,
  });
  const recoveredLayouts = recoverOrphanedProjectToolBindings({
    serverId,
    layouts: prunedLayouts,
    workspaces: session.workspaces,
    preservedWorkspaceIds,
  });
  if (recoveredLayouts !== layoutStore.layoutByWorkspace) {
    const splitSizesByWorkspace = { ...layoutStore.splitSizesByWorkspace };
    const sidePanelPaneIdByWorkspace = { ...result.sidePanelPaneIds };
    for (const rawKey of result.migratedLegacyKeys) {
      const sourceWorkspaceId = rawKey.slice(serverId.length + 1);
      const projectKey = resolveProjectLayoutKeyFromWorkspaces({
        serverId,
        workspaceId: sourceWorkspaceId,
        workspaces: session.workspaces,
      });
      if (projectKey) {
        const savedSizes = splitSizesByWorkspace[rawKey];
        if (savedSizes !== undefined) splitSizesByWorkspace[projectKey] ??= savedSizes;
        const savedPaneId = sidePanelPaneIdByWorkspace[rawKey];
        if (savedPaneId !== undefined) sidePanelPaneIdByWorkspace[projectKey] ??= savedPaneId;
      }
      delete splitSizesByWorkspace[rawKey];
      delete sidePanelPaneIdByWorkspace[rawKey];
    }
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: recoveredLayouts,
      splitSizesByWorkspace,
      sidePanelPaneIdByWorkspace,
    });
  }
  return result.pending;
}

/**
 * Files and the Changes overview describe a checkout rather than a specific resource. Once
 * hydration proves their saved checkout is gone, keep the panel in its project:
 * prefer its focused conversation, then the root checkout, then a sibling.
 * Resource-specific files, focused diffs, commits and runtime tabs retain their explicit owner.
 * This runs only from the hydrated layout finalization above, never at render time.
 */
function recoverOrphanedProjectToolBindings(input: {
  serverId: string;
  layouts: Record<string, WorkspaceLayout>;
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  preservedWorkspaceIds: ReadonlySet<string>;
}): Record<string, WorkspaceLayout> {
  const byId = new Map(
    [...input.workspaces.values()].map((workspace) => [workspace.id, workspace]),
  );
  let next = input.layouts;
  for (const [key, layout] of Object.entries(input.layouts)) {
    if (!key.startsWith(`${input.serverId}:project:`)) continue;
    const tabs = collectAllTabs(layout.root);
    const orphaned = tabs.filter(
      ({ target }) =>
        (target.kind === "files" || target.kind === "working_diff") &&
        isWorkspaceSidePanelToolTarget(target) &&
        target.workspaceId !== undefined &&
        !byId.has(target.workspaceId) &&
        !input.preservedWorkspaceIds.has(target.workspaceId),
    );
    if (!orphaned.length) continue;
    const candidates = [...byId.values()].filter(
      (workspace) =>
        !workspace.archivingAt &&
        Boolean(workspace.workspaceDirectory) &&
        buildProjectLayoutKey({ serverId: input.serverId, projectId: workspace.projectId }) === key,
    );
    if (!candidates.length) continue;
    const candidateIds = new Set(candidates.map((workspace) => workspace.id));
    const panes = collectAllPanes(layout.root);
    const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
    const focusedTabs = [focusedPane, ...panes.filter((pane) => pane !== focusedPane)].flatMap(
      (pane) => {
        const focused = tabs.find((tab) => tab.tabId === pane?.focusedTabId);
        return focused?.target.workspaceId && candidateIds.has(focused.target.workspaceId)
          ? [focused]
          : [];
      },
    );
    const workspaceId =
      focusedTabs[0]?.target.workspaceId ??
      candidates.find((workspace) => workspace.workspaceDirectory === workspace.projectRootPath)
        ?.id ??
      candidates[0]!.id;
    const repaired = new Map(tabs.map((tab) => [tab.tabId, tab]));
    for (const tab of orphaned) {
      repaired.set(tab.tabId, { ...tab, target: { ...tab.target, workspaceId } });
    }
    if (next === input.layouts) next = { ...input.layouts };
    next[key] = selectTabs(layout, repaired);
  }
  return next;
}

/**
 * Draft and overview tabs whose owning workspace record is gone (archived or removed)
 * are dead entries: nothing can submit or open them, yet they survive restarts because
 * per-workspace reconciliation never prunes another workspace's tabs. Drop them
 * once, when the project layout is finalized against the hydrated workspace list.
 */
export function prunePlaceholderTabsOwnedByMissingWorkspaces(input: {
  serverId: string;
  layouts: Record<string, WorkspaceLayout>;
  workspaces: ReadonlyMap<string, Pick<WorkspaceDescriptor, "id" | "projectId">>;
  preservedWorkspaceIds?: ReadonlySet<string>;
}): Record<string, WorkspaceLayout> {
  const ownsWorkspace = (workspaceId: string): boolean =>
    input.workspaces.has(workspaceId) ||
    [...input.workspaces.values()].some((workspace) => workspace.id === workspaceId) ||
    (input.preservedWorkspaceIds?.has(workspaceId) ?? false);

  let next = input.layouts;
  for (const [key, layout] of Object.entries(input.layouts)) {
    if (!key.startsWith(`${input.serverId}:project:`)) continue;
    const deadTabIds = collectAllTabs(layout.root)
      .filter(
        (tab) =>
          (tab.target.kind === "draft" || tab.target.kind === "workspace_overview") &&
          tab.target.workspaceId !== undefined &&
          !ownsWorkspace(tab.target.workspaceId),
      )
      .map((tab) => tab.tabId);
    if (deadTabIds.length === 0) continue;
    if (next === input.layouts) next = { ...input.layouts };
    let root = layout.root;
    for (const tabId of deadTabIds) {
      root = removeTabFromTree(root, tabId) ?? root;
    }
    next[key] = normalizeLayout({ ...layout, root });
  }
  return next;
}
