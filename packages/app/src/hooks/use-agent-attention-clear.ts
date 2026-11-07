import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import {
  shouldClearAgentAttention,
  type AgentAttentionClearTrigger,
} from "@/utils/agent-attention";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { isWeb } from "@/constants/platform";
import {
  completeAgentAttentionRead,
  requestAgentAttentionRead,
  useAgentAttentionReadRequest,
} from "@/stores/agent-attention-read-store";

type AttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface UseAgentAttentionClearParams {
  agentId: string | null | undefined;
  serverId: string;
  client: DaemonClient | null;
  isConnected: boolean;
  isAgentReady: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason: AttentionReason;
  isScreenFocused: boolean;
  onClearError: (error: unknown) => void;
}

interface AgentAttentionClearController {
  clearOnInputFocus: () => void;
  clearOnPromptSend: () => void;
  clearOnAgentBlur: () => void;
}

interface PendingAttentionClear {
  trigger: AgentAttentionClearTrigger;
  requestId?: number;
}

interface AttentionClearState {
  serverId: string;
  agentId: string | null | undefined;
  pending: PendingAttentionClear | null;
  inFlight: PendingAttentionClear | null;
  deferredFocusEntryClear: boolean;
  wasScreenFocused: boolean;
  wasAppVisible: boolean;
  wasReady: boolean;
  wasActivelyViewed: boolean;
  requiredAttention: boolean;
}

export function useAgentAttentionClear({
  serverId,
  agentId,
  client,
  isConnected,
  isAgentReady,
  requiresAttention,
  attentionReason,
  isScreenFocused,
  onClearError,
}: UseAgentAttentionClearParams): AgentAttentionClearController {
  const [isAppVisible, setIsAppVisible] = useState<boolean>(() => getIsAppActivelyVisible());
  const [clearRevision, setClearRevision] = useState(0);
  const readRequestId = useAgentAttentionReadRequest(serverId, agentId);
  const mountedRef = useRef(false);
  const stateRef = useRef<AttentionClearState | null>(null);
  if (
    !stateRef.current ||
    stateRef.current.serverId !== serverId ||
    stateRef.current.agentId !== agentId
  ) {
    stateRef.current = {
      serverId,
      agentId,
      pending: null,
      inFlight: null,
      deferredFocusEntryClear: false,
      wasScreenFocused: false,
      wasAppVisible: isAppVisible,
      wasReady: false,
      wasActivelyViewed: false,
      requiredAttention: Boolean(requiresAttention),
    };
  }
  const state = stateRef.current;
  const isReady = Boolean(client && isConnected && isAgentReady);

  const flushPendingClear = useCallback(() => {
    const pending = state.pending;
    if (!pending || state.inFlight || !client || !agentId || !isReady) return;
    if (
      (pending.trigger === "focus-entry" || pending.trigger === "navigation") &&
      (!isScreenFocused || !isAppVisible)
    ) {
      return;
    }

    if (!requiresAttention || attentionReason === "permission") {
      state.pending = null;
      if (pending.requestId !== undefined) {
        completeAgentAttentionRead(serverId, agentId, pending.requestId);
      }
      return;
    }
    if (
      !shouldClearAgentAttention({
        agentId,
        isConnected,
        requiresAttention,
        attentionReason,
        trigger: pending.trigger,
        hasDeferredFocusEntryClear: state.deferredFocusEntryClear,
      })
    ) {
      state.pending = null;
      return;
    }

    state.pending = null;
    state.inFlight = pending;
    state.deferredFocusEntryClear = false;
    void client.clearAgentAttention(agentId).then(
      () => {
        state.inFlight = null;
        if (pending.requestId !== undefined) {
          completeAgentAttentionRead(serverId, agentId, pending.requestId);
        }
        if (state.pending && mountedRef.current && stateRef.current === state) {
          setClearRevision((revision) => revision + 1);
        }
      },
      (error: unknown) => {
        state.inFlight = null;
        if (state.pending && mountedRef.current && stateRef.current === state) {
          setClearRevision((revision) => revision + 1);
        }
        state.pending ??= pending;
        onClearError(error);
      },
    );
  }, [
    agentId,
    attentionReason,
    client,
    isAppVisible,
    isConnected,
    isReady,
    isScreenFocused,
    onClearError,
    requiresAttention,
    serverId,
    state,
  ]);

  const requestClear = useCallback(
    (trigger: AgentAttentionClearTrigger) => {
      if (!agentId || (isReady && !requiresAttention)) return;
      state.pending = {
        trigger,
        requestId: requestAgentAttentionRead(serverId, agentId),
      };
      flushPendingClear();
    },
    [agentId, flushPendingClear, isReady, requiresAttention, serverId, state],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const updateVisibility = () => {
      setIsAppVisible(getIsAppActivelyVisible());
    };

    const appStateSubscription = AppState.addEventListener("change", updateVisibility);

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updateVisibility);
      window.addEventListener("focus", updateVisibility);
      window.addEventListener("blur", updateVisibility);

      return () => {
        appStateSubscription.remove();
        document.removeEventListener("visibilitychange", updateVisibility);
        window.removeEventListener("focus", updateVisibility);
        window.removeEventListener("blur", updateVisibility);
      };
    }

    return () => {
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const isActivelyViewed = isScreenFocused && isAppVisible;
    const enteredScreenFocus = !state.wasScreenFocused && isActivelyViewed;
    const resumedIntoFocusedAgent = !state.wasAppVisible && isActivelyViewed;

    if (!requiresAttention) {
      state.deferredFocusEntryClear = false;
    } else if (
      !state.requiredAttention &&
      state.wasActivelyViewed &&
      isActivelyViewed &&
      state.wasReady &&
      isReady &&
      !state.pending &&
      (readRequestId === undefined || state.inFlight?.requestId === readRequestId)
    ) {
      // A genuinely new completion stays visible; initial/reconnected snapshots
      // instead finish the read that was requested when entering the panel.
      state.deferredFocusEntryClear = true;
    }

    if ((enteredScreenFocus || resumedIntoFocusedAgent) && !state.deferredFocusEntryClear) {
      state.pending ??= { trigger: "focus-entry" };
    }
    if (
      readRequestId !== undefined &&
      isActivelyViewed &&
      state.inFlight?.requestId !== readRequestId &&
      state.pending?.requestId !== readRequestId
    ) {
      state.pending = { trigger: "navigation", requestId: readRequestId };
    }

    state.wasScreenFocused = isScreenFocused;
    state.wasAppVisible = isAppVisible;
    state.wasReady = isReady;
    state.wasActivelyViewed = isActivelyViewed;
    state.requiredAttention = Boolean(requiresAttention);
    flushPendingClear();
  }, [
    clearRevision,
    flushPendingClear,
    isAppVisible,
    isReady,
    isScreenFocused,
    readRequestId,
    requiresAttention,
    state,
  ]);

  return {
    clearOnInputFocus: useCallback(() => {
      requestClear("input-focus");
    }, [requestClear]),
    clearOnPromptSend: useCallback(() => {
      requestClear("prompt-send");
    }, [requestClear]),
    clearOnAgentBlur: useCallback(() => {
      requestClear("agent-blur");
    }, [requestClear]),
  };
}
