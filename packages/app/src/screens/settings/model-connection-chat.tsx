import type { OmpProviderSnapshotResult } from "@omp-desktop/client";
import type { ProviderSnapshotEntry } from "@omp-desktop/protocol/agent-types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SelectField } from "@/components/ui/select-field";
import { useProvidersSnapshot, providersSnapshotQueryKey } from "@/hooks/use-providers-snapshot";
import { useHostProjects } from "@/projects/host-projects";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { resolveOmpModelProviderNamespace } from "@/provider-selection/omp-model-provider";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { openProjectWorkspaceDraft } from "@/utils/open-project-workspace-draft";
import { toErrorMessage } from "@/utils/error-messages";

type ModelCatalog =
  | { status: "loading" | "unavailable" | "error" }
  | { status: "ready"; options: ChatOption[] };

const SEARCH_THRESHOLD = 6;
const EMPTY_MODELS: ChatOption[] = [];

export interface ModelConnectionChatProps {
  serverId: string;
  /** Exact OMP model provider ID, including IDs for custom providers. */
  providerId: string;
}

interface ChatOption {
  id: string;
  label: string;
  description: string | undefined;
}

interface ChatProject {
  id: string;
  label: string;
  rootPath: string;
}

function getModelCatalog(
  entry: ProviderSnapshotEntry | undefined,
  providerId: string,
): ModelCatalog {
  if (!entry?.enabled) return { status: "unavailable" };
  if (entry.status !== "ready") return { status: entry.status };
  const models = (filterSelectableModels(entry.models ?? null) ?? []).filter(
    (model) => resolveOmpModelProviderNamespace(model.id, model.metadata?.provider) === providerId,
  );
  const labelCounts = new Map<string, number>();
  for (const model of models) {
    labelCounts.set(model.label, (labelCounts.get(model.label) ?? 0) + 1);
  }
  return {
    status: "ready",
    options: models.map(({ id, label }) => ({
      id,
      label,
      description: (labelCounts.get(label) ?? 0) > 1 ? id : undefined,
    })),
  };
}

function getCatalogStatusKey(connected: boolean, loading: boolean, catalog: ModelCatalog) {
  if (!connected) return "providerSelection.readiness.hostDisconnected";
  if (loading) return "settings.modelConnectionChat.loading";
  if (catalog.status !== "ready") return "settings.modelConnectionChat.unavailable";
  if (catalog.options.length === 0) return "settings.modelConnectionChat.empty";
  return null;
}

function useChatProjects(serverId: string, selectedId: string | null) {
  const serverIds = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(serverIds);
  const lastWorkspace = useLastWorkspaceSelection();
  const workspaceId = lastWorkspace?.serverId === serverId ? lastWorkspace.workspaceId : null;
  const lastProjectId = useSessionStore((state) => {
    const workspace = workspaceId ? state.sessions[serverId]?.workspaces.get(workspaceId) : null;
    return workspace && !workspace.archivingAt ? workspace.projectId : null;
  });
  const options = useMemo(
    () =>
      projects.flatMap((project) =>
        project.hosts.flatMap((host) =>
          host.serverId === serverId && host.iconWorkingDir
            ? [{ id: host.projectId, label: project.projectName, rootPath: host.iconWorkingDir }]
            : [],
        ),
      ),
    [projects, serverId],
  );
  const selected =
    options.find((option) => option.id === selectedId) ??
    options.find((option) => option.id === lastProjectId) ??
    (options.length === 1 ? options[0] : undefined);
  const tabHost = lastProjectId && selected?.id === lastProjectId ? lastWorkspace : null;
  return { options, selected, tabHost };
}

