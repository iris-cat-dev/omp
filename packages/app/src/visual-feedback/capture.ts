import type { VisualFeedbackImage } from "@omp-desktop/protocol/visual-feedback";
import { i18n } from "@/i18n/i18next";

export async function captureScreenshot(): Promise<VisualFeedbackImage> {
  throw new Error(i18n.t("visualFeedback.unsupported"));
}
