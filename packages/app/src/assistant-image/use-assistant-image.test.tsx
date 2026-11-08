// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ImageLoadEvent } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAssistantImageMetadataCache,
  setAssistantImageMetadata,
} from "@/utils/assistant-image-metadata";
import { useAssistantImage } from "./use-assistant-image";
import { getImagePreviewResidencyStats } from "@/attachments/preview-resource";

const previewStore = vi.hoisted(() => ({
  resolvePreviewUrl: vi.fn<() => Promise<string>>(),
  releasePreviewUrl: vi.fn(),
}));

vi.mock("@/attachments/service", () => ({
  resolveAttachmentPreviewUrl: previewStore.resolvePreviewUrl,
  releaseAttachmentPreviewUrl: previewStore.releasePreviewUrl,
  persistAttachmentFromBytes: vi.fn(),
  persistAttachmentFromDataUrl: vi.fn(),
}));

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

beforeEach(() => {
  clearAssistantImageMetadataCache();
  previewStore.resolvePreviewUrl.mockReset();
  previewStore.releasePreviewUrl.mockReset();
});
afterEach(cleanup);

const portraitLoad = {
  nativeEvent: { source: { width: 600, height: 1200 } },
} as ImageLoadEvent;

describe("assistant image geometry across visibility changes", () => {
  it("keeps dimensions learned on load while releasing and reacquiring its image", () => {
    const source = "https://example.com/visibility-portrait.png";
    const renders: Array<{ visible: boolean; aspectRatio: number | null }> = [];
    const { result, rerender } = renderHook(
      ({ visible }) => {
        const image = useAssistantImage({ source, occurrenceKey: "portrait", previewWidth: 600, visible });
        if (image.status !== "failed") {
          renders.push({ visible, aspectRatio: image.aspectRatio });
        }
        return image;
      },
      { initialProps: { visible: true } },
    );
    const binding = result.current.status !== "failed" ? result.current.binding : null;
    expect(binding).not.toBeNull();
    act(() => binding!.onLoad(portraitLoad));
    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 0.5 });

    renders.length = 0;
    rerender({ visible: false });
    expect(result.current).toEqual({ status: "loading", binding: null, aspectRatio: 0.5 });
    rerender({ visible: true });
    expect(renders.every((image) => image.aspectRatio === 0.5)).toBe(true);
    expect(result.current).toMatchObject({ status: "loading", aspectRatio: 0.5 });
  });

  it("uses cached dimensions during the first visible render before a preview is bound", () => {
    const source = "https://example.com/cached-portrait.png";
    setAssistantImageMetadata({ source }, { width: 600, height: 1200 });
    const observed: Array<number | null> = [];
    const { rerender } = renderHook(
      ({ visible }) => {
        const image = useAssistantImage({ source, occurrenceKey: "cached", previewWidth: 600, visible });
        if (image.status !== "failed") observed.push(image.aspectRatio);
        return image;
      },
      { initialProps: { visible: false } },
    );
    rerender({ visible: true });
    expect(observed.every((aspectRatio) => aspectRatio === 0.5)).toBe(true);
  });

  it("does not reuse the previous source's dimensions when the source changes", () => {
    const { result, rerender } = renderHook(
      ({ source, visible }) => useAssistantImage({ source, occurrenceKey: "replaced", previewWidth: 600, visible }),
      { initialProps: { source: "https://example.com/old-portrait.png", visible: true } },
    );
    const binding = result.current.status !== "failed" ? result.current.binding : null;
    act(() => binding!.onLoad(portraitLoad));
    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 0.5 });

    rerender({ source: "https://example.com/new-landscape.png", visible: false });
    expect(result.current).toEqual({ status: "loading", binding: null, aspectRatio: null });
  });

  it("retains learned geometry while a released blob preview is rebuilt asynchronously", async () => {
    const source = `omp-attachment:${encodeURIComponent(JSON.stringify({
      id: "async-portrait",
      mimeType: "image/png",
      storageType: "desktop-file",
      storageKey: "/images/async-portrait.png",
      byteSize: 100,
      createdAt: 0,
    }))}`;
    const first = Promise.withResolvers<string>();
    const rebuilt = Promise.withResolvers<string>();
    previewStore.resolvePreviewUrl
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(rebuilt.promise);
    const observed: Array<number | null> = [];
    const { result, rerender, unmount } = renderHook(
      ({ visible }) => {
        const image = useAssistantImage({ source, occurrenceKey: "async-portrait", previewWidth: 600, visible });
        if (image.status !== "failed") observed.push(image.aspectRatio);
        return image;
      },
      { initialProps: { visible: true } },
    );
    expect(result.current).toMatchObject({ status: "loading", binding: null, aspectRatio: null });
    await act(async () => first.resolve("blob:first"));
    const binding = result.current.status !== "failed" ? result.current.binding : null;
    expect(binding?.uri).toBe("blob:first");
    act(() => binding!.onLoad(portraitLoad));
    expect(result.current).toMatchObject({ status: "loaded", aspectRatio: 0.5 });
    expect(getImagePreviewResidencyStats().previews).toBe(1);

    observed.length = 0;
    rerender({ visible: false });
    expect(result.current).toEqual({ status: "loading", binding: null, aspectRatio: 0.5 });
    expect(getImagePreviewResidencyStats()).toEqual({ previews: 0, encodedBytes: 0, decodedBytes: 0 });

    rerender({ visible: true });
    expect(result.current).toEqual({ status: "loading", binding: null, aspectRatio: 0.5 });
    expect(getImagePreviewResidencyStats().previews).toBe(0);
    await act(async () => rebuilt.resolve("blob:rebuilt"));
    expect(result.current).toMatchObject({ status: "loading", binding: { uri: "blob:rebuilt" }, aspectRatio: 0.5 });
    expect(getImagePreviewResidencyStats().previews).toBe(1);
    expect(observed.every((aspectRatio) => aspectRatio === 0.5)).toBe(true);

    unmount();
    expect(getImagePreviewResidencyStats()).toEqual({ previews: 0, encodedBytes: 0, decodedBytes: 0 });
  });
});
