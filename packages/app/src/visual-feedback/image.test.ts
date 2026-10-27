import { describe, expect, it } from "vitest";
import {
  VISUAL_FEEDBACK_MAX_IMAGE_BYTES,
  type VisualFeedbackImage,
} from "@omp-desktop/protocol/visual-feedback";
import { importImage, loadImage } from "./image.web";

// These rejection paths are pure: they must reject before invoking any browser decoder.
describe("image import boundaries", () => {
  it("rejects unsupported formats before reading file contents", async () => {
    await expect(importImage({ type: "image/svg+xml", size: 100 } as File)).rejects.toThrow(
      "invalidImage",
    );
    await expect(importImage({ type: "image/gif", size: 100 } as File)).rejects.toThrow(
      "invalidImage",
    );
  });
  it("enforces the shared byte limit and rejects empty files", async () => {
    await expect(
      importImage({ type: "image/png", size: VISUAL_FEEDBACK_MAX_IMAGE_BYTES + 1 } as File),
    ).rejects.toThrow("invalidImage");
    await expect(importImage({ type: "image/png", size: 0 } as File)).rejects.toThrow(
      "invalidImage",
    );
  });
  it("rejects mislabeled vector and animated images before browser decoding", async () => {
    await expect(
      importImage(
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],
          "renamed.png",
          { type: "image/png" },
        ),
      ),
    ).rejects.toThrow("invalidImage");
    await expect(
      importImage(new File(["GIF89a"], "renamed.jpg", { type: "image/jpeg" })),
    ).rejects.toThrow("invalidImage");
  });
  it("rejects malformed base64 and out-of-range dimensions before decoding", async () => {
    const image: VisualFeedbackImage = {
      data: "!!!!",
      mimeType: "image/png",
      width: 100,
      height: 100,
    };
    await expect(loadImage(image)).rejects.toThrow("invalidImage");
    await expect(loadImage({ ...image, data: "AA==", width: 32769 })).rejects.toThrow(
      "invalidImage",
    );
    await expect(loadImage({ ...image, data: "AA==", height: 0 })).rejects.toThrow("invalidImage");
    await expect(loadImage({ ...image, data: "AA==", width: 8192, height: 8192 })).rejects.toThrow(
      "invalidImage",
    );
  });
});
