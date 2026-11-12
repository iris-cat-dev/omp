import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPetActivity } from "./types.js";
import { createWorkChatter } from "./work-chatter.js";

const working: Pick<DesktopPetActivity, "connected" | "tasks"> = {
  connected: true,
  tasks: [
    Object.freeze({
      serverId: "local",
      agentId: "worker",
      title: "Active task",
      status: "running" as const,
      updatedAt: 1,
    }),
  ],
};
const idle = { connected: true, tasks: [] };

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Iris work chatter", () => {
  it("waits for its deadline and returns to real task status after the caption expires", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 100, true);
    const due = chatter.nextAt;
    chatter.update(working, due - 1, true);
    expect(chatter.line).toBeNull();
    chatter.update(working, due, true);
    expect(chatter.line?.animation).toBe("ready");
    expect(working.tasks[0].status).toBe("running");
    const expires = chatter.nextAt;
    chatter.update(working, expires - 1, true);
    expect(chatter.line?.animation).toBe("ready");
    chatter.update(working, expires, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBeGreaterThan(expires);
  });

  it("uses the wistful face for both requested complaint lines", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    vi.mocked(Math.random).mockReturnValue(0.25);
    chatter.update(working, chatter.nextAt, true);
    expect(chatter.line).toEqual({ text: "不想上班...", animation: "running" });
    chatter.update(working, chatter.nextAt, true);
    vi.mocked(Math.random).mockReturnValue(0.9);
    chatter.update(working, chatter.nextAt, true);
    expect(chatter.line).toEqual({ text: "Tibo什么时候重置...", animation: "running" });
  });

  it("does not postpone a caption indefinitely when running snapshots keep arriving", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    const due = chatter.nextAt;
    for (let now = 1_000; now < due; now += 1_000) chatter.update(working, now, true);
    chatter.update(working, due, true);
    expect(chatter.line?.animation).toBe("ready");
  });

  it("cancels an unshown caption and starts a fresh delay for the next task", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    const abandonedDeadline = chatter.nextAt;
    chatter.update(idle, abandonedDeadline - 1, true);
    chatter.update(idle, abandonedDeadline, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBe(Infinity);
    const resumed = abandonedDeadline + 1;
    chatter.update(working, resumed, true);
    chatter.update(working, resumed + 1, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBeGreaterThan(resumed);
  });

  it("removes a visible caption immediately when the last running task ends", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    chatter.update(working, chatter.nextAt, true);
    const beforeExpiry = chatter.nextAt - 1;
    expect(chatter.update(idle, beforeExpiry, true)).toBe(true);
    expect(chatter.line).toBeNull();
    chatter.update(idle, beforeExpiry + 600_000, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBe(Infinity);
  });

  it("cannot keep talking from a disconnected running snapshot", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    chatter.update(working, chatter.nextAt, true);
    const disconnected = { ...working, connected: false };
    chatter.update(disconnected, chatter.nextAt - 1, true);
    chatter.update(disconnected, 600_000, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBe(Infinity);
  });

  it("preserves attention priority even when another task is still running", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    chatter.update(working, chatter.nextAt, true);
    const attention: typeof working = {
      connected: true,
      tasks: [
        { ...working.tasks[0], agentId: "approval", status: "needs_input" },
        ...working.tasks,
      ],
    };
    chatter.update(attention, chatter.nextAt - 1, true);
    chatter.update(attention, 600_000, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBe(Infinity);
  });

  it("suspends chatter for direct interaction or an unavailable pet and does not resume mid-caption", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    chatter.update(working, chatter.nextAt, true);
    const interrupted = chatter.nextAt - 1;
    chatter.update(working, interrupted, false);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBe(Infinity);
    chatter.update(working, interrupted + 1, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBeGreaterThan(interrupted + 1);
  });

  it("does not replay missed captions in a burst after a delayed callback", () => {
    const chatter = createWorkChatter();
    chatter.update(working, 0, true);
    chatter.update(working, chatter.nextAt, true);
    const resumed = chatter.nextAt + 600_000;
    chatter.update(working, resumed, true);
    chatter.update(working, resumed + 1, true);
    expect(chatter.line).toBeNull();
    expect(chatter.nextAt).toBeGreaterThan(resumed + 1);
  });
});
