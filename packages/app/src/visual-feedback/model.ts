import type {
  VisualFeedbackAnnotation,
  VisualFeedbackImage,
} from "@omp-desktop/protocol/visual-feedback";

export interface Point {
  x: number;
  y: number;
}
export type DrawingTool = "point" | "rectangle" | "arrow" | "pen";
export type EditorTool = DrawingTool | "select";
export const MAX_ANNOTATIONS = 200;
export const MAX_PEN_POINTS = 5000;
export const EMPTY_HISTORY: AnnotationHistory = { past: [], present: [], future: [] };
export function isFeedbackCancellation(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"
  );
}
export interface AnnotationHistory {
  past: VisualFeedbackAnnotation[][];
  present: VisualFeedbackAnnotation[];
  future: VisualFeedbackAnnotation[][];
}
export function commitAnnotations(
  history: AnnotationHistory,
  next: VisualFeedbackAnnotation[],
): AnnotationHistory {
  if (history.present === next) return history;
  return { past: [...history.past.slice(-99), history.present], present: next, future: [] };
}
export function undoAnnotations(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}
export function redoAnnotations(history: AnnotationHistory): AnnotationHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
export function clampPoint(
  point: Point,
  image: Pick<VisualFeedbackImage, "width" | "height">,
): Point {
  return {
    x: Math.max(0, Math.min(image.width, point.x)),
    y: Math.max(0, Math.min(image.height, point.y)),
  };
}
/** The rendered image bounds, not the scroll viewport, define image coordinates. */
export function imagePoint(
  client: Point,
  bounds: { left: number; top: number; width: number; height: number },
  image: Pick<VisualFeedbackImage, "width" | "height">,
): Point {
  return clampPoint(
    {
      x: ((client.x - bounds.left) * image.width) / bounds.width,
      y: ((client.y - bounds.top) * image.height) / bounds.height,
    },
    image,
  );
}
export function rectangleBetween(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(0.5, Math.abs(end.x - start.x)),
    height: Math.max(0.5, Math.abs(end.y - start.y)),
  };
}
export function createAnnotation(
  kind: DrawingTool,
  start: Point,
  end: Point,
  id: string,
  points: Point[] = [start, end],
): VisualFeedbackAnnotation {
  const fields = { id, text: "" };
  if (kind === "point") return { ...fields, kind, ...end };
  if (kind === "rectangle") return { ...fields, kind, ...rectangleBetween(start, end) };
  if (kind === "arrow") return { ...fields, kind, ...start, x2: end.x, y2: end.y };
  return { ...fields, kind, points: points.slice(0, MAX_PEN_POINTS) };
}
export function annotationAnchor(annotation: VisualFeedbackAnnotation): Point {
  return annotation.kind === "pen" ? annotation.points[0]! : { x: annotation.x, y: annotation.y };
}
export function annotationBounds(annotation: VisualFeedbackAnnotation) {
  if (annotation.kind === "rectangle")
    return { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height };
  if (annotation.kind === "point") return { x: annotation.x, y: annotation.y, width: 0, height: 0 };
  const points =
    annotation.kind === "pen"
      ? annotation.points
      : [
          { x: annotation.x, y: annotation.y },
          { x: annotation.x2, y: annotation.y2 },
        ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function moveAnnotation(
  annotation: VisualFeedbackAnnotation,
  delta: Point,
  image: Pick<VisualFeedbackImage, "width" | "height">,
): VisualFeedbackAnnotation {
  const bounds = annotationBounds(annotation);
  const dx = Math.max(-bounds.x, Math.min(image.width - bounds.x - bounds.width, delta.x));
  const dy = Math.max(-bounds.y, Math.min(image.height - bounds.y - bounds.height, delta.y));
  if (annotation.kind === "pen")
    return {
      ...annotation,
      points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    };
  if (annotation.kind === "arrow")
    return {
      ...annotation,
      x: annotation.x + dx,
      y: annotation.y + dy,
      x2: annotation.x2 + dx,
      y2: annotation.y2 + dy,
    };
  return { ...annotation, x: annotation.x + dx, y: annotation.y + dy };
}
export function resizeRectangle(
  annotation: Extract<VisualFeedbackAnnotation, { kind: "rectangle" }>,
  point: Point,
  image: Pick<VisualFeedbackImage, "width" | "height">,
): VisualFeedbackAnnotation {
  const end = clampPoint(point, image);
  return {
    ...annotation,
    width: Math.max(0.5, end.x - annotation.x),
    height: Math.max(0.5, end.y - annotation.y),
  };
}
export function arrowHead(start: Point, end: Point, size: number): [Point, Point] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  return [
    {
      x: end.x - size * Math.cos(angle - Math.PI / 6),
      y: end.y - size * Math.sin(angle - Math.PI / 6),
    },
    {
      x: end.x - size * Math.cos(angle + Math.PI / 6),
      y: end.y - size * Math.sin(angle + Math.PI / 6),
    },
  ];
}
