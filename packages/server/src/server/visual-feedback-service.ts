import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  VISUAL_FEEDBACK_MAX_IMAGE_BYTES,
  VISUAL_FEEDBACK_MAX_IMAGE_PIXELS,
  VisualFeedbackImageSchema,
  VisualFeedbackRequestSchema,
  VisualFeedbackResponseSchema,
  type VisualFeedbackImage,
  type VisualFeedbackRequest,
  type VisualFeedbackResponse,
  type VisualFeedbackSubmission,
} from "@omp-desktop/protocol/visual-feedback";

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const RASTER_MIME_TYPES: Record<string, VisualFeedbackImage["mimeType"]> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Decode, rather than trust MIME labels or headers supplied by a client. */
export async function inspectVisualFeedbackImage(bytes: Buffer): Promise<VisualFeedbackImage> {
  if (!bytes.length || bytes.length > VISUAL_FEEDBACK_MAX_IMAGE_BYTES) {
    throw new Error("Visual feedback image must be between 1 byte and 8 MiB");
  }
  // Native platform binaries must load only when this optional feature is invoked.
  const { default: sharp } = await import("sharp");
  const options = {
    limitInputPixels: VISUAL_FEEDBACK_MAX_IMAGE_PIXELS,
    failOn: "warning" as const,
  };
  const metadata = await sharp(bytes, options).metadata();
  const mimeType = metadata.format ? RASTER_MIME_TYPES[metadata.format] : undefined;
  if (!mimeType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
    throw new Error("Visual feedback supports single-frame PNG, JPEG, or WebP images only");
  }
  // Browsers display EXIF-oriented images; coordinates follow that visible pixel plane.
  const swapAxes = (metadata.orientation ?? 1) >= 5;
  const image = VisualFeedbackImageSchema.parse({
    data: bytes.toString("base64"),
    mimeType,
    width: swapAxes ? metadata.height : metadata.width,
    height: swapAxes ? metadata.width : metadata.height,
  });
  // Force a complete bounded decode to reject truncated/corrupt image payloads.
  await sharp(bytes, options).stats();
  return image;
}

export async function readVisualFeedbackImage(filePath: string): Promise<VisualFeedbackImage> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > VISUAL_FEEDBACK_MAX_IMAGE_BYTES) {
      throw new Error("Visual feedback image must be a raster file no larger than 8 MiB");
    }
    const bytes = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    return await inspectVisualFeedbackImage(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

async function validateImage(image: VisualFeedbackImage): Promise<void> {
  VisualFeedbackImageSchema.parse(image);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) {
    throw new Error("Invalid image base64");
  }
  const actual = await inspectVisualFeedbackImage(Buffer.from(image.data, "base64"));
  if (
    actual.width !== image.width ||
    actual.height !== image.height ||
    actual.mimeType !== image.mimeType
  ) {
    throw new Error("Image dimensions or MIME type do not match its contents");
  }
}

function validateAnnotations(
  submission: VisualFeedbackSubmission,
  image?: VisualFeedbackImage,
): void {
  if (submission.annotations.length && !image) throw new Error("Annotations require an image");
  if (!image) return;
  const point = (x: number, y: number) => {
    if (x > image.width || y > image.height) throw new Error("Annotation is outside the image");
  };
  const ids = new Set<string>();
  for (const annotation of submission.annotations) {
    if (ids.has(annotation.id)) throw new Error("Annotation IDs must be unique");
    ids.add(annotation.id);
    if (annotation.kind === "pen") {
      for (const value of annotation.points) point(value.x, value.y);
    } else {
      point(annotation.x, annotation.y);
      if (annotation.kind === "rectangle")
        point(annotation.x + annotation.width, annotation.y + annotation.height);
      if (annotation.kind === "arrow") point(annotation.x2, annotation.y2);
    }
  }
}

interface PendingRequest {
  request: VisualFeedbackRequest;
  finish(response: VisualFeedbackResponse): void;
}

/** Daemon-scoped: disconnecting an editor does not discard requests needed on reconnect. */
export class VisualFeedbackService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(requests: VisualFeedbackRequest[]) => void>();
  private closed = false;

  list(): VisualFeedbackRequest[] {
    return [...this.pending.values()].map(({ request }) => structuredClone(request));
  }

  subscribe(listener: (requests: VisualFeedbackRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(
    input: Omit<VisualFeedbackRequest, "id">,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<VisualFeedbackResponse> {
    if (this.closed) throw new Error("Visual feedback service is closed");
    const request = VisualFeedbackRequestSchema.parse({ ...input, id: randomUUID() });
    if (request.image) await validateImage(request.image);
    if (this.closed || options.signal?.aborted) return { status: "cancelled" };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? MAX_TIMEOUT_MS));
    if (!Number.isFinite(timeoutMs)) throw new Error("Invalid visual feedback timeout");
    const { promise, resolve } = Promise.withResolvers<VisualFeedbackResponse>();
    const abort = () => finish({ status: "cancelled" });
    const finish = (response: VisualFeedbackResponse) => {
      if (!this.pending.delete(request.id)) return;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(response);
      this.broadcast();
    };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    this.pending.set(request.id, { request, finish });
    options.signal?.addEventListener("abort", abort, { once: true });
    this.broadcast();
    return promise;
  }

  async respond(id: string, input: VisualFeedbackResponse): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Visual feedback request is no longer pending");
    const response = VisualFeedbackResponseSchema.parse(input);
    if (response.status === "submitted") {
      const submission = response.submission;
      const image = submission.image;
      const known = pending.request.image;
      if (
        image &&
        (!known ||
          image.data !== known.data ||
          image.mimeType !== known.mimeType ||
          image.width !== known.width ||
          image.height !== known.height)
      ) {
        await validateImage(image);
      }
      validateAnnotations(submission, image);
      if (submission.preview) {
        const preview = submission.preview;
        if (
          !image ||
          preview.width > image.width ||
          preview.height > image.height ||
          Math.abs(preview.width * image.height - preview.height * image.width) >
            Math.max(image.width, image.height)
        ) {
          throw new Error(
            "Annotated preview must preserve the original image aspect ratio and not exceed its dimensions",
          );
        }
        await validateImage(preview);
      }
    }
    // Validation may yield; only the first valid response may complete a live request.
    if (this.pending.get(id) !== pending)
      throw new Error("Visual feedback request is no longer pending");
    pending.finish(response);
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish({ status: "cancelled" });
    this.listeners.clear();
  }

  private broadcast(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.list());
      } catch {
        /* A disconnected observer cannot interrupt resolution. */
      }
    }
  }
}
