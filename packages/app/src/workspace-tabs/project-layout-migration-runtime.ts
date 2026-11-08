import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "./model";
import { ensureProjectLayoutsMigrated, type ProjectLayoutOwnershipSnapshot } from "./project-scope";

interface MigrationClient {
  listTerminals: DaemonClient["listTerminals"];
  fetchAgentHistory: DaemonClient["fetchAgentHistory"];
}

function referencedAgentId(tab: WorkspaceTab): string | undefined {
  const target = tab.target;
  return target.kind === "agent" ||
    target.kind === "background_process" ||
    target.kind === "prompt_analysis" ||
    (target.kind === "plugin" && target.context === "agent")
    ? target.agentId
    : target.kind === "provider_subagent"
      ? target.parentAgentId
      : undefined;
}

function matchingCheckout(cwd: string, serverId: string): string | undefined {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
  if (!workspaces) return undefined;
  let match: string | undefined;
  for (const workspace of workspaces.values()) {
    if (workspace.workspaceDirectory.replace(/\\/g, "/").replace(/\/+$/, "") !== normalized) {
      continue;
    }
    if (match && match !== workspace.id) return undefined;
    match = workspace.id;
  }
  return match;
}

/** Owns migration metadata only for this connection; never adds history to the active directory. */
export function mountProjectLayoutMigrationRuntime(input: {
  serverId: string;
  client: MigrationClient;
}): () => void {
  const { serverId, client } = input;
  const agentWorkspaceIds = new Map<string, string>();
  const terminalWorkspaceIds = new Map<string, string>();
  const knownAgentIds = new Set<string>();
  const knownTerminalIds = new Set<string>();
  let agentsHydrated = false;
  let terminalsHydrated = false;
  let agentRequest = false;
  let terminalRequest = false;
  let active = true;
  let running = false;
  let rerun = false;

  const ownership = (): ProjectLayoutOwnershipSnapshot => ({
    agentWorkspaceIds,
    terminalWorkspaceIds,
    ...(agentsHydrated ? { knownAgentIds, agentsHydrated: true } : {}),
    ...(terminalsHydrated ? { knownTerminalIds, terminalsHydrated: true } : {}),
  });

  const fetchTerminals = async (needed: ReadonlySet<string>) => {
    terminalRequest = true;
    let succeeded = false;
    try {
      const catalog = await client.listTerminals();
      if (!active) return;
      knownTerminalIds.clear();
      terminalWorkspaceIds.clear();
      for (const terminal of catalog.terminals) {
        knownTerminalIds.add(terminal.id);
        const owner =
          terminal.workspaceId ??
          (catalog.cwd ? matchingCheckout(catalog.cwd, serverId) : undefined);
        if (owner) terminalWorkspaceIds.set(terminal.id, owner);
      }
      if (knownTerminalIds.size > terminalWorkspaceIds.size) {
        // The unscoped protocol list does not include per-terminal cwd. Only scoped
        // lists with an unambiguous checkout directory can supply an omitted owner.
        const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
        if (workspaces) {
          for (const workspace of workspaces.values()) {
            if (matchingCheckout(workspace.workspaceDirectory, serverId) !== workspace.id) continue;
            const scoped = await client.listTerminals(workspace.workspaceDirectory, undefined, {
              workspaceId: workspace.id,
            });
            if (!active) return;
            for (const terminal of scoped.terminals) {
              if (!knownTerminalIds.has(terminal.id) || terminalWorkspaceIds.has(terminal.id))
                continue;
              const owner =
                terminal.workspaceId ??
                matchingCheckout(scoped.cwd ?? workspace.workspaceDirectory, serverId);
              if (owner) terminalWorkspaceIds.set(terminal.id, owner);
            }
          }
        }
      }
      // A terminal opened after the request began needs a fresh authoritative catalog.
      const current = ensureProjectLayoutsMigrated(serverId, ownership());
      terminalsHydrated = !current.some(
        ({ tab }) =>
          tab.target.kind === "terminal" &&
          !needed.has(tab.target.terminalId) &&
          !knownTerminalIds.has(tab.target.terminalId),
      );
      succeeded = true;
    } catch {
      // An incomplete catalog must never be interpreted as evidence of deletion.
    } finally {
      terminalRequest = false;
      if (succeeded && active) run();
    }
  };

  const fetchAgents = async (needed: ReadonlySet<string>) => {
    agentRequest = true;
    let succeeded = false;
    const initialAgents = new Set(useSessionStore.getState().sessions[serverId]?.agents.keys());
    try {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      let pageChainIncomplete = false;
      for (;;) {
        const page = await client.fetchAgentHistory({
          filter: { includeArchived: true },
          page: cursor ? { limit: 200, cursor } : { limit: 200 },
        });
        if (!active) return;
        for (const entry of page.entries) {
          knownAgentIds.add(entry.agent.id);
          const owner =
            entry.agent.workspaceId ??
            (entry.agent.cwd ? matchingCheckout(entry.agent.cwd, serverId) : undefined);
          if (owner) agentWorkspaceIds.set(entry.agent.id, owner);
        }
        const next = page.pageInfo.nextCursor;
        if (!page.pageInfo.hasMore || !next || seenCursors.has(next)) {
          // A broken/incomplete cursor chain cannot establish that a missing agent was deleted.
          agentsHydrated = !page.pageInfo.hasMore;
          pageChainIncomplete = page.pageInfo.hasMore;
          break;
        }
        if ([...needed].every((id) => agentWorkspaceIds.has(id))) break;
        seenCursors.add(next);
        cursor = next;
      }
      if (agentsHydrated) {
        const session = useSessionStore.getState().sessions[serverId];
        for (const id of session?.agents.keys() ?? []) {
          if (!initialAgents.has(id)) knownAgentIds.add(id);
        }
        // Do not use a pre-creation catalog to declare a newly opened tab dead.
        const current = ensureProjectLayoutsMigrated(serverId, {
          agentWorkspaceIds,
          terminalWorkspaceIds,
        });
        if (
          current.some(({ tab }) => {
            const id = referencedAgentId(tab);
            return id && !needed.has(id) && !knownAgentIds.has(id);
          })
        )
          agentsHydrated = false;
      }
      succeeded = !pageChainIncomplete;
    } catch {
      // Retry on a future directory, layout, or connection transition.
    } finally {
      agentRequest = false;
      if (succeeded && active) run();
    }
  };

  function run(): void {
    if (!active || !useWorkspaceLayoutStore.persist.hasHydrated()) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        const session = useSessionStore.getState().sessions[serverId];
        if (!session?.hasHydratedWorkspaces || session.client !== client) continue;
        const pending = ensureProjectLayoutsMigrated(serverId, ownership());
        if (!terminalsHydrated && !terminalRequest) {
          let needed: Set<string> | undefined;
          for (const { tab } of pending) {
            if (tab.target.kind !== "terminal") continue;
            (needed ??= new Set()).add(tab.target.terminalId);
          }
          if (needed) void fetchTerminals(needed);
        }
        if (!session.hasHydratedAgents || agentsHydrated || agentRequest) continue;
        let missingAgents: Set<string> | undefined;
        for (const { tab } of pending) {
          const id = referencedAgentId(tab);
          if (
            id &&
            !session.agents.get(id)?.workspaceId &&
            !session.agentDetails.get(id)?.workspaceId &&
            !agentWorkspaceIds.has(id)
          ) {
            (missingAgents ??= new Set()).add(id);
          }
        }
        if (missingAgents) void fetchAgents(missingAgents);
      } while (rerun && active);
    } finally {
      running = false;
    }
  }

  function invalidateCatalogForNewLegacyReferences(
    nextLayouts: Record<string, WorkspaceLayout>,
    previousLayouts: Record<string, WorkspaceLayout>,
  ): void {
    const prefix = `${serverId}:`;
    for (const [key, next] of Object.entries(nextLayouts)) {
      if (
        !key.startsWith(prefix) ||
        key.startsWith(`${prefix}project:`) ||
        next === previousLayouts[key]
      )
        continue;
      const prior = previousLayouts[key];
      const priorTabs = prior ? collectAllTabs(prior.root) : [];
      for (const tab of collectAllTabs(next.root)) {
        const agentId = referencedAgentId(tab);
        const terminalId = tab.target.kind === "terminal" ? tab.target.terminalId : undefined;
        if (
          agentId &&
          agentsHydrated &&
          !knownAgentIds.has(agentId) &&
          !priorTabs.some((previous) => referencedAgentId(previous) === agentId)
        ) {
          agentsHydrated = false;
        }
        if (
          terminalId &&
          terminalsHydrated &&
          !knownTerminalIds.has(terminalId) &&
          !priorTabs.some(
            (previous) =>
              previous.target.kind === "terminal" && previous.target.terminalId === terminalId,
          )
        ) {
          terminalsHydrated = false;
        }
      }
    }
  }

  const unsubscribeSession = useSessionStore.subscribe((state, previous) => {
    const next = state.sessions[serverId];
    const old = previous.sessions[serverId];
    if (
      next === old ||
      (next?.workspaces === old?.workspaces &&
        next?.agents === old?.agents &&
        next?.agentDetails === old?.agentDetails &&
        next?.hasHydratedWorkspaces === old?.hasHydratedWorkspaces &&
        next?.hasHydratedAgents === old?.hasHydratedAgents &&
        next?.focusedAgentId === old?.focusedAgentId &&
        next?.focusedTerminalId === old?.focusedTerminalId)
    )
      return;
    if (agentsHydrated && next?.agents !== old?.agents) {
      for (const id of next?.agents.keys() ?? []) {
        if (!old?.agents.has(id)) knownAgentIds.add(id);
      }
    }
    if (agentsHydrated && next?.agentDetails !== old?.agentDetails) {
      for (const id of next?.agentDetails.keys() ?? []) {
        if (!old?.agentDetails.has(id)) knownAgentIds.add(id);
      }
    }
    run();
  });
  const unsubscribeLayout = useWorkspaceLayoutStore.subscribe((state, previous) => {
    if (state.layoutByWorkspace === previous.layoutByWorkspace) return;
    invalidateCatalogForNewLegacyReferences(state.layoutByWorkspace, previous.layoutByWorkspace);
    run();
  });
  const unsubscribeHydration = useWorkspaceLayoutStore.persist.onFinishHydration(run);
  run();
  return () => {
    active = false;
    unsubscribeSession();
    unsubscribeLayout();
    unsubscribeHydration();
  };
}
