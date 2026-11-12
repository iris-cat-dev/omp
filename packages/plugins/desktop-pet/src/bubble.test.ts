import { describe, expect, it } from "vitest";
import { createPetBubbleController } from "./bubble.js";
import type {
  DesktopPetActivity,
  DesktopPetTask,
  PetBubbleProfile,
  PetBubbleRule,
  PetBubbleState,
} from "./types.js";

const released = { dragging: false, petting: false };
const petted = { dragging: false, petting: true };
const dragged = { dragging: true, petting: false };

function rule(state: PetBubbleState, changes: Partial<PetBubbleRule> = {}): PetBubbleRule {
  return {
    messages: [`${state} one`, `${state} two`],
    delayMs: 100,
    durationMs: 0,
    repeatDelayMs: 0,
    ...changes,
  };
}

function profile(
  changes: Partial<Record<PetBubbleState, Partial<PetBubbleRule>>> = {},
): PetBubbleProfile {
  return {
    appearance: {
      background: "#112233",
      foreground: "#FFFFFF",
      border: "#445566",
      shape: "speech",
      fontSize: 12,
      fontWeight: "normal",
      padding: 8,
      borderRadius: 10,
      maxWidth: 200,
      animation: "none",
    },
    states: {
      idle: rule("idle", changes.idle),
      offline: rule("offline", changes.offline),
      running: rule("running", changes.running),
      needs_input: rule("needs_input", changes.needs_input),
      ready: rule("ready", changes.ready),
      blocked: rule("blocked", changes.blocked),
      dragging: rule("dragging", changes.dragging),
      petted: rule("petted", changes.petted),
    },
  };
}

function task(
  status: DesktopPetTask["status"],
  agentId = "first",
  serverId = "local",
): DesktopPetTask {
  return { serverId, agentId, status, title: "Active task", updatedAt: 1 };
}

function activity(...tasks: DesktopPetTask[]): Pick<DesktopPetActivity, "connected" | "tasks"> {
  return { connected: true, tasks };
}

const idle = activity();
const working = activity(task("running"));

