import { create } from "zustand";
import type {
  VisualFeedbackRequest,
  VisualFeedbackSubmission,
} from "@omp-desktop/protocol/visual-feedback";

interface ManualVisualFeedback {
  request: VisualFeedbackRequest;
  onSubmit: (submission: VisualFeedbackSubmission) => Promise<void>;
}

interface ManualVisualFeedbackState {
  pending: ManualVisualFeedback | null;
  open: (input: ManualVisualFeedback) => void;
  close: (requestId: string) => void;
}

export const useManualVisualFeedbackStore = create<ManualVisualFeedbackState>((set, get) => ({
  pending: null,
  open: (input) => {
    if (get().pending) return;
    set({ pending: input });
  },
  close: (requestId) => {
    if (get().pending?.request.id === requestId) set({ pending: null });
  },
}));
