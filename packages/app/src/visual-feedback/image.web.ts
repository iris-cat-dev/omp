import {
  VISUAL_FEEDBACK_MAX_IMAGE_BYTES,
  VisualFeedbackImageSchema,
  type VisualFeedbackAnnotation,
  type VisualFeedbackImage,
} from "@omp-desktop/protocol/visual-feedback";
import { annotationAnchor, arrowHead } from "./model";

export function imageDataUrl(image: VisualFeedbackImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
function base64Bytes(data: string): number {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error("invalidImage");
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return (data.length / 4) * 3 - padding;
}

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const element = new Image();
  element.src = url;
  try {
    await element.decode();
    return element;
  } catch {
    throw new Error("imageLoadError");
  }
}

export async function loadImage(image: VisualFeedbackImage): Promise<HTMLImageElement> {
  const parsed = VisualFeedbackImageSchema.safeParse(image);
  if (!parsed.success || base64Bytes(image.data) > VISUAL_FEEDBACK_MAX_IMAGE_BYTES)
    throw new Error("invalidImage");
  const element = await decodeImage(imageDataUrl(image));
  if (element.naturalWidth !== image.width || element.naturalHeight !== image.height)
    throw new Error("invalidImage");
  return element;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function matchesImageType(header: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png")
    return PNG_SIGNATURE.every((value, index) => header[index] === value);
  if (mimeType === "image/jpeg") return header[0] === 255 && header[1] === 216 && header[2] === 255;
  return (
    header[0] === 82 &&
    header[1] === 73 &&
    header[2] === 70 &&
    header[3] === 70 &&
    header[8] === 87 &&
    header[9] === 69 &&
    header[10] === 66 &&
    header[11] === 80
  );
}
export async function importImage(file: File): Promise<VisualFeedbackImage> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size === 0 ||
    file.size > VISUAL_FEEDBACK_MAX_IMAGE_BYTES
  )
    throw new Error("invalidImage");
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!matchesImageType(header, file.type)) throw new Error("invalidImage");
  const fileRead = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.addEventListener("load", () => fileRead.resolve(String(reader.result)), { once: true });
  reader.addEventListener("error", () => fileRead.reject(new Error("imageLoadError")), {
    once: true,
  });
  reader.addEventListener(
    "abort",
    () => fileRead.reject(new DOMException("Cancelled", "AbortError")),
    { once: true },
  );
  reader.readAsDataURL(file);
  const dataUrl = await fileRead.promise;
  const url = URL.createObjectURL(file);
  try {
    const element = await decodeImage(url);
    const image = {
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mimeType: file.type,
      width: element.naturalWidth,
      height: element.naturalHeight,
    };
    const parsed = VisualFeedbackImageSchema.safeParse(image);
    if (!parsed.success) throw new Error("invalidImage");
    return parsed.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Export is bounded to a 4096px edge; annotation coordinates remain original pixels. */
export async function exportPreview(
  image: VisualFeedbackImage,
  annotations: VisualFeedbackAnnotation[],
): Promise<VisualFeedbackImage> {
  const source = await loadImage(image);
  const scale = Math.min(1, 4096 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("previewError");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / image.width, canvas.height / image.height);
    const unit = Math.max(1, Math.max(image.width, image.height) / 1400);
    context.strokeStyle = "#e5484d";
    context.lineWidth = 3 * unit;
    context.lineJoin = "round";
    context.lineCap = "round";
    annotations.forEach((annotation, index) => {
      context.beginPath();
      if (annotation.kind === "rectangle")
        context.rect(annotation.x, annotation.y, annotation.width, annotation.height);
      if (annotation.kind === "arrow") {
        const end = { x: annotation.x2, y: annotation.y2 };
        const [a, b] = arrowHead(annotation, end, 15 * unit);
        context.moveTo(annotation.x, annotation.y);
        context.lineTo(end.x, end.y);
        context.moveTo(a.x, a.y);
        context.lineTo(end.x, end.y);
        context.lineTo(b.x, b.y);
      }
      if (annotation.kind === "pen") {
        annotation.points.forEach((point, i) =>
          i === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y),
        );
      }
      context.stroke();
      const anchor = annotationAnchor(annotation);
      const radius = Math.min(12 * unit, image.width / 2, image.height / 2);
      const x = Math.max(radius, Math.min(image.width - radius, anchor.x));
      const y = Math.max(radius, Math.min(image.height - radius, anchor.y));
      context.beginPath();
      context.arc(x, y, radius, 0, 2 * Math.PI);
      context.fillStyle = "#e5484d";
      context.fill();
      context.lineWidth = 2 * unit;
      context.strokeStyle = "#ffffff";
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = `bold ${12 * unit}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), x, y);
      context.lineWidth = 3 * unit;
      context.strokeStyle = "#e5484d";
    });
    for (const [mimeType, quality] of [
      ["image/png", 1],
      ["image/jpeg", 0.9],
      ["image/jpeg", 0.7],
      ["image/jpeg", 0.5],
    ] as const) {
      const data = canvas.toDataURL(mimeType, quality).split(",")[1];
      if (data && base64Bytes(data) <= VISUAL_FEEDBACK_MAX_IMAGE_BYTES)
        return { data, mimeType, width: canvas.width, height: canvas.height };
    }
    throw new Error("previewError");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
