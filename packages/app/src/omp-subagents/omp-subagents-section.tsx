import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import type { OmpSubagentSettings } from "@omp-desktop/protocol/messages";

import {
  formatAgentFeatureOptionDescription,
  formatAgentFeatureOptionLabel,
  formatThinkingOptionLabel,
} from "@/agent-controls/labels";
import { FAST_MODE_FEATURE_ID } from "@/agent-controls/policy";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

const INHERIT_MODEL = "__inherit_parent_agent__";
const DEFAULT_THINKING = "__omp_default_thinking__";
const DEFAULT_SPEED = "__omp_default_speed__";
const NATIVE_THINKING_OPTIONS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};
type SubagentEntry = OmpSubagentSettings["agents"][number];

function resolveModelSelector(raw: string | undefined, models: readonly AgentModelDefinition[]) {
  if (!raw) return { model: undefined, selector: raw, thinking: undefined };
  // A literal catalog ID (including one ending in :max) wins over effort syntax.
  const exact = models.find((model) => model.id === raw);
  if (exact) return { model: exact, selector: raw, thinking: undefined };
  const alias = models.find((model) => model.aliases?.includes(raw));
  if (alias) return { model: alias, selector: raw, thinking: undefined };
  const separator = raw.lastIndexOf(":");
  const thinking = raw.slice(separator + 1);
  if (separator > 0 && NATIVE_THINKING_OPTIONS[thinking] === true) {
    const selector = raw.slice(0, separator);
    const model =
      models.find((entry) => entry.id === selector) ??
      models.find((entry) => entry.aliases?.includes(selector));
    if (model) return { model, selector, thinking };
  }
  // Unknown selectors/roles remain raw until the user explicitly chooses a model.
  return { model: undefined, selector: raw, thinking: undefined };
}

interface OmpSubagentRowProps {
  serverId: string;
  agent: SubagentEntry;
  models: readonly AgentModelDefinition[];
  modelOptions: SelectFieldOption<string>[];
  catalogLoading: boolean;
  disabled: boolean;
  onChange: (
    agentName: string,
    model: string,
    options?: { fastMode: boolean | "ultrafast" | null },
  ) => void;
}

