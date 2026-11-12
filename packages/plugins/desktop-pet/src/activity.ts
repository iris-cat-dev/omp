import type {
  DesktopPetActivity,
  DesktopPetActivityResult,
  DesktopPetLabels,
  DesktopPetTask,
  DesktopPetRevision,
  PetTaskStatus,
} from "./types.js";

const PRIORITY: Record<PetTaskStatus, number> = {
  needs_input: 0,
  blocked: 1,
  ready: 2,
  running: 3,
};
export const DEFAULT_PET_ACTIVITY: DesktopPetActivity = {
  connected: false,
  serverIds: [],
  revisions: {},
  tasks: [],
  fontFamily: "Segoe UI",
  labels: {
    idle: "All quiet",
    offline: "Offline",
    running: "Working",
    needs_input: "Needs your input",
    ready: "Ready to review",
    blocked: "Blocked",
    openApp: "Open OMP",
    openTask: "Open task",
    hide: "Hide companion",
    resetPosition: "Reset position",
    taskCount: "{{count}} tasks",
  },
};

function parsePetRevision(value: unknown): DesktopPetRevision | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid pet directory revision");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.generation !== "string" ||
    !raw.generation ||
    raw.generation.length > 512 ||
    typeof raw.seq !== "number" ||
    !Number.isSafeInteger(raw.seq) ||
    raw.seq < 0 ||
    (raw.previousGeneration !== undefined &&
      (typeof raw.previousGeneration !== "string" ||
        !raw.previousGeneration ||
        raw.previousGeneration.length > 512 ||
        raw.previousGeneration === raw.generation))
  ) {
    throw new Error("Invalid pet directory revision");
  }
  return {
    generation: raw.generation,
    seq: raw.seq,
    ...(raw.previousGeneration !== undefined ? { previousGeneration: raw.previousGeneration } : {}),
  };
}

function parsePetRevisions(
  values: Record<string, unknown>,
  serverIds: ReadonlySet<string>,
  connected: boolean,
): DesktopPetActivity["revisions"] {
  const revisions: DesktopPetActivity["revisions"] = {};
  for (const [serverId, raw] of Object.entries(values)) {
    if (!serverIds.has(serverId)) {
      if (!connected) continue;
      throw new Error("Invalid pet directory host");
    }
    revisions[serverId] = parsePetRevision(raw);
  }
  return revisions;
}

export function parsePetActivity(value: unknown): DesktopPetActivity {
  if (!value || typeof value !== "object") throw new Error("Invalid pet activity");
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.tasks) ||
    input.tasks.length > 10000 ||
    typeof input.connected !== "boolean" ||
    !Array.isArray(input.serverIds) ||
    !input.serverIds.every(
      (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512,
    ) ||
    typeof input.fontFamily !== "string" ||
    input.fontFamily.length > 512 ||
    !input.revisions ||
    typeof input.revisions !== "object" ||
    Array.isArray(input.revisions) ||
    !input.labels ||
    typeof input.labels !== "object"
  )
    throw new Error("Invalid pet activity snapshot");
  const rawLabels = input.labels as Record<string, unknown>;
  const labels = {} as DesktopPetLabels;
  for (const key of Object.keys(DEFAULT_PET_ACTIVITY.labels) as (keyof DesktopPetLabels)[]) {
    if (typeof rawLabels[key] !== "string" || rawLabels[key].length > 512)
      throw new Error(`Invalid pet label: ${key}`);
    labels[key] = rawLabels[key];
  }
  const serverIds = new Set<string>(input.connected ? (input.serverIds as string[]) : []);
  const revisions = parsePetRevisions(
    input.revisions as Record<string, unknown>,
    serverIds,
    input.connected,
  );
  const tasks: DesktopPetTask[] = input.tasks.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid pet task");
    const task = raw as Record<string, unknown>;
    if (
      typeof task.serverId !== "string" ||
      !task.serverId ||
      task.serverId.length > 512 ||
      typeof task.agentId !== "string" ||
      !task.agentId ||
      task.agentId.length > 512 ||
      typeof task.title !== "string" ||
      task.title.length > 2048 ||
      typeof task.updatedAt !== "number" ||
      !Number.isFinite(task.updatedAt) ||
      typeof task.status !== "string" ||
      !Object.hasOwn(PRIORITY, task.status) ||
      (input.connected && !Object.hasOwn(revisions, task.serverId))
    )
      throw new Error("Invalid pet task fields");
    return {
      serverId: task.serverId,
      agentId: task.agentId,
      title: task.title,
      updatedAt: task.updatedAt,
      status: task.status as PetTaskStatus,
    };
  });
  return {
    tasks: input.connected ? tasks : [],
    connected: input.connected,
    serverIds: [...serverIds],
    revisions,
    fontFamily: input.fontFamily,
    labels,
  };
}

