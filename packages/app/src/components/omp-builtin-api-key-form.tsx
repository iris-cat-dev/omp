import { ExternalLink } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";

function officialApiKeyUrl(providerId: string): string | undefined {
  switch (providerId) {
    case "anthropic":
      return "https://platform.claude.com/settings/keys";
    case "deepseek":
      return "https://platform.deepseek.com/api_keys";
    case "google":
      return "https://aistudio.google.com/api-keys";
    case "mistral":
      return "https://console.mistral.ai/api-keys";
    case "openai":
      return "https://platform.openai.com/api-keys";
    case "openrouter":
      return "https://openrouter.ai/settings/keys";
  }
}

export function OmpBuiltinApiKeyForm({
  providerId,
  providerName,
  onSave,
  onCancel,
}: {
  providerId: string;
  providerName: string;
  onSave: (providerId: string, apiKey: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const keyUrl = officialApiKeyUrl(providerId);
  const inputLabel = t("settings.providers.omp.apiKeyForm.label", { provider: providerName });
  const [apiKey, setApiKey] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const pending = useRef(false);
  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setSaveFailed(false);
  }, []);
  const openKeyPage = useCallback(() => {
    if (!keyUrl) return;
    setLinkFailed(false);
    void openExternalUrl(keyUrl).catch(() => setLinkFailed(true));
  }, [keyUrl]);
  const save = useCallback(async () => {
    const key = apiKey.trim();
    if (!key || pending.current) return;
    pending.current = true;
    setSaving(true);
    setSaveFailed(false);
    setApiKey("");
    setResetKey((current) => current + 1);
    try {
      await onSave(providerId, key);
    } catch {
      // A host/provider error can contain the submitted credential.
      setSaveFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }, [apiKey, onSave, providerId]);
  const handleSave = useCallback(() => void save(), [save]);
  const inputAccessibilityState = useMemo(() => ({ disabled: saving }), [saving]);

  return (
    <View style={styles.form} testID="omp-builtin-api-key-form">
      <View style={styles.field}>
        <Text style={settingsStyles.rowTitle}>{inputLabel}</Text>
        <AdaptiveTextInput
          accessibilityLabel={inputLabel}
          accessibilityState={inputAccessibilityState}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          editable={!saving}
          initialValue=""
          onChangeText={changeApiKey}
          onSubmitEditing={handleSave}
          resetKey={resetKey}
          secureTextEntry
          spellCheck={false}
          style={styles.input}
          testID="omp-builtin-api-key-input"
        />
        {saveFailed ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {t("settings.providers.omp.apiKeyForm.saveFailed")}
          </Text>
        ) : null}
        {keyUrl ? (
          <Button
            accessibilityRole="link"
            leftIcon={ExternalLink}
            onPress={openKeyPage}
            size="sm"
            style={styles.link}
            variant="ghost"
          >
            {t("settings.providers.omp.apiKeyForm.getKey", { provider: providerName })}
          </Button>
        ) : null}
        {linkFailed ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {t("settings.providers.omp.apiKeyForm.linkFailed")}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button disabled={saving} onPress={onCancel} size="sm" variant="secondary">
          {t("common.actions.cancel")}
        </Button>
        <Button disabled={saving || !apiKey.trim()} onPress={handleSave} size="sm" variant="default">
          {t(
            saving
              ? "settings.providers.omp.apiKeyForm.saving"
              : "settings.providers.omp.apiKeyForm.save",
          )}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[3] },
  field: { gap: theme.spacing[2] },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  link: { alignSelf: "flex-start" },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
