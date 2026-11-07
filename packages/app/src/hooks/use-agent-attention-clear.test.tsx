/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  requestAgentAttentionRead,
  useAgentAttentionReadStore,
} from "@/stores/agent-attention-read-store";
import {
  useAgentAttentionClear,
  type UseAgentAttentionClearParams,
} from "./use-agent-attention-clear";

const SERVER_ID = "attention-server";
const AGENT_ID = "attention-agent";
let clearAttention: Mock<(agentId: string) => Promise<void>>;
let params: UseAgentAttentionClearParams;
let windowFocused = true;

beforeEach(() => {
  windowFocused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  useAgentAttentionReadStore.setState({ requests: new Map() });
  clearAttention = vi.fn<(agentId: string) => Promise<void>>().mockResolvedValue(undefined);
  params = {
    serverId: SERVER_ID,
    agentId: AGENT_ID,
    client: { clearAgentAttention: clearAttention } as unknown as DaemonClient,
    isConnected: true,
    isAgentReady: true,
    requiresAttention: true,
    attentionReason: "finished",
    isScreenFocused: true,
    onClearError: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  useAgentAttentionReadStore.setState({ requests: new Map() });
  vi.restoreAllMocks();
});

describe("agent attention acknowledgement", () => {
  it("finishes an entry acknowledgement after reconnecting without another focus transition", () => {
    params.isConnected = false;
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    expect(clearAttention).not.toHaveBeenCalled();

    rerender({ ...params, isConnected: true });
    expect(clearAttention).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
  });

  it("waits for both the client and authoritative agent state instead of consuming a missing snapshot", () => {
    params.client = null;
    params.isAgentReady = false;
    params.requiresAttention = false;
    params.attentionReason = null;
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    const client = { clearAgentAttention: clearAttention } as unknown as DaemonClient;

    rerender({ ...params, client });
    expect(clearAttention).not.toHaveBeenCalled();
    rerender({ ...params, client, requiresAttention: true, attentionReason: "finished" });
    expect(clearAttention).not.toHaveBeenCalled();
    rerender({
      ...params,
      client,
      isAgentReady: true,
      requiresAttention: true,
      attentionReason: "finished",
    });
    expect(clearAttention).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
  });

  it("keeps a new completion visible until an explicit selection even when layout focus is unchanged", async () => {
    params.requiresAttention = false;
    params.attentionReason = null;
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    rerender({ ...params, requiresAttention: true, attentionReason: "finished" });

    act(() => {
      windowFocused = false;
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      windowFocused = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(clearAttention).not.toHaveBeenCalled();

    await act(async () => {
      requestAgentAttentionRead(SERVER_ID, AGENT_ID);
    });
    expect(clearAttention).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
    expect(useAgentAttentionReadStore.getState().requests.size).toBe(0);
  });

  it("acknowledges completion received in the background when returning to the window", () => {
    params.requiresAttention = false;
    params.attentionReason = null;
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    act(() => {
      windowFocused = false;
      window.dispatchEvent(new Event("blur"));
    });
    rerender({ ...params, requiresAttention: true, attentionReason: "finished" });
    expect(clearAttention).not.toHaveBeenCalled();
    act(() => {
      windowFocused = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(clearAttention).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
  });

  it("does not turn selecting or focusing a permission request into a dismissal", async () => {
    params.attentionReason = "permission";
    const { result } = renderHook(useAgentAttentionClear, { initialProps: params });
    await act(async () => {
      requestAgentAttentionRead(SERVER_ID, AGENT_ID);
      result.current.clearOnInputFocus();
      result.current.clearOnPromptSend();
    });
    expect(clearAttention).not.toHaveBeenCalled();
    expect(useAgentAttentionReadStore.getState().requests.size).toBe(0);
  });

  it("reports a failed acknowledgement and retries the retained intent after reconnecting", async () => {
    const failure = new Error("connection closed during acknowledgement");
    clearAttention.mockRejectedValueOnce(failure);
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    await act(async () => {});
    expect(params.onClearError).toHaveBeenCalledExactlyOnceWith(failure);
    rerender({ ...params });
    expect(clearAttention).toHaveBeenCalledTimes(1);
    rerender({ ...params, isConnected: false });
    rerender({ ...params, isConnected: true });
    expect(clearAttention).toHaveBeenCalledTimes(2);
  });

  it("does not consume a newer explicit read while an earlier acknowledgement is in flight", async () => {
    const complete: Array<() => void> = [];
    clearAttention.mockImplementation(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      complete.push(resolve);
      return promise;
    });
    requestAgentAttentionRead(SERVER_ID, AGENT_ID);
    renderHook(useAgentAttentionClear, { initialProps: params });
    let laterRequest = 0;
    act(() => {
      laterRequest = requestAgentAttentionRead(SERVER_ID, AGENT_ID);
    });
    expect(clearAttention).toHaveBeenCalledTimes(1);
    await act(async () => complete[0]());
    expect(clearAttention).toHaveBeenCalledTimes(2);
    expect(Array.from(useAgentAttentionReadStore.getState().requests.values())).toEqual([
      laterRequest,
    ]);
    await act(async () => complete[1]());
    expect(useAgentAttentionReadStore.getState().requests.size).toBe(0);
  });

  it("does not let an earlier successful acknowledgement dismiss a later completion", async () => {
    const firstRead = Promise.withResolvers<void>();
    clearAttention.mockReturnValueOnce(firstRead.promise);
    const { rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    rerender({ ...params, requiresAttention: false, attentionReason: null });
    rerender({ ...params, requiresAttention: true });
    await act(async () => firstRead.resolve());
    act(() => {
      windowFocused = false;
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      windowFocused = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(clearAttention).toHaveBeenCalledTimes(1);
    await act(async () => {
      requestAgentAttentionRead(SERVER_ID, AGENT_ID);
    });
    expect(clearAttention).toHaveBeenCalledTimes(2);
  });

  it("preserves a read requested while leaving an offline retained panel", () => {
    params.isConnected = false;
    const { result, rerender } = renderHook(useAgentAttentionClear, { initialProps: params });
    act(() => result.current.clearOnAgentBlur());
    rerender({ ...params, isConnected: true, isScreenFocused: false });
    expect(clearAttention).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
  });
});
