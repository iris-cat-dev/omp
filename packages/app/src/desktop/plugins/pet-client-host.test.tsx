// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetCreationDraft } from "@omp-desktop/plugin-desktop-pet";
import { desktopPetClientHost } from "./pet-client-host";

const state = vi.hoisted(() => ({
  localId: "desktop-local" as string | null, connected: true, selectedRemote: "remote-one", locale: "zh-CN",
  form: { selectedProvider: "omp", effectiveModelId: "author-model", effectiveThinkingOptionId: "high",
    selectedMode: "full", modeOptions: [{ id: "full" }], featureValues: { fast: true },
    isModelLoading: false, isAllModelsLoading: false, modelError: null as string | null, agentControls: {} },
  draftOptions: vi.fn(), createWorkspace: vi.fn(), createAgent: vi.fn(), mergeWorkspaces: vi.fn(),
  hydrateWorkspaces: vi.fn(), setAgents: vi.fn(), handoff: vi.fn(), navigate: vi.fn(), desktopInvoke: vi.fn(),
}));
const client = { createWorkspace: state.createWorkspace, createAgent: state.createAgent };
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: vi.fn(), useHosts: () => [{ serverId: state.selectedRemote }, { serverId: "desktop-local" }],
  useHostRuntimeConnectionStatuses: vi.fn(),
  useHostRuntimeClient: (serverId: string) => serverId === state.localId && state.localId ? client : null,
  useHostRuntimeIsConnected: (serverId: string) => serverId === state.localId && Boolean(state.localId) && state.connected,
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useLocalDaemonServerId: () => state.localId }));
vi.mock("@/composer/draft/input-draft", () => ({ useAgentInputDraft: (options: unknown) => { state.draftOptions(options); return { composerState: state.form }; } }));
vi.mock("@/composer/agent-controls", () => ({ DraftAgentControls: () => null }));
vi.mock("@/hooks/use-settings", () => ({ useAppSettings: vi.fn() }));
vi.mock("@/styles/theme", () => ({ DEFAULT_UI_FONT_STACK: "sans-serif" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: (key: string) => key }, getCurrentInterfaceLocale: () => state.locale }));
vi.mock("@/contexts/toast-context", () => ({ useToast: vi.fn() }));
vi.mock("@/desktop/hooks/desktop-ipc-error", () => ({ useDesktopIpcErrorReporter: vi.fn() }));
vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand: (...args: unknown[]) => state.desktopInvoke(...args) }));
vi.mock("@/stores/session-store", () => ({
  normalizeWorkspaceDescriptor: (workspace: unknown) => workspace,
  useSessionStore: Object.assign(vi.fn(), { getState: () => ({
    mergeWorkspaces: state.mergeWorkspaces, setHasHydratedWorkspaces: state.hydrateWorkspaces, setAgents: state.setAgents,
  }) }),
}));
vi.mock("@/utils/workspace-directory", () => ({ requireWorkspaceDirectory: (input: { workspaceDirectory: string }) => input.workspaceDirectory }));
vi.mock("@/utils/agent-snapshots", () => ({ normalizeAgentSnapshot: (agent: unknown) => agent }));
vi.mock("@/workspace/legacy-daemon-workspaces", () => ({ applyLegacyDaemonWorkspaceOwnership: (input: { agent: unknown }) => input.agent }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: (...args: unknown[]) => state.navigate(...args) }));
vi.mock("@/screens/workspace/workspace-draft-agent-config", () => ({ buildWorkspaceDraftAgentConfig: (config: unknown) => config }));
vi.mock("@/composer/submission/writer", () => ({ handoffCreatedAgentMessageSubmission: (...args: unknown[]) => state.handoff(...args) }));
vi.mock("@/types/stream", () => ({ createUserMessage: (input: unknown) => input, generateMessageId: () => "author-message" }));
vi.mock("@/runtime/local-model-bridge-runtime", () => ({ assertLocalModelBridgeReady: vi.fn() }));

