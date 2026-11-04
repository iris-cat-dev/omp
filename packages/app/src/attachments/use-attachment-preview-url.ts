import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { acquireAttachmentPreviewResource } from "@/attachments/preview-resource";

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
  maxEdge?: number,
): string | null {
  const [entry, setEntry] = useState<{ id: string; storageKey: string; uri: string } | null>(null);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    const current = attachmentRef.current;
    if (!current) { setEntry(null); return; }
    void acquireAttachmentPreviewResource(current, maxEdge).then((resource) => {
      if (disposed) { resource.release(); return; }
      release = resource.release;
      setEntry({ id: current.id, storageKey: current.storageKey, uri: resource.uri });
    }).catch((error) => {
      console.error("[attachments] Failed to resolve preview URL", { attachmentId: current.id, error });
      if (!disposed) setEntry(null);
    });
    return () => { disposed = true; release?.(); };
  }, [id, storageType, storageKey, mimeType, maxEdge]);
  return attachment && entry && entry.id === id && entry.storageKey === storageKey ? entry.uri : null;
}
