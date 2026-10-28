import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment } from "@/composer/types";
import {
  isWorkspaceAttachment,
  workspaceAttachmentToSubmitAttachment,
} from "@/attachments/workspace-attachment-utils";
import type { AgentAttachment } from "@omp-desktop/protocol/messages";
import {
  buildForgeAttachmentFromSearchItem,
  buildLegacyGitHubAttachmentFromSearchItem,
} from "@/utils/review-attachments";
import { directoryAttachmentToAgentAttachment } from "@/attachments/directory";
import { workspaceFileAttachmentToAgentAttachment } from "@/attachments/workspace-file";

export type ComposerAttachmentSubmitFormat = "forge" | "legacy-github";

interface SplitComposerAttachmentsOptions {
  format?: ComposerAttachmentSubmitFormat;
}

export function resolveComposerAttachmentSubmitFormat(input: {
  supportsForgeAttachments?: boolean;
}): ComposerAttachmentSubmitFormat {
  // COMPAT(forgeSearch): added in v0.1.106, remove github_search fallback after 2026-12-28.
  return input.supportsForgeAttachments === false ? "legacy-github" : "forge";
}

export function splitComposerAttachmentsForSubmit(
  attachments: ComposerAttachment[],
  options: SplitComposerAttachmentsOptions = {},
): {
  images: ImageAttachment[];
  attachments: AgentAttachment[];
} {
  const images: ImageAttachment[] = [];
  const agentAttachments: AgentAttachment[] = [];
  // COMPAT(forgeSearch): added in v0.1.106, remove github_search fallback after 2026-12-28.
  const buildSearchAttachment =
    options.format === "legacy-github"
      ? buildLegacyGitHubAttachmentFromSearchItem
      : buildForgeAttachmentFromSearchItem;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      images.push(attachment.metadata);
      continue;
    }

    if (attachment.kind === "visual_feedback") {
      const originalImageNumber = attachment.image
        ? images.push(attachment.image.metadata)
        : undefined;
      const previewImageNumber = attachment.preview
        ? images.push(attachment.preview.metadata)
        : undefined;
      agentAttachments.push({
        type: "text",
        mimeType: "text/plain",
        title: "Screenshot annotation",
        text: JSON.stringify(
          {
            schemaVersion: "omp-visual-feedback-1",
            coordinateSpace: "original-image-pixels",
            text: attachment.text,
            feedback: attachment.feedback,
            image: attachment.image
              ? {
                  width: attachment.image.width,
                  height: attachment.image.height,
                  attachment: "original",
                  imageNumber: originalImageNumber,
                }
              : null,
            preview: attachment.preview
              ? {
                  width: attachment.preview.width,
                  height: attachment.preview.height,
                  attachment: "annotated",
                  imageNumber: previewImageNumber,
                }
              : null,
            annotations: attachment.annotations.map((annotation, index) => ({
              number: index + 1,
              ...annotation,
            })),
          },
          null,
          2,
        ),
      });
      continue;
    }

    if (attachment.kind === "file") {
      agentAttachments.push(attachment.attachment);
      continue;
    }

    if (attachment.kind === "directory") {
      agentAttachments.push(directoryAttachmentToAgentAttachment(attachment));
      continue;
    }

    if (attachment.kind === "workspace_file") {
      agentAttachments.push(workspaceFileAttachmentToAgentAttachment(attachment));
      continue;
    }
    if (attachment.kind === "quoted_content") {
      agentAttachments.push({
        type: "text",
        mimeType: "text/plain",
        title: "Quoted content",
        text: attachment.text,
      });
      continue;
    }

    if (isWorkspaceAttachment(attachment)) {
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        images.push(attachment.attachment.screenshot);
      }
      const workspaceAttachment = workspaceAttachmentToSubmitAttachment(attachment);
      if (workspaceAttachment) {
        agentAttachments.push(workspaceAttachment);
      }
      continue;
    }

    const reviewAttachment = buildSearchAttachment(attachment.item);
    if (reviewAttachment) {
      agentAttachments.push(reviewAttachment);
    }
  }

  return {
    images,
    attachments: agentAttachments,
  };
}
