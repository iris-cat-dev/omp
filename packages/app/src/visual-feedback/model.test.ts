import { describe, expect, it } from "vitest";
import {
  annotationBounds,
  arrowHead,
  clampPoint,
  commitAnnotations,
  createAnnotation,
  EMPTY_HISTORY,
  imagePoint,
  isFeedbackCancellation,
  MAX_PEN_POINTS,
  moveAnnotation,
  rectangleBetween,
  redoAnnotations,
  resizeRectangle,
  undoAnnotations,
} from "./model";

const image = { width: 1600, height: 900 };
const point = createAnnotation("point", { x: 10, y: 20 }, { x: 10, y: 20 }, "one");

describe("capture cancellation", () => {
  it("distinguishes explicit picker cancellation from actual failures", () => {
    expect(isFeedbackCancellation({ name: "AbortError" })).toBe(true);
    expect(isFeedbackCancellation(new Error("Capture failed"))).toBe(false);
    expect(isFeedbackCancellation({ name: "NotAllowedError" })).toBe(false);
    expect(isFeedbackCancellation(null)).toBe(false);
  });
});

describe("original-image coordinates", () => {
  it("converts a fitted image position without including viewport padding", () => {
    expect(
      imagePoint({ x: 320, y: 195 }, { left: 120, top: 95, width: 800, height: 450 }, image),
    ).toEqual({ x: 400, y: 200 });
  });
  it("converts a zoomed, scrolled image independently of its viewport", () => {
    expect(
      imagePoint({ x: 320, y: 195 }, { left: -480, top: -205, width: 3200, height: 1800 }, image),
    ).toEqual({ x: 400, y: 200 });
  });
  it("clamps captured pointer movement to the original image", () => {
    expect(
      imagePoint({ x: -20, y: 1000 }, { left: 0, top: 0, width: 800, height: 450 }, image),
    ).toEqual({ x: 0, y: 900 });
    expect(clampPoint({ x: 5000, y: -50 }, image)).toEqual({ x: 1600, y: 0 });
  });
});

describe("drawing and manipulation", () => {
  it("normalizes rectangles drawn backwards", () => {
    expect(rectangleBetween({ x: 150, y: 100 }, { x: 50, y: 20 })).toEqual({
      x: 50,
      y: 20,
      width: 100,
      height: 80,
    });
  });
  it("retains arrow endpoints and pen geometry in image pixels", () => {
    expect(createAnnotation("arrow", { x: 1, y: 2 }, { x: 40, y: 50 }, "arrow")).toEqual({
      id: "arrow",
      text: "",
      kind: "arrow",
      x: 1,
      y: 2,
      x2: 40,
      y2: 50,
    });
    const points = Array.from({ length: MAX_PEN_POINTS + 1 }, (_, i) => ({ x: i, y: 2 }));
    const pen = createAnnotation("pen", points[0]!, points[1]!, "pen", points);
    expect(pen.kind === "pen" && pen.points.length).toBe(MAX_PEN_POINTS);
    points[0] = { x: 9, y: 9 };
    expect(pen.kind === "pen" && pen.points[0]).toEqual({ x: 0, y: 2 });
  });
  it("moves a rectangle as a rigid shape and never mutates the source", () => {
    const rectangle = createAnnotation("rectangle", { x: 100, y: 100 }, { x: 300, y: 250 }, "rect");
    expect(moveAnnotation(rectangle, { x: 5000, y: -5000 }, image)).toMatchObject({
      x: 1400,
      y: 0,
      width: 200,
      height: 150,
    });
    expect(rectangle).toMatchObject({ x: 100, y: 100 });
  });
  it("moves both arrow endpoints and every freehand vertex together", () => {
    const arrow = createAnnotation("arrow", { x: 20, y: 30 }, { x: 100, y: 50 }, "arrow");
    expect(moveAnnotation(arrow, { x: -100, y: 10 }, image)).toMatchObject({
      x: 0,
      y: 40,
      x2: 80,
      y2: 60,
    });
    const pen = createAnnotation("pen", { x: 10, y: 20 }, { x: 40, y: 50 }, "pen");
    expect(moveAnnotation(pen, { x: 5, y: 8 }, image)).toMatchObject({
      points: [
        { x: 15, y: 28 },
        { x: 45, y: 58 },
      ],
    });
    expect(annotationBounds(pen)).toEqual({ x: 10, y: 20, width: 30, height: 30 });
  });
  it("resizes a rectangle from its fixed top-left and clamps the handle", () => {
    const rectangle = {
      id: "rect",
      kind: "rectangle" as const,
      text: "",
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    };
    expect(resizeRectangle(rectangle, { x: 1700, y: 1000 }, image)).toMatchObject({
      x: 100,
      y: 50,
      width: 1500,
      height: 850,
    });
    expect(resizeRectangle(rectangle, { x: 0, y: 0 }, image)).toMatchObject({
      width: 0.5,
      height: 0.5,
    });
  });
  it("computes symmetric arrowhead wings", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(-b.y);
    expect(a.x).toBeLessThan(100);
  });
});

describe("annotation edit history", () => {
  it("undoes and redoes add, note edit, and deletion", () => {
    const added = commitAnnotations(EMPTY_HISTORY, [point]);
    const edited = commitAnnotations(added, [{ ...point, text: "Move this" }]);
    const deleted = commitAnnotations(edited, []);
    const undoDelete = undoAnnotations(deleted);
    expect(undoDelete.present[0]?.text).toBe("Move this");
    expect(undoAnnotations(undoDelete).present).toEqual([point]);
    expect(undoAnnotations(undoAnnotations(undoDelete)).present).toEqual([]);
    expect(redoAnnotations(undoDelete).present).toEqual([]);
    expect(redoAnnotations(undoAnnotations(edited)).present).toEqual(edited.present);
  });
  it("discards redo after a new edit and keeps history bounded", () => {
    let history = commitAnnotations(EMPTY_HISTORY, [point]);
    history = commitAnnotations(history, []);
    history = commitAnnotations(undoAnnotations(history), [{ ...point, text: "New branch" }]);
    expect(history.future).toEqual([]);
    for (let index = 0; index < 150; index++)
      history = commitAnnotations(history, [{ ...point, text: String(index) }]);
    expect(history.past).toHaveLength(100);
    expect(undoAnnotations(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
    expect(redoAnnotations(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
  });
});