function OmpSubagentSpeedControl({
  serverId,
  agent,
  model,
  catalogLoading,
  disabled,
  onChange,
}: Pick<OmpSubagentRowProps, "serverId" | "agent" | "catalogLoading" | "disabled" | "onChange"> & {
  model: AgentModelDefinition | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // Share capability probes across rows, without leaking the previous model's data.
  const featuresQuery = useFetchQuery({
    queryKey: ["ompSubagentFeatures", serverId, model?.id ?? null],
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(client && isConnected && model),
    retry: false,
    queryFn: async () => {
      if (!client || !model) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.listProviderFeatures({
        provider: "omp",
        model: model.id,
        cwd: "~",
      });
      if (payload.error) throw new Error(payload.error);
      return payload.features ?? [];
    },
  });
  const fastFeature = model
    ? featuresQuery.data?.find(
        (feature) =>
          feature.id === FAST_MODE_FEATURE_ID &&
          (feature.type === "toggle" || feature.type === "select"),
      )
    : undefined;
  let speedValue = agent.serviceTier ?? DEFAULT_SPEED;
  if (agent.fastMode === "ultrafast") speedValue = "ultrafast";
  else if (agent.fastMode === true) speedValue = "on";
  else if (agent.fastMode === false) speedValue = "off";
  const speedOptions = useMemo<SelectFieldOption<string>[]>(() => {
    if (fastFeature?.type !== "select") return [];
    return [
      {
        id: DEFAULT_SPEED,
        value: DEFAULT_SPEED,
        label: t("settings.host.ompSubagents.ompDefault"),
      },
      ...fastFeature.options
        .filter((option) => ["off", "on", "ultrafast"].includes(option.id))
        .map((option) => ({
          id: option.id,
          value: option.id,
          label: formatAgentFeatureOptionLabel(FAST_MODE_FEATURE_ID, option, t),
          description: formatAgentFeatureOptionDescription(FAST_MODE_FEATURE_ID, option, t),
        })),
    ];
  }, [fastFeature, t]);
  const speedDisplay = useMemo(
    () =>
      speedOptions.find((option) => option.value === speedValue) ?? {
        label: t("settings.host.ompSubagents.currentTier", {
          tier: agent.serviceTier ?? speedValue,
        }),
      },
    [agent.serviceTier, speedOptions, speedValue, t],
  );
  const handleFastChange = useCallback(
    (fastMode: boolean) => {
      if (agent.model) onChange(agent.name, agent.model, { fastMode });
    },
    [agent.model, agent.name, onChange],
  );
  const handleSpeedChange = useCallback(
    (next: string) => {
      if (!agent.model || !speedOptions.some((option) => option.value === next)) return;
      let fastMode: boolean | "ultrafast" | null = next === "on";
      if (next === DEFAULT_SPEED) fastMode = null;
      else if (next === "ultrafast") fastMode = "ultrafast";
      onChange(agent.name, agent.model, { fastMode });
    },
    [agent.model, agent.name, onChange, speedOptions],
  );
  const fastState = useMemo(() => {
    if (agent.fastMode === "ultrafast") {
      return formatAgentFeatureOptionLabel(FAST_MODE_FEATURE_ID, { id: "ultrafast" }, t);
    }
    if (agent.fastMode !== undefined) {
      return t(agent.fastMode ? "shell.commandCenter.settingOn" : "shell.commandCenter.settingOff");
    }
    if (agent.serviceTier) {
      return t("settings.host.ompSubagents.currentTier", { tier: agent.serviceTier });
    }
    return t("settings.host.ompSubagents.ompDefault");
  }, [agent.fastMode, agent.serviceTier, t]);
  if (fastFeature?.type === "select") {
    return (
      <View style={styles.fastMeta} testID={`omp-subagent-fast-row-${agent.name}`}>
        <View style={styles.controlRow}>
          <Text style={styles.controlLabel}>{t("agentControls.features.fast.title")}</Text>
          <View style={styles.thinkingField}>
            <SelectField
              field={false}
              label={t("agentControls.features.fast.title")}
              value={speedValue}
              selectedDisplay={speedDisplay}
              options={speedOptions}
              onChange={handleSpeedChange}
              placeholder={t("settings.host.ompSubagents.ompDefault")}
              emptyText={t("settings.host.ompSubagents.noModels")}
              disabled={disabled || catalogLoading}
              title={t("agentControls.features.fast.title")}
              size="sm"
              testID={`omp-subagent-fast-${agent.name}`}
            />
          </View>
        </View>
        <Text style={styles.mutedText}>
          {t(
            speedOptions.some((option) => option.value === "ultrafast")
              ? "agentControls.features.fast.ultrafastDescription"
              : "shell.commandCenter.fastModeDescription",
          )}
        </Text>
      </View>
    );
  }
  if (fastFeature?.type !== "toggle") return null;
  return (
    <View style={styles.controlRow} testID={`omp-subagent-fast-row-${agent.name}`}>
      <View style={styles.fastMeta}>
        <Text style={styles.controlLabel}>
          {t("shell.commandCenter.fastModeGroupLabel")} · {fastState}
        </Text>
        <Text style={styles.mutedText}>{t("shell.commandCenter.fastModeDescription")}</Text>
      </View>
      <Switch
        value={agent.fastMode === true}
        onValueChange={handleFastChange}
        disabled={disabled || catalogLoading}
        accessibilityLabel={`${t("shell.commandCenter.fastModeGroupLabel")} · ${fastState}`}
        testID={`omp-subagent-fast-${agent.name}`}
      />
    </View>
  );
}

function OmpSubagentRow({
  serverId,
  agent,
  models,
  modelOptions,
  catalogLoading,
  disabled,
  onChange,
}: OmpSubagentRowProps): ReactElement {
  const { t } = useTranslation();
  const { model, selector, thinking } = useMemo(
    () => resolveModelSelector(agent.model, models),
    [agent.model, models],
  );
  const value = selector ?? INHERIT_MODEL;
  const selectedDisplay = useMemo(() => {
    const selected = modelOptions.find((option) => option.value === value);
    const description =
      selected?.description ?? (agent.model !== model?.id ? agent.model : undefined);
    return {
      label: selected?.label ?? model?.label ?? value,
      ...(description ? { description } : {}),
    };
  }, [agent.model, model, modelOptions, value]);
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const supported = (model?.thinkingOptions ?? []).filter(
      (option) => NATIVE_THINKING_OPTIONS[option.id] === true,
    );
    if (supported.length === 0) return [];
    return [
      {
        id: DEFAULT_THINKING,
        value: DEFAULT_THINKING,
        label: t("settings.host.ompSubagents.ompDefault"),
      },
      ...supported.map((option) => {
        const entry: SelectFieldOption<string> = {
          id: option.id,
          value: option.id,
          label: formatThinkingOptionLabel(option),
        };
        if (option.description) entry.description = option.description;
        return entry;
      }),
    ];
  }, [model, t]);
  const thinkingValue = thinking ?? DEFAULT_THINKING;
  const thinkingDisplay = useMemo(
    () =>
      thinkingOptions.find((option) => option.value === thinkingValue) ?? {
        label: thinking ?? t("settings.host.ompSubagents.ompDefault"),
      },
    [thinking, thinkingOptions, thinkingValue, t],
  );
  const handleChange = useCallback(
    (next: string) => onChange(agent.name, next),
    [agent.name, onChange],
  );
  const handleThinkingChange = useCallback(
    (next: string) => {
      if (!selector) return;
      onChange(agent.name, next === DEFAULT_THINKING ? selector : `${selector}:${next}`);
    },
    [agent.name, onChange, selector],
  );

  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.agentRow]}
      testID={`omp-subagent-row-${agent.name}`}
    >
      <View style={styles.agentIdentity}>
        <Text style={styles.agentName}>{agent.name}</Text>
        <Text style={styles.mutedText}>
          {t(`settings.host.ompSubagents.descriptions.${agent.name}`, {
            defaultValue: agent.description,
          })}
        </Text>
      </View>
      <View style={styles.agentControls}>
        <View style={styles.modelField}>
          <SelectField
            field={false}
            label={t("settings.host.ompSubagents.modelLabel")}
            value={value}
            selectedDisplay={selectedDisplay}
            options={modelOptions}
            onChange={handleChange}
            placeholder={t("settings.host.ompSubagents.modelLabel")}
            emptyText={t("settings.host.ompSubagents.noModels")}
            loading={catalogLoading}
            disabled={disabled}
            searchable={modelOptions.length > 7}
            title={t("settings.host.ompSubagents.selectModelTitle", { name: agent.name })}
            size="sm"
            testID={`omp-subagent-model-${agent.name}`}
          />
        </View>
        {thinkingOptions.length > 0 ? (
          <View style={styles.controlRow} testID={`omp-subagent-thinking-row-${agent.name}`}>
            <Text style={styles.controlLabel}>{t("agentControls.thinking.title")}</Text>
            <View style={styles.thinkingField}>
              <SelectField
                field={false}
                label={t("agentControls.thinking.title")}
                value={thinkingValue}
                selectedDisplay={thinkingDisplay}
                options={thinkingOptions}
                onChange={handleThinkingChange}
                placeholder={t("settings.host.ompSubagents.ompDefault")}
                emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
                disabled={disabled || catalogLoading}
                title={t("agentControls.thinking.title")}
                size="sm"
                testID={`omp-subagent-thinking-${agent.name}`}
              />
            </View>
          </View>
        ) : null}
        <OmpSubagentSpeedControl
          serverId={serverId}
          agent={agent}
          model={model}
          catalogLoading={catalogLoading}
          disabled={disabled}
          onChange={onChange}
        />
      </View>
    </View>
  );
}

