import { describe, expect, it } from "vitest";
import { reduceTurnLiveness, resolveTurnPresentation, TURN_LIVENESS_IDLE } from "./turn-liveness";

describe("turn activity", () => {
  const startedAt = new Date("2026-07-31T10:00:00.000Z");

  it("ignores a terminal event for another turn", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-2", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "stream_close", turnId: "turn-1" })).toBe(open);
  });

  it("replaces activity from an authoritative snapshot", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "snapshot", activeTurn: null })).toEqual(
      TURN_LIVENESS_IDLE,
    );
  });

  it("opens an autonomous turn from an authoritative snapshot", () => {
    expect(
      reduceTurnLiveness(TURN_LIVENESS_IDLE, {
        type: "snapshot",
        activeTurn: { turnId: "autonomous-turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "autonomous-turn-1",
      startedAt,
      cancellationRequestId: null,
    });
  });

  it("does not let an old cancel completion clear the current request", () => {
    const first = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });
    const second = reduceTurnLiveness(first, { type: "cancellation_started", requestId: 2 });

    expect(reduceTurnLiveness(second, { type: "cancellation_settled", requestId: 1 })).toBe(second);
  });

  it("keeps cancellation pending across submission-to-turn handoff", () => {
    const canceling = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });

    expect(
      reduceTurnLiveness(canceling, {
        type: "stream_open",
        turn: { turnId: "turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt,
      cancellationRequestId: 1,
    });
  });

  it("keeps submission-only activity untimed", () => {
    expect(resolveTurnPresentation(TURN_LIVENESS_IDLE, true)).toEqual({
      isActive: true,
      isCancelling: false,
      startedAt: null,
      turnId: null,
    });
  });

  it("shows the latest nonempty intent only for the active turn", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });
    const first = reduceTurnLiveness(open, {
      type: "working_intent",
      turnId: "turn-1",
      intent: "Reading files",
    });
    const latest = reduceTurnLiveness(first, {
      type: "working_intent",
      turnId: "turn-1",
      intent: "  Updating code  ",
    });
    expect(resolveTurnPresentation(latest, false).workingIntent).toBe("Updating code");
    expect(
      reduceTurnLiveness(latest, {
        type: "working_intent",
        turnId: "turn-2",
        intent: "Stale work",
      }),
    ).toBe(latest);
    expect(
      reduceTurnLiveness(latest, {
        type: "working_intent",
        turnId: "turn-1",
        intent: " \n ",
      }),
    ).toBe(latest);
  });

  it("retains intent across same-turn updates but clears it on authoritative reset", () => {
    const restored = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "snapshot",
      activeTurn: { turnId: "turn-1", startedAt, workingIntent: "Reading files" },
    });
    const reopened = reduceTurnLiveness(restored, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });
    expect(resolveTurnPresentation(reopened, false).workingIntent).toBe("Reading files");
    const reset = reduceTurnLiveness(reopened, {
      type: "snapshot",
      activeTurn: { turnId: "turn-1", startedAt, workingIntent: null },
    });
    expect(resolveTurnPresentation(reset, false).workingIntent).toBeUndefined();
    const next = reduceTurnLiveness(restored, {
      type: "stream_open",
      turn: { turnId: "turn-2", startedAt },
    });
    expect(resolveTurnPresentation(next, false).workingIntent).toBeUndefined();
  });

  it("does not revive working intent after cancellation or terminal close", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });
    const cancelling = reduceTurnLiveness(open, { type: "cancellation_started", requestId: 1 });
    const update = { type: "working_intent" as const, turnId: "turn-1", intent: "Late work" };
    expect(reduceTurnLiveness(cancelling, update)).toBe(cancelling);
    const closed = reduceTurnLiveness(open, { type: "stream_close", turnId: "turn-1" });
    expect(reduceTurnLiveness(closed, update)).toBe(closed);
    expect(reduceTurnLiveness(TURN_LIVENESS_IDLE, update)).toBe(TURN_LIVENESS_IDLE);
  });
});
