import { create } from "zustand";

export interface RuntimeResourceSheetRequest {
  serverId: string;
  agentId: string;
}
interface RuntimeResourceSheetState {
  request: RuntimeResourceSheetRequest | null;
}
export const useRuntimeResourceSheetStore = create<RuntimeResourceSheetState>(() => ({ request: null }));

/** Both tab-menu surfaces open the same session-scoped ownership inventory. */
export function openRuntimeResourceSheet(serverId: string, agentId: string): void {
  useRuntimeResourceSheetStore.setState({ request: { serverId, agentId } });
}
