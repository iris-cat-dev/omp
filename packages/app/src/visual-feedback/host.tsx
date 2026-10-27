import { useCallback, useEffect, useState } from "react";
import type {
  VisualFeedbackRequest,
  VisualFeedbackResponse,
  VisualFeedbackSubmission,
} from "@omp-desktop/protocol/visual-feedback";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { VisualFeedbackEditor } from "./editor";
import { captureScreenshot } from "./capture";
import { useManualVisualFeedbackStore } from "./manual-store";

type UpdateRequests = (serverId: string, requests: VisualFeedbackRequest[]) => void;

function HostRequests({ serverId, update }: { serverId: string; update: UpdateRequests }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.visualFeedback === true,
  );
  const toast = useToast();
  const showError = toast.error;

  useEffect(() => () => update(serverId, []), [serverId, update]);
  useEffect(() => {
    if (!client || !connected || !supported) return;
    let live = true;
    let receivedSnapshot = false;
    const unsubscribe = client.subscribe((event) => {
      if (!live || event.type !== "visual_feedback_requests") return;
      receivedSnapshot = true;
      update(serverId, event.requests);
    });
    void client
      .listVisualFeedbackRequests()
      .then((requests) => {
        if (live && !receivedSnapshot) update(serverId, requests);
        return undefined;
      })
      .catch((error: unknown) => {
        if (live) showError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, connected, serverId, supported, update, showError]);
  return null;
}

function RemoteEditor({
  serverId,
  request,
  remove,
}: {
  serverId: string;
  request: VisualFeedbackRequest;
  remove: (serverId: string, requestId: string) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const respond = useCallback(
    async (response: VisualFeedbackResponse) => {
      if (!client)
        throw new Error("The host is disconnected. Reconnect before submitting feedback.");
      await client.respondToVisualFeedback(request.id, response);
      remove(serverId, request.id);
    },
    [client, remove, request.id, serverId],
  );
  const submit = useCallback(
    (submission: VisualFeedbackSubmission) => respond({ status: "submitted", submission }),
    [respond],
  );
  const showError = toast.error;
  const cancel = useCallback(() => {
    void respond({ status: "cancelled" }).catch((error: unknown) => {
      showError(error instanceof Error ? error.message : String(error));
    });
  }, [respond, showError]);
  return (
    <VisualFeedbackEditor
      request={request}
      captureScreenshot={captureScreenshot}
      onSubmit={submit}
      onCancel={cancel}
    />
  );
}

export function VisualFeedbackHost() {
  const hosts = useHosts();
  const [requests, setRequests] = useState<Map<string, VisualFeedbackRequest[]>>(() => new Map());
  const manual = useManualVisualFeedbackStore((state) => state.pending);
  const closeManual = useManualVisualFeedbackStore((state) => state.close);
  const update = useCallback<UpdateRequests>((serverId, pending) => {
    setRequests((previous) => {
      if (!pending.length && !previous.has(serverId)) return previous;
      const next = new Map(previous);
      if (pending.length) next.set(serverId, pending);
      else next.delete(serverId);
      return next;
    });
  }, []);
  const remove = useCallback((serverId: string, requestId: string) => {
    setRequests((previous) => {
      const next = new Map(previous);
      const remaining = (next.get(serverId) ?? []).filter((request) => request.id !== requestId);
      if (remaining.length) next.set(serverId, remaining);
      else next.delete(serverId);
      return next;
    });
  }, []);
  const submitManual = useCallback(
    async (submission: VisualFeedbackSubmission) => {
      if (!manual) throw new Error("The feedback editor is no longer open");
      await manual.onSubmit(submission);
      closeManual(manual.request.id);
    },
    [closeManual, manual],
  );
  const cancelManual = useCallback(() => {
    if (manual) closeManual(manual.request.id);
  }, [closeManual, manual]);
  const remote = [...requests].find(([, pending]) => pending.length > 0);
  let editor = null;
  if (manual) {
    editor = (
      <VisualFeedbackEditor
        key={manual.request.id}
        request={manual.request}
        captureScreenshot={captureScreenshot}
        onSubmit={submitManual}
        onCancel={cancelManual}
      />
    );
  } else if (remote) {
    editor = (
      <RemoteEditor
        key={`${remote[0]}:${remote[1][0]!.id}`}
        serverId={remote[0]}
        request={remote[1][0]!}
        remove={remove}
      />
    );
  }
  return (
    <>
      {hosts.map((host) => (
        <HostRequests key={host.serverId} serverId={host.serverId} update={update} />
      ))}
      {editor}
    </>
  );
}
