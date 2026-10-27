import {
  VISUAL_FEEDBACK_MAX_IMAGE_BYTES,
  VISUAL_FEEDBACK_MAX_IMAGE_PIXELS,
  VisualFeedbackImageSchema,
  type VisualFeedbackImage,
} from "@omp-desktop/protocol/visual-feedback";
import { getDesktopHost } from "@/desktop/host";
import { i18n } from "@/i18n/i18next";

export async function captureScreenshot(): Promise<VisualFeedbackImage> {
  const nativeCapture = getDesktopHost()?.screenshot?.capture;
  if (nativeCapture) {
    const image = await nativeCapture();
    if (!image) throw new DOMException("Screen capture cancelled", "AbortError");
    return VisualFeedbackImageSchema.parse(image);
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error(i18n.t("visualFeedback.captureError"));
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    ) {
      throw new DOMException("Screen capture cancelled", "AbortError");
    }
    throw error;
  }
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (typeof video.requestVideoFrameCallback === "function") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(i18n.t("visualFeedback.captureError"))),
          10000,
        );
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (
      !width ||
      !height ||
      width > 32768 ||
      height > 32768 ||
      width * height > VISUAL_FEEDBACK_MAX_IMAGE_PIXELS
    )
      throw new Error(i18n.t("visualFeedback.invalidImage"));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(i18n.t("visualFeedback.captureError"));
    context.drawImage(video, 0, 0);
    let dataUrl = canvas.toDataURL("image/png");
    const maxBase64 = Math.ceil(VISUAL_FEEDBACK_MAX_IMAGE_BYTES / 3) * 4;
    if (dataUrl.length > maxBase64 + 64) dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const comma = dataUrl.indexOf(",");
    return VisualFeedbackImageSchema.parse({
      data: dataUrl.slice(comma + 1),
      mimeType: dataUrl.startsWith("data:image/png;") ? "image/png" : "image/jpeg",
      width,
      height,
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  }
}