interface HostActivityRevision {
  revision: DesktopPetRevision | null;
  owner: number;
  report: DesktopPetActivity | null;
}

export class PetActivitySnapshots {
  private readonly snapshots = new Map<number, DesktopPetActivity>();
  private readonly hosts = new Map<string, HostActivityRevision>();

  publish(senderId: number, activity: DesktopPetActivity): DesktopPetActivityResult {
    this.snapshots.delete(senderId);
    this.snapshots.set(senderId, activity);
    const result: DesktopPetActivityResult = { revalidate: [] };
    if (!activity.connected) return result;
    for (const serverId of activity.serverIds) {
      if (!Object.hasOwn(activity.revisions, serverId)) continue;
      const revision = activity.revisions[serverId];
      const current = this.hosts.get(serverId);
      if (!current) {
        this.hosts.set(serverId, { revision, owner: senderId, report: activity });
      } else if (revision && !current.revision) {
        current.revision = revision;
        current.owner = senderId;
        current.report = activity;
      } else if (revision && current.revision) {
        if (revision.generation !== current.revision.generation) {
          // UUID epochs are unordered. Only a fresh daemon read made against our
          // current generation proves a transition; a late unknown epoch cannot.
          if (revision.previousGeneration !== current.revision.generation) {
            result.revalidate.push({ serverId, generation: current.revision.generation });
            continue;
          }
          current.revision = revision;
          current.owner = senderId;
          current.report = activity;
        } else if (revision.seq >= current.revision.seq) {
          current.revision = revision;
          current.owner = senderId;
          current.report = activity;
        } else {
          result.revalidate.push({ serverId, generation: current.revision.generation });
        }
      } else if (current.revision) {
        result.revalidate.push({ serverId, generation: current.revision.generation });
      } else if (current.owner === senderId || !this.hasReport(current.owner, serverId)) {
        // The existing protocol also supports legacy daemons without sequences.
        // Keep one writer rather than treating IPC arrival time as freshness.
        current.owner = senderId;
        current.report = activity;
      }
    }
    return result;
  }

  remove(senderId: number): void {
    this.snapshots.delete(senderId);
  }

  private hasReport(senderId: number, serverId: string): boolean {
    const activity = this.snapshots.get(senderId);
    return (
      !!activity?.connected &&
      activity.serverIds.includes(serverId) &&
      Object.hasOwn(activity.revisions, serverId)
    );
  }

  get(): DesktopPetActivity {
    let latest = DEFAULT_PET_ACTIVITY;
    const activeServers = new Set<string>();
    for (const activity of this.snapshots.values()) {
      latest = activity;
      if (activity.connected) {
        for (const serverId of activity.serverIds) activeServers.add(serverId);
      }
    }
    const tasks: DesktopPetTask[] = [];
    const revisions: DesktopPetActivity["revisions"] = {};
    for (const [serverId, host] of this.hosts) {
      if (!activeServers.has(serverId)) {
        host.report = null;
        continue;
      }
      // Directory state belongs to the host, not its publishing window. Keep the
      // newest accepted report while any window is connected; never revive an
      // older peer's tasks or lose real pending work when one publisher closes.
      const report = host.report;
      if (!report) continue;
      revisions[serverId] = host.revision;
      const byAgent = new Map<string, DesktopPetTask>();
      for (const task of report.tasks) {
        if (task.serverId !== serverId) continue;
        const previous = byAgent.get(task.agentId);
        if (
          !previous ||
          task.updatedAt > previous.updatedAt ||
          (task.updatedAt === previous.updatedAt &&
            PRIORITY[task.status] < PRIORITY[previous.status])
        ) {
          byAgent.set(task.agentId, task);
        }
      }
      tasks.push(...byAgent.values());
    }
    tasks.sort(
      (a, b) =>
        PRIORITY[a.status] - PRIORITY[b.status] ||
        b.updatedAt - a.updatedAt ||
        a.serverId.localeCompare(b.serverId) ||
        a.agentId.localeCompare(b.agentId),
    );
    return {
      ...latest,
      serverIds: [...activeServers],
      revisions,
      connected: activeServers.size > 0,
      tasks,
    };
  }
}
