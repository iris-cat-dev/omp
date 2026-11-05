import { i18n } from "@/i18n/i18next";

export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  /** Target and post-submit draft guards prevent stale settlement from replacing new edits. */
  snapshot?: {
    isCurrentTarget: () => boolean;
    isInputUnchanged: () => boolean;
  };
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => void;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: TAttachment[]) => void;
  setSendError: (error: unknown | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function assertWorkspaceDirectoryExists(input: {
  cwd: string;
  directoryExists: (cwd: string) => Promise<boolean>;
  missingDirectoryMessage: string;
}): Promise<void> {
  if (!input.cwd.trim()) {
    return;
  }
  if (!(await input.directoryExists(input.cwd))) {
    throw new Error(input.missingDirectoryMessage);
  }
}

function handleAgentInputRejection<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  error: unknown,
  message: string,
  attachments: TAttachment[],
  restoreDraft: boolean,
): void {
  input.onSubmitError?.(error);
  if (!(input.snapshot?.isCurrentTarget() ?? true)) return;
  if (restoreDraft && (input.snapshot?.isInputUnchanged() ?? true)) {
    input.setUserInput(message);
    input.setAttachments(attachments);
  }
  input.setSendError(
    error instanceof Error
      ? error
      : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
  );
  input.setIsProcessing(false);
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    input.queueMessage({ message: trimmedMessage, attachments });
    if (shouldClearOnSubmit) {
      input.setUserInput("");
      input.setAttachments([]);
    }
    return "queued";
  }

  // Clear the persisted draft too, canceling any staged publication of the sent text.
  if (shouldClearOnSubmit) {
    input.clearDraft("sent");
    input.setUserInput("");
    input.setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    const snapshot = input.snapshot;
    if (!snapshot || snapshot.isCurrentTarget()) {
      if (!shouldClearOnSubmit && (snapshot?.isInputUnchanged() ?? true)) {
        input.clearDraft("sent");
      }
      input.setIsProcessing(false);
    }
    return "submitted";
  } catch (error) {
    handleAgentInputRejection(input, error, trimmedMessage, attachments, shouldClearOnSubmit);
    return "failed";
  }
}
