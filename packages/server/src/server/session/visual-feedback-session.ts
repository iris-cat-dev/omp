import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { VisualFeedbackService } from "../visual-feedback-service.js";

export class VisualFeedbackSession {
  private readonly unsubscribe?: () => void;
  private disposed = false;

  constructor(
    private readonly options: {
      service?: VisualFeedbackService;
      emit(message: SessionOutboundMessage): void;
      emitForSource(message: SessionOutboundMessage, source?: object): void;
    },
  ) {
    this.unsubscribe = options.service?.subscribe((requests) => {
      options.emit({ type: "visual_feedback.requests", payload: { requests } });
    });
  }

  handle(message: SessionInboundMessage, source?: object): Promise<void> | undefined {
    if (message.type !== "visual_feedback.list" && message.type !== "visual_feedback.respond")
      return undefined;
    return this.dispatch(message, source).catch((error: unknown) => {
      if (this.disposed) return;
      this.options.emitForSource(
        {
          type: "rpc_error",
          payload: {
            requestId: message.requestId,
            requestType: message.type,
            code: "handler_error",
            error: error instanceof Error ? error.message : "Visual feedback operation failed",
          },
        },
        source,
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
  }

  private async dispatch(
    message: Extract<
      SessionInboundMessage,
      { type: "visual_feedback.list" | "visual_feedback.respond" }
    >,
    source?: object,
  ): Promise<void> {
    if (this.disposed) return;
    const service = this.options.service;
    if (!service) throw new Error("Visual feedback is unavailable on this daemon");
    if (message.type === "visual_feedback.list") {
      this.options.emitForSource(
        {
          type: "visual_feedback.list.response",
          payload: { requestId: message.requestId, requests: service.list() },
        },
        source,
      );
      return;
    }
    await service.respond(message.feedbackRequestId, message.response);
    if (this.disposed) return;
    this.options.emitForSource(
      {
        type: "visual_feedback.respond.response",
        payload: { requestId: message.requestId },
      },
      source,
    );
  }
}
