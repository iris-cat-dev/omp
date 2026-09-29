import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@omp-desktop/protocol/messages";

import { formatOmpAccountSelectionLabel } from "@/components/omp-provider-accounts";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useOmpAccountQuota } from "@/hooks/use-omp-account-quota";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

type ImageGenerationBackend = "openai-api" | "chatgpt-subscription";

interface PersistedImageGenerationSettings {
  backend: ImageGenerationBackend;
  model: string;
  baseUrl: string;
  subscriptionCredentialId: number | null;
  enabled: boolean;
  apiKeyConfigured: boolean;
  apiKeySource: "environment" | "config" | null;
}

function resolvePersistedImageGenerationSettings(
  persisted: MutableDaemonConfig["imageGeneration"],
): PersistedImageGenerationSettings {
  return {
    backend: persisted?.backend ?? "openai-api",
    model: persisted?.model ?? "gpt-image-2",
    baseUrl: persisted?.baseUrl ?? "",
    subscriptionCredentialId: persisted?.subscriptionCredentialId ?? null,
    enabled: persisted?.enabled === true,
    apiKeyConfigured: persisted?.apiKeyConfigured === true,
    apiKeySource: persisted?.apiKeySource ?? null,
  };
}

interface ImageGenerationChangeInput {
  backend: ImageGenerationBackend;
  model: string;
  baseUrl: string;
  apiKey: string;
  selectedCredentialId: number | null;
  persisted: PersistedImageGenerationSettings;
}

function imageGenerationSettingsChanged(input: ImageGenerationChangeInput): boolean {
  if (input.backend !== input.persisted.backend) {
    return true;
  }
  if (input.backend === "chatgpt-subscription") {
    return input.selectedCredentialId !== input.persisted.subscriptionCredentialId;
  }
  return (
    input.model !== input.persisted.model ||
    input.baseUrl !== input.persisted.baseUrl ||
    input.apiKey.length > 0
  );
}

interface ImageGenerationSettingsCardProps {
  backend: ImageGenerationBackend;
  sourceOptions: SegmentedControlOption<ImageGenerationBackend>[];
  enabled: boolean;
  status: string;
  isSourceConfigured: boolean;
  toolsEnabled: boolean;
  persistedModel: string;
  persistedBaseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyIsEnvironmentControlled: boolean;
  selectedCredentialId: number | null;
  selectedAccountDisplay: SelectFieldDisplay | null;
  accountOptions: SelectFieldOption<number>[];
  accountsLoading: boolean;
  isSaving: boolean;
  hasChanges: boolean;
  normalizedModel: string;
  showRemoveApiKey: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onBackendChange: (backend: ImageGenerationBackend) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (baseUrl: string) => void;
  onApiKeyChange: (apiKey: string) => void;
  onSubscriptionCredentialChange: (credentialId: number) => void;
  onSave: () => void;
  onRemoveApiKey: () => void;
}

