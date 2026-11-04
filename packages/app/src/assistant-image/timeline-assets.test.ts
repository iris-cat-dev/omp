import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { StreamItem } from "@/types/stream";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: async (_algorithm: string, text: string) => createHash("sha256").update(text).digest("hex"),
}));
const { persist } = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("@/attachments/service", () => ({ persistAttachmentFromDataUrl: persist }));
import { parseTimelineImageAsset, persistTimelineImageAssets, retainTimelineImageAssets } from "./timeline-assets";

afterEach(() => { persist.mockReset(); });

const source = "data:image/png;base64,AAEC";
function message(): StreamItem {
  return { kind: "assistant_message", id: "image", text: `![one](${source}) ![two](${source})`, timestamp: new Date(0), timelineCursor: { epoch: "epoch", seq: 1 } };
}

describe("persistent timeline image assets", () => {
  it("deduplicates embedded bytes into reloadable references without retaining base64", async () => {
    persist.mockImplementation(async ({ id, mimeType }) => ({ id, mimeType, storageType: "desktop-file", storageKey: "/assets/image(1).png", createdAt: 0, byteSize: 3 }));
    const original = message();
    const normalized = await persistTimelineImageAssets(original);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(normalized.kind).toBe("assistant_message");
    if (normalized.kind !== "assistant_message") throw new Error("unexpected item kind");
    expect(normalized.text).not.toContain("AAEC");
    const urls = normalized.text.match(/omp-attachment:[a-zA-Z0-9%_.~-]+/g)!;
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    const asset = parseTimelineImageAsset(urls[0]!);
    expect(asset?.storageKey).toBe("/assets/image(1).png");
    const release = retainTimelineImageAssets(normalized);
    expect(collectRetainedAttachmentIds()).toContain(asset?.id);
    release();
    expect(collectRetainedAttachmentIds()).not.toContain(asset?.id);
    expect(original.kind === "assistant_message" && original.text).toContain(source);
    expect(await persistTimelineImageAssets(normalized)).toBe(normalized);
  });

  it("keeps the original canonical bytes after storage failure and retries later", async () => {
    persist.mockRejectedValueOnce(new Error("storage unavailable"));
    const original = message();
    await expect(persistTimelineImageAssets(original)).rejects.toThrow("storage unavailable");
    expect(original.kind === "assistant_message" && original.text).toContain(source);
    persist.mockImplementation(async ({ id, mimeType }) => ({ id, mimeType, storageType: "web-indexeddb", storageKey: id, createdAt: 0 }));
    expect(await persistTimelineImageAssets(original)).not.toBe(original);
  });
});