let root: Root;
let draft: PetCreationDraft;
const preferences = { provider: "omp", modeId: "full", model: "author-model", thinkingOptionId: "high", featureValues: { fast: true } };
function Probe() { draft = desktopPetClientHost.useCreationDraft("pet-installation", false, preferences); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks(); state.localId = "desktop-local"; state.connected = true; state.selectedRemote = "remote-one";
  state.form.effectiveModelId = "author-model"; state.form.selectedProvider = "omp"; state.form.modelError = null;
  state.createWorkspace.mockResolvedValue({ workspace: { id: "local-workspace", workspaceDirectory: "/local/owned" } });
  state.createAgent.mockResolvedValue({ id: "local-agent" });
  state.desktopInvoke.mockResolvedValue({ cwd: "/local/prepared", initialPrompt: "Create a pet" });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("pet client host local ownership", () => {
  it("pins authoring and native resources to Desktop's local daemon as the selected remote host changes", async () => {
    await act(async () => root.render(<Probe />));
    expect(draft.ready).toBe(true); expect(draft.host?.serverId).toBe("desktop-local");
    expect(state.draftOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      draftKey: "plugin-author:pet-installation:desktop-local",
      composer: expect.objectContaining({ initialServerId: "desktop-local", onlineServerIds: ["desktop-local"], persistPreferences: false }),
    }));
    const host = draft.host!; state.selectedRemote = "remote-two";
    await act(async () => root.render(<Probe />));
    expect(draft.host).toBe(host);
    expect(await host.prepareWorkspace("A pet")).toEqual({ cwd: "/local/prepared", initialPrompt: "Create a pet" });
    expect(state.desktopInvoke).toHaveBeenCalledWith("prepare_desktop_pet_creation", { description: "A pet" });
    expect(await host.createWorkspace("/local/prepared")).toEqual({ id: "local-workspace", cwd: "/local/owned" });
    expect(state.createWorkspace).toHaveBeenCalledWith({ source: { kind: "directory", path: "/local/prepared" } });
    expect(state.mergeWorkspaces).toHaveBeenCalledWith("desktop-local", expect.any(Array));
    const timestamp = new Date(1000);
    await host.createAgent({ workspaceId: "local-workspace", config: { ...preferences, cwd: "/local/owned" }, locale: "zh-CN", initialPrompt: "Create", clientMessageId: "author-message", timestamp });
    expect(state.createAgent).toHaveBeenCalledWith(expect.objectContaining({ locale: "zh-CN", config: { ...preferences, cwd: "/local/owned" } }));
    expect(state.handoff).toHaveBeenCalledWith("desktop-local", "local-agent", expect.objectContaining({ timestamp }));
    host.openAgent("local-agent"); expect(state.navigate).toHaveBeenCalledWith({ serverId: "desktop-local", agentId: "local-agent" });
  });
  it("does not substitute an online remote daemon when the local daemon is absent or disconnected", async () => {
    state.localId = null; await act(async () => root.render(<Probe />));
    expect(draft.host).toBeNull(); expect(draft.ready).toBe(false); expect(draft.error).toBe("desktop.pets.noLocalHost");
    state.localId = "desktop-local"; state.connected = false;
    await act(async () => root.render(<Probe />));
    expect(draft.host).toBeNull(); expect(draft.ready).toBe(false);
    expect(state.createWorkspace).not.toHaveBeenCalled(); expect(state.desktopInvoke).not.toHaveBeenCalled();
  });
  it("requires a real selected OMP model before claiming authoring readiness", async () => {
    state.form.effectiveModelId = ""; await act(async () => root.render(<Probe />));
    expect(draft.ready).toBe(false); expect(draft.error).toBe("desktop.pets.noOmpModel");
    state.form.effectiveModelId = "author-model"; state.form.selectedProvider = "remote-provider";
    await act(async () => root.render(<Probe />)); expect(draft.ready).toBe(false);
  });
});