function ImageGenerationSettingsCard({
  backend,
  sourceOptions,
  enabled,
  status,
  isSourceConfigured,
  toolsEnabled,
  persistedModel,
  persistedBaseUrl,
  apiKeyConfigured,
  apiKeyIsEnvironmentControlled,
  selectedCredentialId,
  selectedAccountDisplay,
  accountOptions,
  accountsLoading,
  isSaving,
  hasChanges,
  normalizedModel,
  showRemoveApiKey,
  onEnabledChange,
  onBackendChange,
  onModelChange,
  onBaseUrlChange,
  onApiKeyChange,
  onSubscriptionCredentialChange,
  onSave,
  onRemoveApiKey,
}: ImageGenerationSettingsCardProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("settings.imageGeneration.title")} testID="image-generation-settings">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.imageGeneration.enabled")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.imageGeneration.description")}</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={onEnabledChange}
            disabled={isSaving || hasChanges}
            accessibilityLabel={t("settings.imageGeneration.enabledAccessibilityLabel")}
          />
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.sourceRow]}>
          <View style={[settingsStyles.rowContent, styles.sourceRowContent]}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.imageGeneration.source.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("settings.imageGeneration.source.hint")}</Text>
          </View>
          <SegmentedControl
            options={sourceOptions}
            value={backend}
            onValueChange={onBackendChange}
            size="sm"
            style={styles.sourceControl}
            testID="image-generation-source"
          />
        </View>

        <View style={styles.body}>
          <View style={styles.statusPanel} testID="image-generation-status">
            <View
              style={[
                styles.statusDot,
                isSourceConfigured ? styles.statusReady : styles.statusPending,
              ]}
            />
            <Text style={styles.status}>{status}</Text>
          </View>
          {!toolsEnabled ? (
            <Text style={styles.warning}>{t("settings.imageGeneration.toolsDisabled")}</Text>
          ) : null}

          {backend === "openai-api" ? (
            <View style={styles.form}>
              <Field label={t("settings.imageGeneration.model")}>
                <FormTextInput
                  initialValue={persistedModel}
                  resetKey={persistedModel}
                  onChangeText={onModelChange}
                  editable={!isSaving}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="image-generation-model"
                />
              </Field>
              <Field label={t("settings.imageGeneration.baseUrl")}>
                <FormTextInput
                  initialValue={persistedBaseUrl}
                  resetKey={persistedBaseUrl}
                  onChangeText={onBaseUrlChange}
                  editable={!isSaving}
                  placeholder="https://api.openai.com/v1"
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="image-generation-base-url"
                />
              </Field>
              <Field label={t("settings.imageGeneration.apiKey")}>
                <FormTextInput
                  initialValue=""
                  resetKey={`${apiKeyConfigured}:${isSaving}`}
                  onChangeText={onApiKeyChange}
                  editable={!isSaving && !apiKeyIsEnvironmentControlled}
                  placeholder={
                    apiKeyConfigured
                      ? t("settings.imageGeneration.apiKeyConfiguredPlaceholder")
                      : t("settings.imageGeneration.apiKeyPlaceholder")
                  }
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="image-generation-api-key"
                />
              </Field>
            </View>
          ) : (
            <View style={styles.form}>
              <SelectField
                label={t("settings.imageGeneration.subscriptionAccount")}
                value={selectedCredentialId}
                selectedDisplay={selectedAccountDisplay}
                options={accountOptions}
                onChange={onSubscriptionCredentialChange}
                placeholder={t("settings.imageGeneration.subscriptionAccountPlaceholder")}
                emptyText={t("settings.imageGeneration.subscriptionAccountEmpty")}
                loading={accountsLoading}
                disabled={isSaving}
                hint={t("settings.imageGeneration.subscriptionHint")}
                testID="image-generation-subscription-account"
              />
              <Field label={t("settings.imageGeneration.model")}>
                <View style={styles.readOnlyValue}>
                  <Text style={styles.fixedValue}>gpt-image-2</Text>
                </View>
              </Field>
            </View>
          )}

          <View style={styles.actions}>
            {showRemoveApiKey ? (
              <Button
                variant="outline"
                size="sm"
                onPress={onRemoveApiKey}
                disabled={isSaving}
                testID="image-generation-remove-key"
              >
                {t("settings.imageGeneration.removeApiKey")}
              </Button>
            ) : null}
            <Button
              variant="default"
              size="sm"
              style={styles.saveAction}
              onPress={onSave}
              disabled={
                !hasChanges ||
                isSaving ||
                (backend === "openai-api" ? !normalizedModel : selectedCredentialId === null)
              }
              testID="image-generation-save"
            >
              {isSaving ? t("settings.imageGeneration.saving") : t("settings.imageGeneration.save")}
            </Button>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}
