import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import type { DesktopPetClientHost, PetCreationHost } from "@omp-desktop/plugin-desktop-pet";
import { useAppSettings } from "@/hooks/use-settings";
import { DEFAULT_UI_FONT_STACK } from "@/styles/theme";
import { useSessionStore, normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { getHostRuntimeStore, useHosts, useHostRuntimeConnectionStatuses, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { DraftAgentControls } from "@/composer/agent-controls";
import { useToast } from "@/contexts/toast-context";
import { i18n, getCurrentInterfaceLocale } from "@/i18n/i18next";
import { createActivityAgentLabelResolver } from "./activity-label";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { handoffCreatedAgentMessageSubmission } from "@/composer/submission/writer";
import { createUserMessage, generateMessageId } from "@/types/stream";
import { assertLocalModelBridgeReady } from "@/runtime/local-model-bridge-runtime";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { PetCreationWorkspace } from "@omp-desktop/plugin-desktop-pet/types";

export const desktopPetClientHost: DesktopPetClientHost = {
  useTranslation() {
    const { t } = useTranslation();
    return { t, locale: getCurrentInterfaceLocale() };
  },
  useFeedback() {
    const toast = useToast();
    const report = useDesktopIpcErrorReporter();
    return useMemo(() => ({
      notify(message: string, variant: "success" | "error") { if (variant === "error") toast.error(message); else toast.show(message, { variant: "success" }); },
      reportError(error: unknown, message: string) { report({ error, message, logLabel: "[Desktop plugin]" }); },
    }), [toast, report]);
  },
  useActivitySnapshot() {
    "use no memo";
    const { settings } = useAppSettings();
    const runtime = getHostRuntimeStore();
    const version = useSyncExternalStore((listener) => runtime.subscribeAll(listener), () => runtime.getVersion(), () => runtime.getVersion());
    const hosts = useHosts();
    const serverIds = useMemo(() => hosts.map(({ serverId }) => serverId), [hosts]);
    const statuses = useHostRuntimeConnectionStatuses(serverIds);
    const namingSources = useSessionStore(useShallow((state) => serverIds.flatMap((serverId) => { const session = state.sessions[serverId]; return [session?.agents, session?.agentDetails, session?.workspaces]; })));
    return useMemo(() => {
      void version; void namingSources;
      return {
        fontFamily: settings.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK,
        hosts: serverIds.map((serverId) => {
          const publication = runtime.getAgentDirectoryPublication(serverId);
          const connection = runtime.getSnapshot(serverId);
          const presentation = useSessionStore.getState().sessions[serverId];
          return {
            serverId, connected: statuses.get(serverId) === "online", revision: publication?.revision ?? null,
            connectionKey: JSON.stringify([connection?.clientGeneration, connection?.connectionEpoch]),
            agents: publication?.agents.values() ?? [],
            resolveAgentLabel: createActivityAgentLabelResolver(presentation),
          };
        }),
      };
    }, [runtime, version, namingSources, serverIds, statuses, settings.uiFontFamily]);
  },
  async refreshAgentDirectory(serverId, generation) { const runtime = getHostRuntimeStore(); if (runtime.getSnapshot(serverId)?.connectionStatus === "online") await runtime.refreshAgentDirectory({ serverId, expectedGeneration: generation }); },
  useCreationDraft(installationId, disabled, initialPreferences) {
    const serverId = useLocalDaemonServerId() ?? "";
    const client = useHostRuntimeClient(serverId);
    const connected = useHostRuntimeIsConnected(serverId);
    const onlineServerIds = useMemo(() => connected && serverId ? [serverId] : [], [connected, serverId]);
    const initialValues = useMemo(() => ({ provider: "omp" as const, ...(initialPreferences?.modeId ? { modeId: initialPreferences.modeId } : {}), ...(initialPreferences?.model ? { model: initialPreferences.model } : {}), ...(initialPreferences?.thinkingOptionId ? { thinkingOptionId: initialPreferences.thinkingOptionId } : {}) }), [initialPreferences]);
    const draft = useAgentInputDraft({ draftKey: `plugin-author:${installationId}:${serverId}`, composer: { initialServerId: serverId || null, initialValues, initialFeatureValues: initialPreferences?.featureValues, persistPreferences: false, isVisible: Boolean(serverId && connected), onlineServerIds } });
    const form = draft.composerState;
    const usable = Boolean(serverId && client && connected);
    const ready = usable && form?.selectedProvider === "omp" && Boolean(form.effectiveModelId) && !form.isModelLoading && !form.isAllModelsLoading && !form.modelError;
    const host = useMemo<PetCreationHost | null>(() => !client || !connected ? null : {
      serverId,
      prepareWorkspace: (description) => invokeDesktopCommand<PetCreationWorkspace>("prepare_desktop_pet_creation", { description }),
      createMessageId: generateMessageId,
      async createWorkspace(directory) {
        const payload = await client.createWorkspace({ source: { kind: "directory", path: directory } });
        if (payload.error || !payload.workspace) throw new Error(payload.error ?? "Unable to create workspace");
        const workspace = normalizeWorkspaceDescriptor(payload.workspace);
        const store = useSessionStore.getState();
        store.mergeWorkspaces(serverId, [workspace]); store.setHasHydratedWorkspaces(serverId, true);
        return { id: workspace.id, cwd: requireWorkspaceDirectory({ workspaceId: workspace.id, workspaceDirectory: workspace.workspaceDirectory }) };
      },
      async createAgent({ workspaceId, config, locale, initialPrompt, clientMessageId, timestamp }) {
        assertLocalModelBridgeReady(client);
        const agent = await client.createAgent({ config: buildWorkspaceDraftAgentConfig(config), workspaceId, locale, initialPrompt, clientMessageId });
        const store = useSessionStore.getState();
        store.setAgents(serverId, (previous) => { const next = new Map(previous); next.set(agent.id, applyLegacyDaemonWorkspaceOwnership({ serverId, agent: normalizeAgentSnapshot(agent, serverId) })); return next; });
        handoffCreatedAgentMessageSubmission(serverId, agent.id, createUserMessage({ clientMessageId, text: initialPrompt, timestamp }));
        return { id: agent.id };
      },
      openAgent(agentId) { navigateToAgent({ serverId, agentId }); },
    }, [client, connected, serverId]);
    const modeIds = form?.modeOptions.map(({ id }) => id) ?? [];
    const modeId = form && modeIds.includes(form.selectedMode) ? form.selectedMode : modeIds[0];
    return {
      host, ready: Boolean(ready), error: !usable ? i18n.t("desktop.pets.noLocalHost") : !ready ? form?.modelError || i18n.t("desktop.pets.noOmpModel") : null,
      preferences: { provider: "omp", ...(modeId ? { modeId } : {}), ...(form?.effectiveModelId ? { model: form.effectiveModelId } : {}), ...(form?.effectiveThinkingOptionId ? { thinkingOptionId: form.effectiveThinkingOptionId } : {}), ...(form?.featureValues ? { featureValues: form.featureValues } : {}) },
      controls: form ? <DraftAgentControls {...form.agentControls} disabled={disabled} /> : null,
    };
  },
};
