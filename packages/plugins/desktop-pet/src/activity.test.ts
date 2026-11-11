import { describe, expect, it } from "vitest";
import { DEFAULT_PET_ACTIVITY, PetActivitySnapshots, parsePetActivity } from "./activity.js";
import type { DesktopPetActivity, DesktopPetTask, PetTaskStatus } from "./types.js";

function task(
  agentId: string,
  status: PetTaskStatus,
  updatedAt = 1,
  serverId = "local",
): DesktopPetTask {
  return { serverId, agentId, title: agentId, status, updatedAt };
}

function activity(
  tasks: DesktopPetTask[],
  seq = 1,
  serverIds = ["local"],
  generation = "g1",
  previousGeneration?: string,
): DesktopPetActivity {
  return {
    ...DEFAULT_PET_ACTIVITY,
    connected: true,
    serverIds,
    revisions: Object.fromEntries(
      serverIds.map((serverId) => [
        serverId,
        { generation, seq, ...(previousGeneration ? { previousGeneration } : {}) },
      ]),
    ),
    tasks,
  };
}

describe("companion activity snapshots", () => {
  it("prioritizes real attention before blocked, review and working tasks", () => {
    const snapshots = new PetActivitySnapshots();
    snapshots.publish(
      1,
      activity([
        task("a", "running", 999),
        task("b", "ready"),
        task("c", "blocked"),
        task("d", "needs_input"),
      ]),
    );
    expect(snapshots.get().tasks.map((entry) => entry.agentId)).toEqual(["d", "c", "b", "a"]);
  });

  it("uses directory sequence rather than task timestamps while preserving host-scoped identity", () => {
    const snapshots = new PetActivitySnapshots();
    snapshots.publish(1, activity([task("same", "needs_input", 999)]));
    snapshots.publish(
      2,
      activity([task("same", "running", 1), task("same", "ready", 1, "remote")], 2, [
        "local",
        "remote",
      ]),
    );
    expect(snapshots.get().tasks).toEqual([
      task("same", "ready", 1, "remote"),
      task("same", "running", 1),
    ]);
    expect(snapshots.publish(1, activity([task("same", "needs_input", 999)]))).toEqual({
      revalidate: [{ serverId: "local", generation: "g1" }],
    });
    expect(snapshots.get().tasks[1]?.status).toBe("running");
  });

  it("never revives cleared tasks when an old window republishes or the clearing window closes", () => {
    const snapshots = new PetActivitySnapshots();
    const stale = activity([task("acknowledged", "ready")]);
    snapshots.publish(1, stale);
    snapshots.publish(2, activity([], 2));
    snapshots.publish(1, { ...stale, fontFamily: "Another font" });
    expect(snapshots.get().tasks).toEqual([]);
    snapshots.remove(2);
    snapshots.publish(1, stale);
    expect(snapshots.get().tasks).toEqual([]);

    for (const [seq, status] of [
      [3, "running"],
      [4, "needs_input"],
      [5, "blocked"],
      [6, "ready"],
    ] as const) {
      snapshots.publish(1, activity([task("acknowledged", status)], seq));
      expect(snapshots.get().tasks[0]?.status).toBe(status);
    }
  });

  it("keeps authoritative pending work when its publishing window closes but the host remains connected", () => {
    const snapshots = new PetActivitySnapshots();
    snapshots.publish(1, activity([]));
    snapshots.publish(2, activity([task("approval", "needs_input")], 2));
    snapshots.publish(3, activity([task("remote", "running", 1, "remote")], 1, ["remote"]));
    snapshots.publish(2, activity([]));
    expect(snapshots.get().tasks).toEqual([
      task("approval", "needs_input"),
      task("remote", "running", 1, "remote"),
    ]);
    snapshots.remove(2);
    expect(snapshots.get().tasks).toEqual([
      task("approval", "needs_input"),
      task("remote", "running", 1, "remote"),
    ]);
    snapshots.publish(1, { ...DEFAULT_PET_ACTIVITY });
    expect(snapshots.get().tasks).toEqual([task("remote", "running", 1, "remote")]);
    snapshots.remove(3);
    expect(snapshots.get().connected).toBe(false);
    expect(snapshots.get().tasks).toEqual([]);
  });

  it("requires a daemon-proven generation transition even with old online publishers", () => {
    const snapshots = new PetActivitySnapshots();
    const old = activity([task("old", "ready")], 100);
    snapshots.publish(1, old);
    expect(snapshots.publish(2, activity([task("new", "running")], 1, ["local"], "g2"))).toEqual({
      revalidate: [{ serverId: "local", generation: "g1" }],
    });
    expect(snapshots.get().tasks).toEqual(old.tasks);
    snapshots.publish(2, activity([task("new", "running")], 1, ["local"], "g2", "g1"));
    expect(snapshots.get().tasks).toEqual([task("new", "running")]);
    snapshots.publish(1, old);
    expect(snapshots.get().tasks).toEqual([task("new", "running")]);
  });

  it("rejects an old generation's first late report and an old transition proof", () => {
    const snapshots = new PetActivitySnapshots();
    snapshots.publish(1, activity([task("current", "running")], 2, ["local"], "g2"));
    const late = activity([task("old", "ready")], 900, ["local"], "g1");
    expect(snapshots.publish(2, late).revalidate).toEqual([
      { serverId: "local", generation: "g2" },
    ]);
    expect(snapshots.get().tasks).toEqual([task("current", "running")]);
    snapshots.publish(1, activity([task("next", "needs_input")], 1, ["local"], "g3", "g2"));
    snapshots.publish(2, activity([task("old", "ready")], 20, ["local"], "g2", "g1"));
    expect(snapshots.get().tasks).toEqual([task("next", "needs_input")]);
    snapshots.publish(2, activity([], 2, ["local"], "g3", "g2"));
    snapshots.remove(1);
    expect(snapshots.get().tasks).toEqual([]);
  });

  it("uses one stable publisher for an existing unsequenced daemon connection", () => {
    const snapshots = new PetActivitySnapshots();
    const first = { ...activity([task("working", "running")]), revisions: { local: null } };
    snapshots.publish(1, first);
    snapshots.publish(2, { ...activity([task("stale", "ready")]), revisions: { local: null } });
    expect(snapshots.get().tasks).toEqual(first.tasks);
    snapshots.remove(1);
    snapshots.publish(2, { ...activity([], 2), revisions: { local: null } });
    expect(snapshots.get().tasks).toEqual([]);
  });

  it("clears disconnected reports and validates directory revisions and task ownership", () => {
    const snapshots = new PetActivitySnapshots();
    snapshots.publish(1, parsePetActivity(activity([task("a", "ready")])));
    snapshots.publish(
      1,
      parsePetActivity({
        ...DEFAULT_PET_ACTIVITY,
        connected: false,
        tasks: [task("a", "ready")],
      }),
    );
    expect(snapshots.get().tasks).toEqual([]);
    expect(() => parsePetActivity(activity([task("a", "running", NaN)]))).toThrow(
      "Invalid pet task",
    );
    expect(() => parsePetActivity({ ...DEFAULT_PET_ACTIVITY, labels: {} })).toThrow(
      "Invalid pet label",
    );
    expect(() =>
      parsePetActivity({
        ...activity([]),
        revisions: { local: { generation: "g1", seq: 1.5 } },
      }),
    ).toThrow("Invalid pet directory revision");
    expect(() =>
      parsePetActivity({
        ...activity([]),
        revisions: { local: { generation: "g1", seq: 1, previousGeneration: "g1" } },
      }),
    ).toThrow("Invalid pet directory revision");
    expect(() =>
      parsePetActivity({
        ...activity([task("a", "ready")]),
        revisions: {},
      }),
    ).toThrow("Invalid pet task");
    expect(() =>
      parsePetActivity({
        ...activity([]),
        revisions: { remote: { generation: "g1", seq: 1 } },
      }),
    ).toThrow("Invalid pet directory host");
  });

  it("keeps stable priority ties when independent hosts report in different orders", () => {
    const a = new PetActivitySnapshots();
    const b = new PetActivitySnapshots();
    const first = activity([task("b", "needs_input")]);
    const second = activity([task("a", "needs_input", 1, "remote")], 1, ["remote"]);
    a.publish(1, first);
    a.publish(2, second);
    b.publish(2, second);
    b.publish(1, first);
    expect(a.get().tasks).toEqual([
      task("b", "needs_input"),
      task("a", "needs_input", 1, "remote"),
    ]);
    expect(a.get().tasks).toEqual(b.get().tasks);
  });
});