export function ImageGenerationSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.imageGenerationConfig === true,
  );
  const subscriptionSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.imageGenerationSubscription === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persistedSettings = resolvePersistedImageGenerationSettings(config?.imageGeneration);
  const {
    backend: persistedBackend,
    model: persistedModel,
    baseUrl: persistedBaseUrl,
    subscriptionCredentialId: persistedSubscriptionCredentialId,
  } = persistedSettings;
  const [backend, setBackend] = useState<ImageGenerationBackend>(persistedBackend);
  const [model, setModel] = useState(persistedModel);
  const [baseUrl, setBaseUrl] = useState(persistedBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [subscriptionCredentialId, setSubscriptionCredentialId] = useState<number | null>(
    persistedSubscriptionCredentialId,
  );
  const [isSaving, setIsSaving] = useState(false);
  const { accounts, loading: accountsLoading } = useOmpAccountQuota(
    serverId,
    backend === "chatgpt-subscription" ? "openai-codex" : null,
    backend === "chatgpt-subscription" ? "gpt-image-2" : null,
  );

  useEffect(() => {
    setBackend(persistedBackend);
    setModel(persistedModel);
    setBaseUrl(persistedBaseUrl);
    setSubscriptionCredentialId(persistedSubscriptionCredentialId);
  }, [persistedBackend, persistedBaseUrl, persistedModel, persistedSubscriptionCredentialId]);

  const accountOptions = useMemo<SelectFieldOption<number>[]>(
    () =>
      accounts.map((account, index) => ({
        id: String(account.credentialId),
        value: account.credentialId,
        label: formatOmpAccountSelectionLabel({
          note: account.note,
          identityKey: account.identityKey,
          fallback: t("settings.imageGeneration.accountFallback", { number: index + 1 }),
        }),
        description: account.quota?.planLabel ?? undefined,
      })),
    [accounts, t],
  );
  const selectedCredentialId = useMemo(() => {
    if (subscriptionCredentialId !== null) {
      return subscriptionCredentialId;
    }
    return accounts.length === 1 ? accounts[0]!.credentialId : null;
  }, [accounts, subscriptionCredentialId]);
  const selectedAccountOption = useMemo(
    () => accountOptions.find((option) => option.value === selectedCredentialId) ?? null,
    [accountOptions, selectedCredentialId],
  );
  const selectedAccountDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!selectedAccountOption) {
      return null;
    }
    return {
      label: selectedAccountOption.label,
      description: selectedAccountOption.description,
    };
  }, [selectedAccountOption]);

  const normalizedModel = model.trim();
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedApiKey = apiKey.trim();
  const hasChanges = imageGenerationSettingsChanged({
    backend,
    model: normalizedModel,
    baseUrl: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    selectedCredentialId,
    persisted: persistedSettings,
  });
  const toolsEnabled = config?.mcp.injectIntoAgents !== false;
  const apiKeyIsEnvironmentControlled = persistedSettings.apiKeySource === "environment";

  const status = useMemo(() => {
    if (backend === "chatgpt-subscription") {
      if (accounts.length === 0) {
        return t("settings.imageGeneration.status.noSubscriptionAccount");
      }
      if (!selectedAccountOption) {
        return t("settings.imageGeneration.status.selectSubscriptionAccount");
      }
      return t("settings.imageGeneration.status.subscriptionConfigured", {
        account: selectedAccountOption.label,
        plan: selectedAccountOption.description ?? t("settings.imageGeneration.unknownPlan"),
      });
    }
    if (!persistedSettings.apiKeyConfigured) {
      return t("settings.imageGeneration.status.notConfigured");
    }
    if (persistedSettings.apiKeySource === "environment") {
      return t("settings.imageGeneration.status.environment");
    }
    return t("settings.imageGeneration.status.configured");
  }, [
    accounts.length,
    backend,
    persistedSettings.apiKeyConfigured,
    persistedSettings.apiKeySource,
    selectedAccountOption,
    t,
  ]);

  const isSourceConfigured = useMemo(() => {
    if (backend === "chatgpt-subscription") {
      return selectedAccountOption !== null;
    }
    return persistedSettings.apiKeyConfigured;
  }, [backend, persistedSettings.apiKeyConfigured, selectedAccountOption]);

  const sourceOptions = useMemo(
    () => [
      {
        value: "openai-api" as const,
        label: t("settings.imageGeneration.source.api"),
        testID: "image-generation-source-api",
      },
      ...(subscriptionSupported
        ? [
            {
              value: "chatgpt-subscription" as const,
              label: t("settings.imageGeneration.source.subscription"),
              testID: "image-generation-source-subscription",
            },
          ]
        : []),
    ],
    [subscriptionSupported, t],
  );

  const showError = useCallback(
    (error: unknown) => {
      Alert.alert(
        t("settings.imageGeneration.saveError"),
        error instanceof Error ? error.message : String(error),
      );
    },
    [t],
  );

  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      void patchConfig({ imageGeneration: { enabled } }).catch(showError);
    },
    [patchConfig, showError],
  );

  const handleSave = useCallback(() => {
    if (backend === "openai-api" && !normalizedModel) return;
    if (backend === "chatgpt-subscription" && selectedCredentialId === null) return;
    const imageGeneration: NonNullable<MutableDaemonConfigPatch["imageGeneration"]> = {};
    if (backend !== persistedBackend) imageGeneration.backend = backend;
    if (backend === "openai-api") {
      if (normalizedModel !== persistedModel) imageGeneration.model = normalizedModel;
      if (normalizedBaseUrl !== persistedBaseUrl) {
        imageGeneration.baseUrl = normalizedBaseUrl || null;
      }
      if (normalizedApiKey) imageGeneration.apiKey = normalizedApiKey;
    } else if (selectedCredentialId !== persistedSubscriptionCredentialId) {
      imageGeneration.subscriptionCredentialId = selectedCredentialId;
    }

    setIsSaving(true);
    void patchConfig({ imageGeneration })
      .then(() => setApiKey(""))
      .catch(showError)
      .finally(() => setIsSaving(false));
  }, [
    backend,
    normalizedApiKey,
    normalizedBaseUrl,
    normalizedModel,
    patchConfig,
    persistedBackend,
    persistedBaseUrl,
    persistedModel,
    persistedSubscriptionCredentialId,
    selectedCredentialId,
    showError,
  ]);

  const handleRemoveApiKey = useCallback(() => {
    setIsSaving(true);
    void patchConfig({
      imageGeneration: {
        apiKey: null,
        ...(persistedBackend === "openai-api" ? { enabled: false } : {}),
      },
    })
      .then(() => setApiKey(""))
      .catch(showError)
      .finally(() => setIsSaving(false));
  }, [patchConfig, persistedBackend, showError]);

  if (!isConnected || !isSupported) return null;

  return (
    <ImageGenerationSettingsCard
      backend={backend}
      sourceOptions={sourceOptions}
      enabled={persistedSettings.enabled}
      status={status}
      isSourceConfigured={isSourceConfigured}
      toolsEnabled={toolsEnabled}
      persistedModel={persistedModel}
      persistedBaseUrl={persistedBaseUrl}
      apiKeyConfigured={persistedSettings.apiKeyConfigured}
      apiKeyIsEnvironmentControlled={apiKeyIsEnvironmentControlled}
      selectedCredentialId={selectedCredentialId}
      selectedAccountDisplay={selectedAccountDisplay}
      accountOptions={accountOptions}
      accountsLoading={accountsLoading}
      isSaving={isSaving}
      hasChanges={hasChanges}
      normalizedModel={normalizedModel}
      showRemoveApiKey={persistedSettings.apiKeySource === "config"}
      onEnabledChange={handleEnabledChange}
      onBackendChange={setBackend}
      onModelChange={setModel}
      onBaseUrlChange={setBaseUrl}
      onApiKeyChange={setApiKey}
      onSubscriptionCredentialChange={setSubscriptionCredentialId}
      onSave={handleSave}
      onRemoveApiKey={handleRemoveApiKey}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  sourceRow: {
    alignItems: { xs: "stretch", md: "center" },
    flexDirection: { xs: "column", md: "row" },
    gap: { xs: theme.spacing[3], md: 0 },
  },
  sourceRowContent: {
    marginRight: { xs: 0, md: theme.spacing[3] },
  },
  sourceControl: {
    alignSelf: { xs: "flex-start", md: "auto" },
  },
  body: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  statusPanel: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  statusReady: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusPending: {
    backgroundColor: theme.colors.statusWarning,
  },
  status: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
  warning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
  form: {
    gap: theme.spacing[4],
  },
  readOnlyValue: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  fixedValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    alignItems: "center",
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  saveAction: {
    marginLeft: "auto",
  },
}));
