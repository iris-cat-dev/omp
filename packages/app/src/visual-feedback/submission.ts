import type { VisualFeedbackSubmission } from "@omp-desktop/protocol/visual-feedback";
import type { AttachmentMetadata, VisualFeedbackComposerAttachment } from "@/attachments/types";
import { deleteAttachments, persistAttachmentFromDataUrl } from "@/attachments/service";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { generateAttachmentId } from "@/attachments/utils";

export async function prepareVisualFeedbackAttachment(
  submission: VisualFeedbackSubmission,
): Promise<VisualFeedbackComposerAttachment> {
  const attachment: VisualFeedbackComposerAttachment = {
    kind: "visual_feedback",
    id: generateAttachmentId(),
    text: submission.text,
    feedback: submission.feedback,
    annotations: submission.annotations,
  };
  const persisted: AttachmentMetadata[] = [];
  const releases: Array<() => void> = [];
  try {
    for (const [key, name, image] of [
      ["image", "original", submission.image],
      ["preview", "annotated", submission.preview],
    ] as const) {
      if (!image) continue;
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
      const metadata = await persistAttachmentFromDataUrl({
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        mimeType: image.mimeType,
        fileName: `visual-feedback-${name}.${extension}`,
      });
      persisted.push(metadata);
      // The first image is not in a draft while the second image is being saved.
      releases.push(retainAttachmentForGarbageCollection(metadata.id));
      attachment[key] = { metadata, width: image.width, height: image.height };
    }
    return attachment;
  } catch (error) {
    await deleteAttachments(persisted);
    throw error;
  } finally {
    for (const release of releases) release();
  }
}