describe("per-pet bubble scheduling", () => {
  it("waits for the state delay and keeps duration-zero messages until a real transition", () => {
    const bubble = createPetBubbleController(profile());
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(idle, 100, released)).toBe(false);
    expect(bubble.nextAt).toBe(200);
    expect(bubble.update(idle, 199, released)).toBe(false);
    expect(bubble.line).toBeNull();
    expect(bubble.update(idle, 200, released)).toBe(true);
    expect(bubble.line).toBe("idle one");
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(idle, 1_000_000, released)).toBe(false);
    expect(bubble.line).toBe("idle one");
  });

  it("does not restart appearance, visibility, or exhausted clocks on equivalent snapshots", () => {
    const bubble = createPetBubbleController(profile({ running: { durationMs: 400 } }));
    bubble.update(working, 0, released);
    for (const now of [10, 20, 50, 99]) {
      const snapshot = activity(
        { ...task("running"), title: `Renamed ${now}`, updatedAt: now },
        task("needs_input", `secondary-${now}`),
      );
      expect(bubble.update(snapshot, now, released)).toBe(false);
      expect(bubble.nextAt).toBe(100);
    }
    bubble.update(working, 100, released);
    expect(bubble.line).toBe("running one");
    expect(bubble.nextAt).toBe(500);
    expect(bubble.update(activity({ ...task("running"), updatedAt: 499 }), 499, released)).toBe(
      false,
    );
    expect(bubble.nextAt).toBe(500);
    expect(bubble.update(working, 500, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    expect(
      bubble.update(activity({ ...task("running"), updatedAt: 10_000 }), 10_000, released),
    ).toBe(false);
    expect(bubble.nextAt).toBe(Infinity);
  });

  it("restarts the delay for a new primary agent or server, even with the same status", () => {
    const bubble = createPetBubbleController(profile());
    bubble.update(working, 0, released);
    bubble.update(activity(task("running", "second")), 50, released);
    expect(bubble.nextAt).toBe(150);
    bubble.update(activity(task("running", "second", "remote")), 100, released);
    expect(bubble.nextAt).toBe(200);
    bubble.update(activity(task("running", "second", "remote")), 199, released);
    expect(bubble.line).toBeNull();
    bubble.update(activity(task("running", "second", "remote")), 200, released);
    expect(bubble.line).toBe("running one");
    expect(bubble.update(activity(task("running", "third", "remote")), 201, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(301);
  });

  it("honors the first task and clears stale speech before an attention-state delay", () => {
    const bubble = createPetBubbleController(profile({ idle: { delayMs: 0 } }));
    bubble.update(idle, 0, released);
    expect(bubble.line).toBe("idle one");
    const attention = activity(task("needs_input", "approval"), task("running"));
    expect(bubble.update(attention, 10, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(110);
    bubble.update(attention, 109, released);
    expect(bubble.line).toBeNull();
    bubble.update(attention, 110, released);
    expect(bubble.line).toBe("needs_input one");
    bubble.update(activity(task("blocked", "approval"), task("running")), 111, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(211);
    bubble.update(activity(task("blocked", "approval"), task("running")), 211, released);
    expect(bubble.line).toBe("blocked one");
    bubble.update(activity(task("ready", "approval")), 212, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(312);
    bubble.update(activity(task("ready", "approval")), 312, released);
    expect(bubble.line).toBe("ready one");
  });

  it("uses offline timing despite stale tasks and restarts on reconnection", () => {
    const bubble = createPetBubbleController(profile({ running: { delayMs: 0 } }));
    bubble.update(working, 0, released);
    expect(bubble.line).toBe("running one");
    expect(bubble.update({ ...working, connected: false }, 10, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(110);
    bubble.update({ connected: false, tasks: [task("blocked", "different")] }, 90, released);
    expect(bubble.nextAt).toBe(110);
    bubble.update({ connected: false, tasks: [] }, 110, released);
    expect(bubble.line).toBe("offline one");
    expect(bubble.nextAt).toBe(Infinity);
    bubble.update(working, 120, released);
    expect(bubble.line).toBe("running two");
    expect(bubble.nextAt).toBe(Infinity);
  });

  it("hides a timed message once without repeating on unchanged activity", () => {
    const bubble = createPetBubbleController(profile({ idle: { delayMs: 0, durationMs: 250 } }));
    bubble.update(idle, 100, released);
    expect(bubble.line).toBe("idle one");
    expect(bubble.nextAt).toBe(350);
    expect(bubble.update(idle, 349, released)).toBe(false);
    expect(bubble.update(idle, 350, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(idle, 1_000_000, released)).toBe(false);
    expect(bubble.line).toBeNull();
  });

  it("waits after hiding before rotating repeated messages, without reapplying the initial delay", () => {
    const bubble = createPetBubbleController(
      profile({
        running: { delayMs: 50, durationMs: 200, repeatDelayMs: 1_000 },
      }),
    );
    bubble.update(working, 10, released);
    expect(bubble.nextAt).toBe(60);
    bubble.update(working, 60, released);
    expect(bubble.line).toBe("running one");
    expect(bubble.nextAt).toBe(260);
    bubble.update(working, 260, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(1_260);
    expect(bubble.update(working, 1_259, released)).toBe(false);
    bubble.update(working, 1_260, released);
    expect(bubble.line).toBe("running two");
    expect(bubble.nextAt).toBe(1_460);
    bubble.update(working, 1_460, released);
    expect(bubble.nextAt).toBe(2_460);
    bubble.update(working, 2_460, released);
    expect(bubble.line).toBe("running one");
  });

  it("repeats a one-message rule and gives late callbacks full visibility and repeat waits", () => {
    const bubble = createPetBubbleController(
      profile({
        idle: { messages: ["Only this pet"], durationMs: 200, repeatDelayMs: 1_000 },
      }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 5_000, released);
    expect(bubble.line).toBe("Only this pet");
    expect(bubble.nextAt).toBe(5_200);
    bubble.update(idle, 20_000, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(21_000);
    expect(bubble.update(idle, 20_001, released)).toBe(false);
    bubble.update(idle, 30_000, released);
    expect(bubble.line).toBe("Only this pet");
    expect(bubble.nextAt).toBe(30_200);
  });

  it("rotates each state's own messages across actual state entries", () => {
    const bubble = createPetBubbleController(
      profile({
        idle: { delayMs: 0 },
        running: { delayMs: 0 },
      }),
    );
    bubble.update(idle, 0, released);
    expect(bubble.line).toBe("idle one");
    bubble.update(working, 1, released);
    expect(bubble.line).toBe("running one");
    bubble.update(idle, 2, released);
    expect(bubble.line).toBe("idle two");
    bubble.update(working, 3, released);
    expect(bubble.line).toBe("running two");
    bubble.update(idle, 4, released);
    expect(bubble.line).toBe("idle one");
  });

  it("keeps explicit silent states timer-free and cancels both visible and pending speech", () => {
    const bubble = createPetBubbleController(
      profile({
        idle: { delayMs: 0 },
        blocked: { messages: [], durationMs: 200, repeatDelayMs: 1_000 },
      }),
    );
    bubble.update(idle, 0, released);
    expect(bubble.line).toBe("idle one");
    const blocked = activity(task("blocked"));
    expect(bubble.update(blocked, 1, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(blocked, 1_000_000, released)).toBe(false);
    expect(bubble.nextAt).toBe(Infinity);
    bubble.update(working, 1_000_001, released);
    expect(bubble.nextAt).toBe(1_000_101);
    bubble.update(blocked, 1_000_050, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    bubble.update(blocked, 1_000_101, released);
    expect(bubble.line).toBeNull();
  });

  it("gives dragging precedence and starts the latest base delay on release", () => {
    const bubble = createPetBubbleController(
      profile({
        idle: { delayMs: 0 },
        dragging: { delayMs: 30 },
      }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 10, { dragging: true, petting: true });
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(40);
    const attention = activity(task("needs_input"));
    bubble.update(attention, 20, { dragging: true, petting: true });
    expect(bubble.nextAt).toBe(40);
    bubble.update(attention, 40, { dragging: true, petting: true });
    expect(bubble.line).toBe("dragging one");
    bubble.update(attention, 50, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(150);
    bubble.update(attention, 150, petted);
    expect(bubble.line).toBe("needs_input one");
  });

  it("does not resume an interrupted caption when a short drag ends before its delay", () => {
    const bubble = createPetBubbleController(profile());
    bubble.update(working, 0, released);
    bubble.update(working, 40, dragged);
    expect(bubble.nextAt).toBe(140);
    bubble.update(working, 60, released);
    expect(bubble.nextAt).toBe(160);
    bubble.update(working, 140, released);
    expect(bubble.line).toBeNull();
    bubble.update(working, 160, released);
    expect(bubble.line).toBe("running one");
  });

  it("lets delayed petting speech outlast the physical gesture, then restarts base timing", () => {
    const bubble = createPetBubbleController(
      profile({
        petted: { delayMs: 200, durationMs: 500 },
      }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 100, released);
    expect(bubble.line).toBe("idle one");
    bubble.update(idle, 120, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(320);
    expect(bubble.update(idle, 150, released)).toBe(false);
    expect(bubble.nextAt).toBe(320);
    bubble.update(idle, 320, released);
    expect(bubble.line).toBe("petted one");
    expect(bubble.nextAt).toBe(820);
    bubble.update(idle, 819, released);
    expect(bubble.line).toBe("petted one");
    bubble.update(idle, 820, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(920);
    bubble.update(idle, 920, released);
    expect(bubble.line).toBe("idle two");
  });

  it("runs petting only once while held and can return directly to a zero-delay base", () => {
    const bubble = createPetBubbleController(
      profile({
        running: { delayMs: 0 },
        petted: { delayMs: 0, durationMs: 50 },
      }),
    );
    bubble.update(working, 0, petted);
    expect(bubble.line).toBe("petted one");
    expect(bubble.nextAt).toBe(50);
    bubble.update(working, 49, petted);
    expect(bubble.nextAt).toBe(50);
    bubble.update(working, 50, petted);
    expect(bubble.line).toBe("running one");
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(working, 10_000, petted)).toBe(false);
    expect(bubble.line).toBe("running one");
    bubble.update(working, 10_001, released);
    bubble.update(working, 10_002, petted);
    expect(bubble.line).toBe("petted two");
    expect(bubble.nextAt).toBe(10_052);
  });

  it("keeps persistent petting after release but cancels it for a new primary task", () => {
    const bubble = createPetBubbleController(profile({ petted: { delayMs: 0 } }));
    bubble.update(working, 0, released);
    bubble.update(working, 1, petted);
    expect(bubble.line).toBe("petted one");
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(working, 2, released)).toBe(false);
    expect(
      bubble.update(
        activity({ ...task("running"), title: "New title", updatedAt: 10 }),
        10,
        released,
      ),
    ).toBe(false);
    expect(bubble.line).toBe("petted one");
    bubble.update(activity(task("running", "replacement")), 20, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(120);
    bubble.update(activity(task("running", "replacement")), 120, released);
    expect(bubble.line).toBe("running one");
  });

  it("cancels pending petting for a base status change rather than showing stale speech", () => {
    const bubble = createPetBubbleController(
      profile({ petted: { delayMs: 500, durationMs: 200 } }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 10, petted);
    expect(bubble.nextAt).toBe(510);
    const attention = activity(task("needs_input"));
    bubble.update(attention, 20, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(120);
    bubble.update(attention, 120, petted);
    expect(bubble.line).toBe("needs_input one");
    bubble.update(attention, 510, released);
    expect(bubble.line).toBe("needs_input one");
    expect(bubble.nextAt).toBe(Infinity);
  });

  it("cancels visible petting on disconnect and requires a fresh edge after reconnecting", () => {
    const bubble = createPetBubbleController(profile({ petted: { delayMs: 0, durationMs: 500 } }));
    bubble.update(working, 0, released);
    bubble.update(working, 1, petted);
    expect(bubble.line).toBe("petted one");
    const offline = { connected: false, tasks: working.tasks };
    bubble.update(offline, 10, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(110);
    bubble.update(offline, 110, petted);
    expect(bubble.line).toBe("offline one");
    bubble.update(working, 120, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(220);
    bubble.update(working, 220, petted);
    expect(bubble.line).toBe("running one");
  });

  it("gives a simultaneous base transition precedence over a new petting edge", () => {
    const bubble = createPetBubbleController(
      profile({
        petted: { delayMs: 0 },
        blocked: { delayMs: 0 },
      }),
    );
    bubble.update(idle, 0, released);
    const blocked = activity(task("blocked"));
    bubble.update(blocked, 1, petted);
    expect(bubble.line).toBe("blocked one");
    expect(bubble.nextAt).toBe(Infinity);
    bubble.update(blocked, 2, released);
    bubble.update(blocked, 3, petted);
    expect(bubble.line).toBe("petted one");
  });

  it("lets a new gesture restart petting timing and lets dragging safely interrupt it", () => {
    const bubble = createPetBubbleController(
      profile({
        dragging: { delayMs: 0 },
        petted: { delayMs: 100, durationMs: 500 },
      }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 10, petted);
    bubble.update(idle, 20, released);
    bubble.update(idle, 30, petted);
    expect(bubble.nextAt).toBe(130);
    bubble.update(idle, 130, petted);
    expect(bubble.line).toBe("petted one");
    expect(bubble.nextAt).toBe(630);
    bubble.update(idle, 140, dragged);
    expect(bubble.line).toBe("dragging one");
    bubble.update(idle, 150, released);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(250);
    bubble.update(idle, 250, released);
    expect(bubble.line).toBe("idle one");
    bubble.update(idle, 630, released);
    expect(bubble.line).toBe("idle one");
  });

  it("keeps a silent petting gesture timer-free and restores base timing on release", () => {
    const bubble = createPetBubbleController(
      profile({ petted: { messages: [], durationMs: 500 } }),
    );
    bubble.update(idle, 0, released);
    bubble.update(idle, 100, released);
    expect(bubble.line).toBe("idle one");
    bubble.update(idle, 110, petted);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(idle, 1_000_000, petted)).toBe(false);
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(idle, 1_000_001, released)).toBe(false);
    expect(bubble.nextAt).toBe(1_000_101);
    bubble.update(idle, 1_000_101, released);
    expect(bubble.line).toBe("idle two");
  });

  it("returns line changes only, even if a transition changes timing with the same text", () => {
    const bubble = createPetBubbleController(
      profile({
        idle: { messages: ["Shared words"], delayMs: 0 },
        running: { messages: ["Shared words"], delayMs: 0, durationMs: 50 },
      }),
    );
    expect(bubble.update(idle, 0, released)).toBe(true);
    expect(bubble.nextAt).toBe(Infinity);
    expect(bubble.update(working, 1, released)).toBe(false);
    expect(bubble.line).toBe("Shared words");
    expect(bubble.nextAt).toBe(51);
    expect(bubble.update(working, 51, released)).toBe(true);
    expect(bubble.line).toBeNull();
    expect(bubble.nextAt).toBe(Infinity);
  });

  it("keeps independent pets' timing, voices, and message rotation separate", () => {
    const first = createPetBubbleController(
      profile({ idle: { messages: ["First pet"], delayMs: 0 } }),
    );
    const second = createPetBubbleController(
      profile({ idle: { messages: ["Second pet"], delayMs: 500 } }),
    );
    first.update(idle, 0, released);
    second.update(idle, 0, released);
    expect(first.line).toBe("First pet");
    expect(first.nextAt).toBe(Infinity);
    expect(second.line).toBeNull();
    expect(second.nextAt).toBe(500);
    second.update(idle, 500, released);
    expect(second.line).toBe("Second pet");
    expect(first.line).toBe("First pet");
  });
});
