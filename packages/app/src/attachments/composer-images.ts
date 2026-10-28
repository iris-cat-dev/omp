import type { AttachmentMetadata, ComposerAttachment } from "./types";

/** Image bytes owned or referenced by a composer attachment. */
export function getComposerAttachmentImages(attachment: ComposerAttachment): AttachmentMetadata[] {
  if (attachment.kind === "image") {
    return [attachment.metadata];
  }
  if (attachment.kind === "visual_feedback") {
    const images: AttachmentMetadata[] = [];
    if (attachment.image) images.push(attachment.image.metadata);
    if (attachment.preview) images.push(attachment.preview.metadata);
    return images;
  }
  if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
    return [attachment.attachment.screenshot];
  }
  return [];
}
