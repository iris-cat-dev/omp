import type { VisualFeedbackImage } from "@omp-desktop/protocol/visual-feedback";
import { ZodError } from "zod";

type EditorStage = "export-preview" | "validate-submission" | "submit";
type CallbackStage = "save-original" | "save-preview" | "stage-draft" | "reply-to-host";

export class VisualFeedbackSubmitError extends Error {
  constructor(
    readonly stage: CallbackStage,
    cause: unknown,
  ) {
    super("Visual feedback submission step failed", { cause });
  }
}

const errorName =
  /^(?:AbortError|DataCloneError|EncodingError|InvalidStateError|NetworkError|NotAllowedError|NotFoundError|NotReadableError|QuotaExceededError|RangeError|SecurityError|TimeoutError|TypeError|UnknownError)$/;
const errorCode =
  /\b(?:EACCES|EBUSY|ECONNREFUSED|ECONNRESET|EDQUOT|EIO|EMFILE|ENOENT|ENOSPC|EPERM|EROFS|ETIMEDOUT)\b/;
const imageError = /^(?:previewError|imageLoadError|invalidImage)$/;
const validationField =
  /^(?:text|feedback|annotations|image|preview|data|mimeType|width|height|id|kind|x|y|x2|y2|points)$/;

function describeError(cause: unknown) {
  if (cause instanceof ZodError) {
    return {
      name: "ZodError",
      issues: cause.issues.slice(0, 8).map(({ code, path }) => ({
        code,
        path: path.map((part) =>
          typeof part === "number" || (typeof part === "string" && validationField.test(part))
            ? part
            : "?",
        ),
      })),
    };
  }
  if (!(cause instanceof Error)) return { name: "NonError" };
  // Desktop IPC can flatten filesystem errors into a message that also contains the local path.
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
  const knownCode =
    imageError.exec(cause.message)?.[0] ??
    errorCode.exec(code)?.[0] ??
    errorCode.exec(cause.message)?.[0];
  return { name: errorName.exec(cause.name)?.[0] ?? "Error", code: knownCode };
}

function describeImage(image: VisualFeedbackImage | undefined) {
  if (!image) return undefined;
  const data = typeof image.data === "string" ? image.data : undefined;
  let padding = 0;
  if (data?.endsWith("==")) padding = 2;
  else if (data?.endsWith("=")) padding = 1;
  return {
    width: Number.isFinite(image.width) ? image.width : undefined,
    height: Number.isFinite(image.height) ? image.height : undefined,
    bytes: data === undefined ? undefined : Math.floor((data.length * 3) / 4) - padding,
    mimeType:
      image.mimeType === "image/png" ||
      image.mimeType === "image/jpeg" ||
      image.mimeType === "image/webp"
        ? image.mimeType
        : undefined,
  };
}

export function logVisualFeedbackSubmitFailure(input: {
  stage: EditorStage;
  cause: unknown;
  annotationCount: number;
  image?: VisualFeedbackImage;
  preview?: VisualFeedbackImage;
}): void {
  const { cause } = input;
  const stepError = cause instanceof VisualFeedbackSubmitError ? cause : undefined;
  // Emit a single string so the desktop renderer-console bridge retains the fields in main.log.
  // Do not print arbitrary messages or stacks; they can contain text, paths, URLs, or image data.
  console.error(
    `[visual-feedback] Submit failed ${JSON.stringify({
      stage: stepError?.stage ?? input.stage,
      annotationCount: input.annotationCount,
      image: describeImage(input.image),
      preview: describeImage(input.preview),
      error: describeError(stepError ? stepError.cause : cause),
    })}`,
  );
}
