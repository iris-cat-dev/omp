import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  VisualFeedbackRequest,
  VisualFeedbackSubmission,
} from "@omp-desktop/protocol/visual-feedback";
import { VISUAL_FEEDBACK_MAX_IMAGE_BYTES } from "@omp-desktop/protocol/visual-feedback";
import type { SessionOutboundMessage } from "./messages.js";
import { VisualFeedbackService, inspectVisualFeedbackImage } from "./visual-feedback-service.js";
import { VisualFeedbackSession } from "./session/visual-feedback-session.js";

const services: VisualFeedbackService[] = [];
const request = {
  agentId: "agent-a",
  title: "Review",
  instructions: "Annotate this",
  text: "draft",
};
const submitted: VisualFeedbackSubmission = {
  text: "edited",
  feedback: "change heading",
  annotations: [],
};

function service() {
  const value = new VisualFeedbackService();
  services.push(value);
  return value;
}

async function image() {
  return inspectVisualFeedbackImage(
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer(),
  );
}

afterEach(() => {
  for (const value of services.splice(0)) value.close();
  vi.useRealTimers();
});

describe("visual feedback lifecycle", () => {
  it("waits for explicit submission, isolates concurrent requests, and rejects double submission", async () => {
    const value = service();
    const snapshots: VisualFeedbackRequest[][] = [];
    value.subscribe((requests) => snapshots.push(requests));
    let settled = false;
    const first = value.request(request).then((response) => {
      settled = true;
      return response;
    });
    const second = value.request({ ...request, agentId: "agent-b" });
    await Promise.resolve();
    expect(settled).toBe(false);
    const [a, b] = value.list();
    expect(a.id).not.toBe(b.id);
    await value.respond(b.id, { status: "submitted", submission: submitted });
    expect(await second).toEqual({ status: "submitted", submission: submitted });
    expect(settled).toBe(false);
    expect(value.list().map((pending) => pending.id)).toEqual([a.id]);
    await expect(
      value.respond(b.id, { status: "submitted", submission: submitted }),
    ).rejects.toThrow("no longer pending");
    await value.respond(a.id, { status: "submitted", submission: submitted });
    expect(await first).toEqual({ status: "submitted", submission: submitted });
    expect(snapshots.map((snapshot) => snapshot.length)).toEqual([1, 2, 1, 0]);
  });

  it("cancellation returns no draft even if a client includes submission fields", async () => {
    const value = service();
    const result = value.request(request);
    const input = { status: "cancelled" as const, submission: submitted };
    await value.respond(value.list()[0].id, input);
    expect(await result).toEqual({ status: "cancelled" });
  });

  it("aborts, times out within 30 minutes, and cancels all waiters on shutdown", async () => {
    vi.useFakeTimers();
    const value = service();
    const controller = new AbortController();
    const aborted = value.request(request, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toEqual({ status: "cancelled" });
    const timed = value.request(request, { timeoutMs: 60 * 60 * 1000 });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(value.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await timed).toEqual({ status: "cancelled" });
    const shutdown = value.request(request);
    value.close();
    expect(await shutdown).toEqual({ status: "cancelled" });
    await expect(value.request(request)).rejects.toThrow("closed");
    expect(value.list()).toEqual([]);
  });

  it("keeps pending requests available to a reconnected editor and unsubscribes disposed sessions", async () => {
    const value = service();
    const oldEvents: SessionOutboundMessage[] = [];
    const oldSession = new VisualFeedbackSession({
      service: value,
      emit: (event) => oldEvents.push(event),
      emitForSource: (event) => oldEvents.push(event),
    });
    const result = value.request(request);
    oldSession.dispose();
    const newEvents: SessionOutboundMessage[] = [];
    const newSession = new VisualFeedbackSession({
      service: value,
      emit: (event) => newEvents.push(event),
      emitForSource: (event) => newEvents.push(event),
    });
    const pending = value.list()[0];
    await newSession.handle({ type: "visual_feedback.list", requestId: "list-rpc" });
    expect(newEvents).toContainEqual({
      type: "visual_feedback.list.response",
      payload: { requestId: "list-rpc", requests: [pending] },
    });
    await newSession.handle({
      type: "visual_feedback.respond",
      requestId: "respond-rpc",
      feedbackRequestId: pending.id,
      response: { status: "submitted", submission: submitted },
    });
    expect(await result).toEqual({ status: "submitted", submission: submitted });
    expect(oldEvents).toHaveLength(1);
    expect(newEvents).toContainEqual({
      type: "visual_feedback.requests",
      payload: { requests: [] },
    });
    expect(newEvents).toContainEqual({
      type: "visual_feedback.respond.response",
      payload: { requestId: "respond-rpc" },
    });
    await newSession.handle({
      type: "visual_feedback.respond",
      requestId: "duplicate-rpc",
      feedbackRequestId: pending.id,
      response: { status: "cancelled" },
    });
    expect(newEvents.at(-1)).toMatchObject({
      type: "rpc_error",
      payload: { requestId: "duplicate-rpc" },
    });
    newSession.dispose();
  });

  it("preserves submitted pixels and accepts a proportional downscaled annotated export", async () => {
    const value = service();
    const original = await image();
    const added = Promise.withResolvers<VisualFeedbackRequest>();
    value.subscribe((requests) => {
      if (requests[0]) added.resolve(requests[0]);
    });
    const result = value.request({ ...request, image: original });
    const pending = await added.promise;
    const preview = await inspectVisualFeedbackImage(
      await sharp(Buffer.from(original.data, "base64")).resize(10, 5).png().toBuffer(),
    );
    await value.respond(pending.id, {
      status: "submitted",
      submission: {
        ...submitted,
        image: original,
        annotations: [{ kind: "arrow", id: "a", text: "Move", x: 1, y: 1, x2: 20, y2: 10 }],
        preview,
      },
    });
    expect(await result).toMatchObject({
      status: "submitted",
      submission: { image: original, preview },
    });
  });

  it("honors explicit image replacement or removal by the user", async () => {
    const value = service();
    const original = await image();
    const replacement = await inspectVisualFeedbackImage(
      await sharp(Buffer.from(original.data, "base64")).resize(10, 5).png().toBuffer(),
    );
    for (const selected of [replacement, undefined]) {
      const opened = Promise.withResolvers<VisualFeedbackRequest>();
      const unsubscribe = value.subscribe((requests) => {
        if (requests[0]) opened.resolve(requests[0]);
      });
      const result = value.request({ ...request, image: original });
      const pending = await opened.promise;
      await value.respond(pending.id, {
        status: "submitted",
        submission: { ...submitted, ...(selected ? { image: selected } : {}) },
      });
      const response = await result;
      expect(response).toEqual({
        status: "submitted",
        submission: { ...submitted, ...(selected ? { image: selected } : {}) },
      });
      unsubscribe();
    }
  });

  it("accepts exactly one concurrent submission and cancellation wins over an unfinished decode", async () => {
    const value = service();
    const original = await image();
    const result = value.request(request);
    const id = value.list()[0].id;
    const response = {
      status: "submitted" as const,
      submission: { ...submitted, image: original },
    };
    const attempts = await Promise.allSettled([
      value.respond(id, response),
      value.respond(id, response),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await result).toEqual(response);

    const cancelled = value.request(request);
    const cancelId = value.list()[0].id;
    const decoding = value.respond(cancelId, response);
    await value.respond(cancelId, { status: "cancelled" });
    await expect(decoding).rejects.toThrow("no longer pending");
    expect(await cancelled).toEqual({ status: "cancelled" });
  });

  it("rejects annotations outside the image without consuming a valid pending request", async () => {
    const value = service();
    const original = await image();
    const added = Promise.withResolvers<VisualFeedbackRequest>();
    value.subscribe((requests) => {
      if (requests[0]) added.resolve(requests[0]);
    });
    const result = value.request({ ...request, image: original });
    const pending = await added.promise;
    for (const annotation of [
      { kind: "point" as const, id: "a", text: "", x: 21, y: 1 },
      { kind: "rectangle" as const, id: "a", text: "", x: 10, y: 1, width: 11, height: 1 },
      { kind: "arrow" as const, id: "a", text: "", x: 1, y: 1, x2: 1, y2: 11 },
      {
        kind: "pen" as const,
        id: "a",
        text: "",
        points: [
          { x: 1, y: 1 },
          { x: 21, y: 1 },
        ],
      },
    ]) {
      await expect(
        value.respond(pending.id, {
          status: "submitted",
          submission: { ...submitted, image: original, annotations: [annotation] },
        }),
      ).rejects.toThrow("outside");
    }
    expect(value.list()).toHaveLength(1);
    await value.respond(pending.id, { status: "cancelled" });
    expect(await result).toEqual({ status: "cancelled" });
  });

  it("validates screenshot bytes, MIME, dimensions and preview bounds before accepting submission", async () => {
    const value = service();
    const original = await image();
    const result = value.request(request);
    const id = value.list()[0].id;
    await expect(
      value.respond(id, {
        status: "submitted",
        submission: { ...submitted, image: { ...original, data: "not base64!" } },
      }),
    ).rejects.toThrow("base64");
    await expect(
      value.respond(id, {
        status: "submitted",
        submission: { ...submitted, image: { ...original, mimeType: "image/jpeg" } },
      }),
    ).rejects.toThrow("do not match");
    await expect(
      value.respond(id, {
        status: "submitted",
        submission: { ...submitted, image: original, preview: { ...original, width: 10 } },
      }),
    ).rejects.toThrow("dimensions");
    await value.respond(id, { status: "submitted", submission: { ...submitted, image: original } });
    expect(await result).toMatchObject({ status: "submitted", submission: { image: original } });
    await expect(inspectVisualFeedbackImage(Buffer.from("not an image"))).rejects.toThrow();
    await expect(
      inspectVisualFeedbackImage(Buffer.alloc(VISUAL_FEEDBACK_MAX_IMAGE_BYTES + 1)),
    ).rejects.toThrow("8 MiB");
    await expect(
      inspectVisualFeedbackImage(Buffer.from(original.data, "base64").subarray(0, 45)),
    ).rejects.toThrow();
  });
});
