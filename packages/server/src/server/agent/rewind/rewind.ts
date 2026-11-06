import type { AgentSession } from "../agent-sdk-types.js";
import type { AgentRewindErrorCode } from "@omp-desktop/protocol/messages";

export type RewindMode = "conversation" | "files" | "both";

export class RewindCapabilityError extends Error {
  constructor(mode: RewindMode) {
    super(`Provider does not support rewinding ${mode}`);
    this.name = "RewindCapabilityError";
  }
}

const REWIND_ERROR_MESSAGES: Record<AgentRewindErrorCode, string> = {
  message_pending: "This message is still synchronizing with the native session",
  message_unavailable:
    "Cannot locate this message in the native session. Resync it before rewinding",
  message_sync_failed: "Failed to synchronize this message with the native session",
};

export class AgentRewindError extends Error {
  constructor(
    readonly code: AgentRewindErrorCode,
    readonly agentId: string,
    readonly messageId: string,
    options?: ErrorOptions,
  ) {
    super(REWIND_ERROR_MESSAGES[code], options);
    this.name = "AgentRewindError";
  }
}

export async function invokeRewindCapability(
  session: AgentSession,
  input: { messageId: string; mode: RewindMode },
): Promise<void> {
  switch (input.mode) {
    case "conversation":
      if (!session.capabilities.supportsRewindConversation || !session.revertConversation) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertConversation({ messageId: input.messageId });
      return;
    case "files":
      if (!session.capabilities.supportsRewindFiles || !session.revertFiles) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertFiles({ messageId: input.messageId });
      return;
    case "both":
      if (!session.capabilities.supportsRewindBoth || !session.revertBoth) {
        throw new RewindCapabilityError(input.mode);
      }
      await session.revertBoth({ messageId: input.messageId });
      return;
  }
}
