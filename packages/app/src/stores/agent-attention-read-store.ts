import { create } from "zustand";

interface AgentAttentionReadState {
  requests: ReadonlyMap<string, number>;
}

export const useAgentAttentionReadStore = create<AgentAttentionReadState>(() => ({
  requests: new Map(),
}));

let nextRequestId = 0;

function requestKey(serverId: string, agentId: string): string {
  return JSON.stringify([serverId, agentId]);
}

/** Keep explicit selection separate from layout focus, which may already be active. */
export function requestAgentAttentionRead(serverId: string, agentId: string): number {
  const key = requestKey(serverId, agentId);
  const requestId = ++nextRequestId;
  useAgentAttentionReadStore.setState((state) => {
    const requests = new Map(state.requests);
    requests.set(key, requestId);
    return { requests };
  });
  return requestId;
}

export function completeAgentAttentionRead(
  serverId: string,
  agentId: string,
  requestId: number,
): void {
  const key = requestKey(serverId, agentId);
  useAgentAttentionReadStore.setState((state) => {
    if (state.requests.get(key) !== requestId) return state;
    const requests = new Map(state.requests);
    requests.delete(key);
    return { requests };
  });
}

export function useAgentAttentionReadRequest(
  serverId: string,
  agentId: string | null | undefined,
): number | undefined {
  const key = agentId ? requestKey(serverId, agentId) : null;
  return useAgentAttentionReadStore((state) => (key ? state.requests.get(key) : undefined));
}
