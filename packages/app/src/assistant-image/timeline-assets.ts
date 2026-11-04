import type { StreamItem } from "@/types/stream";
import type { AttachmentMetadata } from "@/attachments/types";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { parseImageDataUrl } from "@/attachments/utils";
import * as Crypto from "expo-crypto";

export function containsTimelineImageAsset(value: unknown): boolean {
  if (typeof value === "string") return value.includes("omp-attachment:");
  if (!value || typeof value !== "object" || value instanceof Date) return false;
  return Object.values(value).some(containsTimelineImageAsset);
}

export const TIMELINE_IMAGE_ASSET_PREFIX = "omp-attachment:";
const dataImages = /data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g;
const assetImages = /omp-attachment:[a-zA-Z0-9%_.~-]+/g;
let persistenceTail: Promise<void> = Promise.resolve();

export function parseTimelineImageAsset(source: string): AttachmentMetadata | null {
  if (!source.startsWith(TIMELINE_IMAGE_ASSET_PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(source.slice(TIMELINE_IMAGE_ASSET_PREFIX.length))) as AttachmentMetadata;
    if (typeof value.id !== "string" || typeof value.storageKey !== "string" || typeof value.mimeType !== "string" || !["web-indexeddb", "desktop-file", "native-file"].includes(value.storageType)) return null;
    return value;
  } catch { return null; }
}

/** Persist once at the store boundary, not in each thumbnail/markdown consumer. */
export function persistTimelineImageAssets(item: StreamItem): Promise<StreamItem> {
  const run = async (): Promise<StreamItem> => {
    const replacements = new Map<string, string>();
    const persistSource = async (source: string): Promise<AttachmentMetadata> => {
      const parsed = parseImageDataUrl(source);
      if (!parsed) throw new Error("Invalid canonical image data URL");
      return await persistAttachmentFromDataUrl({
        id: `preview_sha256_${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, source)}`,
        mimeType: parsed.mimeType,
        dataUrl: source,
      });
    };
    const visit = async (value: unknown): Promise<unknown> => {
      if (typeof value === "string") {
        if (!value.includes("data:image/")) return value;
        for (const match of value.matchAll(dataImages)) {
          if (replacements.has(match[0]) || !parseImageDataUrl(match[0])) continue;
          const attachment = await persistSource(match[0]);
          const encoded = encodeURIComponent(JSON.stringify(attachment)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
          replacements.set(match[0], `${TIMELINE_IMAGE_ASSET_PREFIX}${encoded}`);
        }
        return value.replace(dataImages, (source) => replacements.get(source) ?? source);
      }
      if (!value || typeof value !== "object" || value instanceof Date) return value;
      if ("storageType" in value && value.storageType === "inline-data" && "storageKey" in value && typeof value.storageKey === "string" && "mimeType" in value) {
        const attachment = value as AttachmentMetadata;
        const source = `data:${attachment.mimeType};base64,${attachment.storageKey}`;
        if (!parseImageDataUrl(source)) return value;
        return { ...await persistSource(source), createdAt: attachment.createdAt, fileName: attachment.fileName };
      }
      if (Array.isArray(value)) {
        const next = [];
        let changed = false;
        for (const child of value) {
          const normalized = await visit(child);
          changed ||= normalized !== child;
          next.push(normalized);
        }
        return changed ? next : value;
      }
      const next: Record<string, unknown> = {};
      let changed = false;
      for (const [key, child] of Object.entries(value)) {
        const normalized = await visit(child);
        changed ||= normalized !== child;
        next[key] = normalized;
      }
      return changed ? next : value;
    };
    return await visit(item) as StreamItem;
  };
  const pending = persistenceTail.then(run);
  persistenceTail = pending.then(() => undefined, () => undefined);
  return pending;
}

export function retainTimelineImageAssets(item: StreamItem): () => void {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (!value.includes(TIMELINE_IMAGE_ASSET_PREFIX)) return;
      for (const match of value.matchAll(assetImages)) {
        const asset = parseTimelineImageAsset(match[0]);
        if (asset) ids.add(asset.id);
      }
    } else if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("storageType" in value && value.storageType !== "inline-data" && "id" in value && typeof value.id === "string") ids.add(value.id);
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(item);
  const releases = [...ids].map(retainAttachmentForGarbageCollection);
  return () => { for (const release of releases) release(); };
}
