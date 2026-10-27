import type { VisualFeedbackSubmission } from "@omp-desktop/protocol/visual-feedback";
import type { ComposerAttachment } from "@/attachments/types";
import { persistAttachmentFromDataUrl } from "@/attachments/service";

export async function prepareVisualFeedbackMessage(
  submission: VisualFeedbackSubmission,
): Promise<{ text: string; attachments: ComposerAttachment[] }> {
  const attachments: ComposerAttachment[] = [];
  for (const [name, image] of [
    ["original", submission.image],
    ["annotated", submission.preview],
  ] as const) {
    if (!image) continue;
    const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
    const metadata = await persistAttachmentFromDataUrl({
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      fileName: `visual-feedback-${name}.${extension}`,
    });
    attachments.push({ kind: "image", metadata });
  }
  return {
    text: JSON.stringify(
      {
        schemaVersion: "omp-visual-feedback-1",
        coordinateSpace: "original-image-pixels",
        text: submission.text,
        feedback: submission.feedback,
        image: submission.image
          ? {
              width: submission.image.width,
              height: submission.image.height,
              attachment: "original",
            }
          : null,
        preview: submission.preview ? { attachment: "annotated" } : null,
        annotations: submission.annotations.map((annotation, index) => ({
          number: index + 1,
          ...annotation,
        })),
      },
      null,
      2,
    ),
    attachments,
  };
}