export function OmpSubagentsSection({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { entries, isLoading: catalogLoading } = useProvidersSnapshot(serverId);
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.ompSubagentSettings === true,
  );
  const [settings, setSettings] = useState<OmpSubagentSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingAgent, setSavingAgent] = useState<string | null>(null);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !isConnected || !isSupported) {
      setSettings(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .getOmpSubagentSettings()
      .then((value) => {
        if (active) setSettings(value);
        return undefined;
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, isConnected, isSupported]);

  const models = useMemo(
    () => entries?.find((entry) => entry.provider === "omp")?.models ?? [],
    [entries],
  );
  const modelOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const selectableModels = models
      .filter((model) => model.isSelectable !== false)
      .map((model) => {
        const option: SelectFieldOption<string> = {
          id: model.id,
          value: model.id,
          label: model.label,
        };
        if (model.description) option.description = model.description;
        return option;
      });
    return [
      {
        id: INHERIT_MODEL,
        value: INHERIT_MODEL,
        label: t("settings.host.ompSubagents.inherit"),
        description: t("settings.host.ompSubagents.inheritHint"),
      },
      ...selectableModels,
    ];
  }, [models, t]);

  const updateModel = useCallback(
    async (
      agentName: string,
      value: string,
      options?: { fastMode: boolean | "ultrafast" | null },
    ) => {
      if (!client) return;
      setSavingAgent(agentName);
      setError(null);
      try {
        setSettings(
          await client.updateOmpSubagentModel(
            agentName,
            value === INHERIT_MODEL ? null : value,
            options,
          ),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingAgent(null);
      }
    },
    [client],
  );

  const updateEnabled = useCallback(
    async (enabled: boolean) => {
      if (!client) return;
      setSavingEnabled(true);
      setError(null);
      try {
        setSettings(await client.updateOmpSubagentSettingsEnabled(enabled));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingEnabled(false);
      }
    },
    [client],
  );

  let content: ReactNode;
  if (!isConnected) {
    content = (
      <View style={styles.messageRow}>
        <Text style={styles.mutedText}>{t("settings.host.ompSubagents.unavailable")}</Text>
      </View>
    );
  } else if (!isSupported) {
    content = (
      <View style={styles.messageRow}>
        <Text style={styles.mutedText}>{t("settings.host.ompSubagents.unsupported")}</Text>
      </View>
    );
  } else if (error && !settings) {
    content = (
      <View style={styles.messageRow}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  } else if (loading && !settings) {
    content = (
      <View style={styles.messageRow}>
        <Text style={styles.mutedText}>{t("settings.host.ompSubagents.loading")}</Text>
      </View>
    );
  } else {
    content = settings ? (
      <>
        <View style={settingsStyles.row} testID="omp-subagent-overrides-toggle-row">
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.ompSubagents.overrideEnabled")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.ompSubagents.overrideEnabledHint")}
            </Text>
          </View>
          <Switch
            value={settings.enabled}
            onValueChange={updateEnabled}
            disabled={savingEnabled || savingAgent !== null}
            accessibilityLabel={t("settings.host.ompSubagents.overrideEnabled")}
          />
        </View>
        {settings.agents.map((agent) => (
          <OmpSubagentRow
            key={agent.name}
            serverId={serverId}
            agent={agent}
            models={models}
            modelOptions={modelOptions}
            catalogLoading={catalogLoading}
            disabled={!settings.enabled || savingEnabled || savingAgent !== null}
            onChange={updateModel}
          />
        ))}
      </>
    ) : null;
  }

  return (
    <SettingsSection
      title={t("settings.host.ompSubagents.sectionTitle")}
      testID="omp-subagents-section"
    >
      <View style={settingsStyles.card} testID="omp-subagents-card">
        {content}
        {settings ? (
          <View style={styles.footer}>
            <Text style={styles.mutedText} selectable>
              {t("settings.host.ompSubagents.configPath", { path: settings.configPath })}
            </Text>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  agentIdentity: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  agentName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  agentControls: {
    flexGrow: 1,
    flexBasis: 280,
    minWidth: 0,
    maxWidth: "100%",
    gap: theme.spacing[3],
  },
  modelField: {
    width: "100%",
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  controlLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  thinkingField: {
    flex: 1,
    minWidth: 0,
  },
  fastMeta: {
    flex: 1,
    gap: theme.spacing[1],
  },
  messageRow: {
    padding: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    gap: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
