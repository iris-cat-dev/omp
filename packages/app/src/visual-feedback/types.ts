import type {
  VisualFeedbackImage,
  VisualFeedbackRequest,
  VisualFeedbackSubmission,
} from "@omp-desktop/protocol/visual-feedback";

export interface VisualFeedbackEditorProps {
  request: VisualFeedbackRequest;
  onSubmit: (submission: VisualFeedbackSubmission) => Promise<void>;
  onCancel: () => void;
  captureScreenshot?: () => Promise<VisualFeedbackImage>;
}
