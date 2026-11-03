import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProxyPolicySchema, type ProxyPolicy, type ProxyRoute } from "@omp-desktop/protocol/provider-config";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

const DIRECT_POLICY: ProxyPolicy = { enabled: false };

function ProxyRouteField({ label, route, onChange, disabled, testID, policyKey }: {
  label: string; route: ProxyRoute | undefined; onChange: (route: ProxyRoute | undefined) => void;
  disabled: boolean; testID: string; policyKey: string;
}) {
  const { t } = useTranslation();
  const options = ["inherit", "direct", "proxy"].map((id) => ({ id, value: id, label: t(`settings.host.orchestration.proxy.${id}`) }));
  const mode = route?.mode ?? "inherit";
  return <View style={styles.route}>
    <SelectField label={label} value={mode} selectedDisplay={options.find((option) => option.id === mode) ?? null}
      options={options} onChange={(value) => onChange(value === "inherit" ? undefined : value === "direct" ? { mode: "direct" } : { mode: "proxy", url: "" })}
      placeholder={options[0]!.label} emptyText={options[0]!.label} disabled={disabled} title={label} testID={testID} />
    {route?.mode === "proxy" ? <Field label={t("settings.host.orchestration.proxy.accessibilityLabel")}>
      <FormTextInput initialValue={route.url} resetKey={`${testID}-${mode}-${policyKey}`} onChangeText={(url) => onChange({ mode: "proxy", url })}
        placeholder={t("settings.host.orchestration.proxy.placeholder")} autoCapitalize="none" autoCorrect={false}
        editable={!disabled} testID={`${testID}-url`} />
    </Field> : null}
  </View>;
}

export function ProxyPolicyEditor(props: Parameters<typeof ProxyPolicyEditorForm>[0]) {
  const policyKey = JSON.stringify([props.serverId, props.policy]);
  return <ProxyPolicyEditorForm key={policyKey} {...props} />;
}

function ProxyPolicyEditorForm({ serverId, policy, onSave, disabled = false, testID }: {
  serverId: string; policy: ProxyPolicy | undefined;
  onSave: (policy: ProxyPolicy) => Promise<void>; disabled?: boolean; testID: string;
}) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [draft, setDraft] = useState(policy ?? DIRECT_POLICY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policyKey = JSON.stringify(policy ?? DIRECT_POLICY);
  const management = useQuery({
    queryKey: ["ompProxyModelProviders", serverId],
    queryFn: async () => { if (!client) throw new Error("Host unavailable"); return client.getOmpProviderManagement(); },
    enabled: Boolean(client && !disabled), staleTime: 0,
  });
  const providers = Array.from(new Set([
    ...(management.data?.providerModels.map((provider) => provider.id) ?? []),
    ...Object.keys(draft.providers ?? {}),
  ])).sort();
  const changed = JSON.stringify(draft) !== JSON.stringify(policy ?? DIRECT_POLICY);
  const valid = ProxyPolicySchema.safeParse(draft).success;
  const controlsDisabled = disabled || saving;
  async function save() {
    setSaving(true); setError(null);
    try { await onSave(ProxyPolicySchema.parse(draft)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <View style={styles.editor} testID={testID}>
    <Text style={settingsStyles.rowTitle}>{t("settings.host.orchestration.proxy.title")}</Text>
    <Text style={settingsStyles.rowHint}>{t("settings.host.orchestration.proxy.hint")}</Text>
    <View style={settingsStyles.row}>
      <Text style={settingsStyles.rowTitle}>{t("settings.host.orchestration.proxy.enabled")}</Text>
      <Switch value={draft.enabled} onValueChange={(enabled) => setDraft({ ...draft, enabled })} disabled={controlsDisabled} testID={`${testID}-switch`} />
    </View>
    <ProxyRouteField label={t("settings.host.orchestration.proxy.defaultRoute")} route={draft.default}
      onChange={(route) => { const next = { ...draft }; if (route) next.default = route; else delete next.default; setDraft(next); }}
      disabled={controlsDisabled} policyKey={policyKey} testID={`${testID}-default`} />
    {providers.map((provider) => <ProxyRouteField key={provider} label={provider} route={draft.providers?.[provider]}
      onChange={(route) => { const overrides = { ...draft.providers }; if (route) overrides[provider] = route; else delete overrides[provider]; setDraft({ ...draft, providers: overrides }); }}
      disabled={controlsDisabled} policyKey={policyKey} testID={`${testID}-provider-${provider}`} />)}
    <Field label={t("settings.host.orchestration.proxy.noProxy")} hint={t("settings.host.orchestration.proxy.noProxyHint")}>
      <FormTextInput initialValue={draft.noProxy?.join(", ") ?? ""} resetKey={policyKey}
        onChangeText={(value) => setDraft({ ...draft, noProxy: value.split(",").map((entry) => entry.trim()).filter(Boolean) })}
        editable={!controlsDisabled} autoCapitalize="none" autoCorrect={false} testID={`${testID}-no-proxy`} />
    </Field>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <Button onPress={save} disabled={!changed || !valid || disabled || saving} loading={saving} testID={`${testID}-save`}>
      {t(`settings.host.orchestration.proxy.${saving ? "saving" : "save"}`)}
    </Button>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  editor: { gap: theme.spacing[3], padding: theme.spacing[3] },
  route: { gap: theme.spacing[2] },
  error: { color: theme.colors.destructive },
}));
