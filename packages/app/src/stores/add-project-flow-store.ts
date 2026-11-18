import type { WorkspaceProjectDescriptorPayload } from "@omp-desktop/protocol/messages";
import { create } from "zustand";

export interface AddProjectFlowRequest {
  id: number;
  preferredHostId?: string;
  onProjectAdded?: (project: WorkspaceProjectDescriptorPayload) => Promise<void>;
}

interface AddProjectFlowStoreState {
  request: AddProjectFlowRequest | null;
  open: (preferredHostId?: string) => void;
  openForModelChat: (
    serverId: string,
    onProjectAdded: NonNullable<AddProjectFlowRequest["onProjectAdded"]>,
  ) => void;
  close: () => void;
}

let nextRequestId = 1;

export const useAddProjectFlowStore = create<AddProjectFlowStoreState>((set) => ({
  request: null,
  open: (preferredHostId) => {
    set({
      request: {
        id: nextRequestId++,
        ...(preferredHostId ? { preferredHostId } : {}),
      },
    });
  },
  openForModelChat: (preferredHostId, onProjectAdded) => {
    set({ request: { id: nextRequestId++, preferredHostId, onProjectAdded } });
  },
  close: () => set({ request: null }),
}));