function ProjectOption({
  option,
  selected,
  onSelect,
}: {
  option: ChatProject;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  return (
    <DropdownMenuItem selected={selected} description={option.rootPath} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

function ProjectSelect({
  label,
  options,
  selected,
  disabled,
  onSelect,
  onAddProject,
}: {
  label: string;
  options: ChatProject[];
  selected: ChatProject | undefined;
  disabled: boolean;
  onSelect: (id: string) => void;
  onAddProject?: () => void;
}) {
  const { t } = useTranslation();
  const selectedLabel = selected?.label;
  const accessibilityValue = useMemo(() => ({ text: selectedLabel }), [selectedLabel]);
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={selected ? styles.projectQuiet : styles.projectTrigger}
        disabled={disabled}
        accessibilityLabel={label}
        accessibilityValue={accessibilityValue}
      >
        <Text numberOfLines={1} style={selected ? styles.projectName : styles.triggerText}>
          {selected?.label ?? label}
        </Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start" width={300} scrollable maxHeight={340}>
        {options.map((option) => (
          <ProjectOption
            key={option.id}
            option={option}
            selected={option.id === selected?.id}
            onSelect={onSelect}
          />
        ))}
        {onAddProject ? (
          <DropdownMenuItem onSelect={onAddProject}>
            {t("sidebar.actions.addProject")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatDestination({
  project,
  projects,
  opening,
  onChooseProject,
  onAddProject,
  onStartChat,
}: {
  project: ChatProject | undefined;
  projects: ChatProject[];
  opening: boolean;
  onChooseProject: (id: string) => void;
  onAddProject?: () => void;
  onStartChat: () => void;
}) {
  const { t } = useTranslation();
  if (projects.length === 0) {
    return onAddProject ? (
      <Button size="sm" variant="outline" onPress={onAddProject}>
        {t("sidebar.actions.addProject")}
      </Button>
    ) : null;
  }
  return (
    <>
      {project ? (
        <Button size="sm" variant="default" loading={opening} onPress={onStartChat}>
          {t("settings.modelConnectionChat.start")}
        </Button>
      ) : null}
      {projects.length > 1 || onAddProject ? (
        <ProjectSelect
          label={t("settings.modelConnectionChat.chooseProject")}
          options={projects}
          selected={project}
          disabled={opening}
          onAddProject={onAddProject}
          onSelect={onChooseProject}
        />
      ) : (
        <Text style={styles.projectName}>{project?.label}</Text>
      )}
    </>
  );
}

function CatalogNotice({
  status,
  error,
  onRetry,
}: {
  status: string;
  error: string | null;
  onRetry: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.controls}>
      <Text accessibilityLiveRegion="polite" style={styles.hint}>
        {status}
      </Text>
      {onRetry ? (
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function ModelConnectionChatControls({ serverId, providerId }: ModelConnectionChatProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const connected = useHostRuntimeIsConnected(serverId);
  const { entries, supportsSnapshot, isLoading, refresh, isRefreshing } =
    useProvidersSnapshot(serverId);
  const entry = entries?.find((candidate) => candidate.provider === "omp");
  const catalog = useMemo(() => getModelCatalog(entry, providerId), [entry, providerId]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { options: projects, selected: project, tabHost } = useChatProjects(serverId, projectId);
  const canAddProject = useSessionStore((state) => {
    const features = state.sessions[serverId]?.serverInfo?.features;
    return features?.projectAdd === true && features.stableProjectIdentity === true;
  });
  const projectsLoaded = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (
      session?.hasHydratedWorkspaces === true || session?.hasWorkspaceDirectorySnapshot === true
    );
  });
  const openForModelChat = useAddProjectFlowStore((state) => state.openForModelChat);
  const modelOptions = catalog.status === "ready" ? catalog.options : EMPTY_MODELS;
  const pickerOptions = useMemo(
    () => modelOptions.map((option) => ({ ...option, value: option.id })),
    [modelOptions],
  );
  const model = modelOptions.find((option) => option.id === modelId);
  const modelLabel = model?.label;
  const selectedDisplay = useMemo(
    () => (modelLabel === undefined ? null : { label: modelLabel }),
    [modelLabel],
  );
  const chooseModel = useCallback((id: string) => {
    setModelId(id);
    setError(null);
  }, []);
  const chooseProject = useCallback((id: string) => {
    setProjectId(id);
    setError(null);
  }, []);
  const retryCatalog = useCallback(() => {
    setError(null);
    void refresh(["omp"]).catch((cause: unknown) => setError(toErrorMessage(cause)));
  }, [refresh]);

  const openDraft = useCallback(
    async (id: string, destinationProjectId: string, projectRootPath: string) => {
      if (!isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId))) {
        throw new Error(t("providerSelection.readiness.hostDisconnected"));
      }
      const currentEntry = queryClient
        .getQueryData<OmpProviderSnapshotResult>(providersSnapshotQueryKey(serverId))
        ?.entries.find((candidate) => candidate.provider === "omp");
      const currentCatalog = getModelCatalog(currentEntry, providerId);
      if (
        currentCatalog.status !== "ready" ||
        !currentCatalog.options.some((option) => option.id === id)
      ) {
        throw new Error(t("settings.modelConnectionChat.unavailable"));
      }
      await openProjectWorkspaceDraft({
        serverId,
        projectId: destinationProjectId,
        projectRootPath,
        tabHost,
        setup: {
          provider: "omp",
          cwd: projectRootPath,
          model: id,
          modeId: null,
          thinkingOptionId: null,
          featureValues: {},
        },
      });
    },
    [providerId, queryClient, serverId, t, tabHost],
  );

  const addProject = useCallback(() => {
    if (!model) return;
    setError(null);
    openForModelChat(serverId, async (addedProject) => {
      setProjectId(addedProject.projectId);
      try {
        await openDraft(model.id, addedProject.projectId, addedProject.projectRootPath);
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    });
  }, [model, openDraft, openForModelChat, serverId]);

  const startChat = useCallback(async () => {
    if (!model || !project || inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    setError(null);
    try {
      await openDraft(model.id, project.id, project.rootPath);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      inFlight.current = false;
      setOpening(false);
    }
  }, [model, openDraft, project]);

  const catalogLoading = isLoading || isRefreshing || catalog.status === "loading";
  const statusKey = getCatalogStatusKey(connected, catalogLoading, catalog);
  const canRetry = connected && supportsSnapshot && !catalogLoading;

  if (statusKey) {
    return (
      <CatalogNotice
        status={t(statusKey)}
        error={error}
        onRetry={canRetry ? retryCatalog : undefined}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <View style={styles.modelField}>
          <SelectField
            field={false}
            size="sm"
            label={t("providerSelection.selectModel")}
            value={model?.id ?? null}
            selectedDisplay={selectedDisplay}
            options={pickerOptions}
            disabled={opening}
            onChange={chooseModel}
            placeholder={t("providerSelection.selectModel")}
            emptyText={t("modelSelector.noMatches")}
            searchable={pickerOptions.length > SEARCH_THRESHOLD}
            searchPlaceholder={t("modelSelector.searchPlaceholder")}
          />
        </View>
        {model ? (
          <ChatDestination
            project={project}
            projects={projects}
            opening={opening}
            onChooseProject={chooseProject}
            onAddProject={canAddProject && projectsLoaded ? addProject : undefined}
            onStartChat={startChat}
          />
        ) : null}
      </View>
      {model && projects.length === 0 ? (
        <Text style={styles.hint}>
          {projectsLoaded ? t("settings.modelConnectionChat.needsProject") : t("common.loading")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function ModelConnectionChat(props: ModelConnectionChatProps) {
  return (
    <ModelConnectionChatControls
      key={JSON.stringify([props.serverId, props.providerId])}
      {...props}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelField: { maxWidth: 230 },
  projectQuiet: {
    maxWidth: 190,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  projectTrigger: {
    maxWidth: 230,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  triggerText: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  projectName: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
