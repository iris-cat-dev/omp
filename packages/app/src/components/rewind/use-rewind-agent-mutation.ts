import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { DaemonRpcError, type DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { AgentAttachment } from "@omp-desktop/protocol/messages";
import type { RewindMode } from "./use-rewind-capabilities";
import type { UserMessageImageAttachment } from "@/types/stream";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { shouldRestoreComposerForRewindMode } from "./rewind-mode";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

interface UseRewindAgentMutationInput {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  client?: DaemonClient | null;
}

interface RewindAgentInput {
  mode: RewindMode;
  rewoundText: string;
  rewoundImages: readonly UserMessageImageAttachment[];
  rewoundAttachments: readonly AgentAttachment[];
}

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (input: RewindAgentInput) => Promise<void>;
  syncMessage: () => Promise<void>;
  isPending: boolean;
} {
  const toast = useToast();
  const { t } = useTranslation();
  const composerRestore = useRewindComposerRestore();
  const actionInFlight = useRef(false);
  const showError = (error: unknown, fallbackKey: "failed" | "syncFailed") => {
    if (error instanceof DaemonRpcError) {
      switch (error.code) {
        case "message_pending":
          toast.error(t("rewind.errors.pending"));
          return;
        case "message_unavailable":
          toast.error(t("rewind.errors.unavailable"));
          return;
        case "message_sync_failed":
          toast.error(t("rewind.errors.syncFailed"));
          return;
      }
    }
    toast.error(error instanceof Error ? error.message : t(`rewind.errors.${fallbackKey}`));
  };
  const { isPending, mutateAsync } = useMutation({
    mutationFn: async ({
      mode,
      rewoundText,
      rewoundImages,
      rewoundAttachments,
    }: RewindAgentInput) => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await input.client.rewindAgent(input.agentId, input.messageId, mode);

      if (shouldRestoreComposerForRewindMode(mode)) {
        composerRestore?.restoreIfComposerEmpty({
          text: rewoundText,
          images: rewoundImages,
          attachments: rewoundAttachments,
        });
      }

      if (mode !== "files") {
        const cursor = input.serverId
          ? useSessionStore
              .getState()
              .sessions[input.serverId]?.agentTimelineCursor.get(input.agentId)
          : undefined;
        if (!input.serverId) throw new Error(t("common.errors.daemonClientUnavailable"));
        await getHostRuntimeStore().fetchAgentTimeline(input.serverId, input.agentId, {
          direction: "tail",
          projection: "projected",
          ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
        });
      }
    },
    onError: (error) => {
      showError(error, "failed");
    },
  });
  const { isPending: isSyncPending, mutateAsync: syncMessageAsync } = useMutation({
    mutationFn: async () => {
      if (!input.client || !input.agentId || !input.messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await input.client.syncAgentRewindMessage(input.agentId, input.messageId);
    },
    onError: (error) => showError(error, "syncFailed"),
  });

  const rewindAgent = useCallback(
    async (rewindInput: RewindAgentInput) => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      try {
        await mutateAsync(rewindInput);
      } finally {
        actionInFlight.current = false;
      }
    },
    [mutateAsync],
  );
  const syncMessage = useCallback(async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      await syncMessageAsync();
    } finally {
      actionInFlight.current = false;
    }
  }, [syncMessageAsync]);

  return {
    rewindAgent,
    syncMessage,
    isPending: isPending || isSyncPending,
  };
}
