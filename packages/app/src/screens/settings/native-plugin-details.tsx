import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { OmpPluginManagement } from "@omp-desktop/protocol/messages";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";

export interface NativePluginDetailsProps {
  client: DaemonClient;
  name: string;
  scope?: "user" | "project";
  cwd?: string;
  onChanged?: () => void;
}

const clientIds = new WeakMap<DaemonClient, number>();
let nextClientId = 0;

export function NativePluginDetails(props: NativePluginDetailsProps) {
  let clientId = clientIds.get(props.client);
  if (clientId === undefined) { clientId = ++nextClientId; clientIds.set(props.client, clientId); }
  return <NativePluginDetailsForm key={JSON.stringify([clientId, props.name, props.scope ?? "active", props.cwd ?? ""])} {...props} />;
}

function NativePluginDetailsForm({ client, name, scope, cwd, onChanged }: NativePluginDetailsProps) {
  const { t } = useTranslation();
  const [management, setManagement] = useState<OmpPluginManagement | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [features, setFeatures] = useState<string[] | null>(null);
  const [featureDirty, setFeatureDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const [resetVersion, setResetVersion] = useState(0);
  const reset = (value: OmpPluginManagement) => {
    setResetVersion(previous => previous + 1);
    setManagement(value);
    setDrafts(Object.fromEntries(Object.entries(value.settings).map(([key, item]) => [key, String(item)])));
    setFeatures(value.enabledFeatures);
    setDirty(new Set());
    setDeleted(new Set());
    setFeatureDirty(false);
  };
  useEffect(() => {
    const generation = ++epoch.current;
    setManagement(null);
    setError(null);
    client.getOmpPluginManagement({ name, scope, cwd }).then(({ management: value }) => {
      if (epoch.current === generation) reset(value);
    }).catch((failure: unknown) => {
      if (epoch.current === generation) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { epoch.current++; };
  }, [client, name, scope, cwd]);

  const edit = (key: string, value: string) => {
    setDrafts(previous => ({ ...previous, [key]: value }));
    setDirty(previous => new Set(previous).add(key));
    setDeleted(previous => { const next = new Set(previous); next.delete(key); return next; });
  };
  const save = async () => {
    if (!management || busy) return;
    const settings: Record<string, string | number | boolean> = {};
    for (const key of dirty) {
      const definition = management.schema[key];
      const text = drafts[key] ?? "";
      const value = definition.type === "number" ? Number(text) : definition.type === "boolean" ? text === "true" : text;
      if ((definition.type === "number" && (text.trim() === "" || !Number.isFinite(value) || (definition.min !== undefined && Number(value) < definition.min) || (definition.max !== undefined && Number(value) > definition.max))) || (definition.type === "enum" && !definition.values?.includes(text))) {
        setError(t("nativePlugin.details.invalidValue", { defaultValue: "配置值无效：{{key}}", key }));
        return;
      }
      settings[key] = value;
    }
    const generation = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await client.updateOmpPluginManagement({ name, scope: management.scope, cwd, patch: { settings, deleteSettings: [...deleted], ...(featureDirty ? { enabledFeatures: features } : {}) } });
      if (epoch.current === generation) { reset(result.management); onChanged?.(); }
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (epoch.current === generation) setBusy(false);
    }
  };
  return <View style={{ gap: 16 }}>
    {error ? <Text accessibilityRole="alert" style={settingsStyles.rowHint}>{error}</Text> : null}
    {!management ? <Text style={settingsStyles.rowHint}>{error ? t("nativePlugin.details.unavailable", { defaultValue: "选定 OMP 运行时不支持此配置操作，请使用该配置档案的 OMP CLI。" }) : t("nativePlugin.details.loading", { defaultValue: "正在读取原生配置…" })}</Text> : <>
      <Text style={settingsStyles.rowHint}>{t("nativePlugin.details.appliesTo", { defaultValue: "更改在新建或恢复的会话中生效，运行中的对话不会重启。" })}</Text>
      {management.featuresOverridden ? <Text style={settingsStyles.rowHint}>{t("nativePlugin.details.featureOverride", { defaultValue: "此工作区的功能覆盖仍优先；这里修改的是安装项自身的功能选择。" })}</Text> : null}
      <Field label={t("nativePlugin.details.features", { defaultValue: "可选功能" })}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button variant={features === null ? "default" : "outline"} disabled={busy} onPress={() => { setFeatures(null); setFeatureDirty(true); }}>{t("nativePlugin.details.defaults", { defaultValue: "使用默认功能" })}</Button>
            <Button variant={features !== null ? "default" : "outline"} disabled={busy} onPress={() => { setFeatures([]); setFeatureDirty(true); }}>{t("nativePlugin.details.custom", { defaultValue: "自定义（可全部关闭）" })}</Button>
          </View>
          {Object.entries(management.availableFeatures).map(([key, feature]) => <Field key={key} label={key} hint={feature.description}>
            <Switch value={(features ?? management.effectiveFeatures).includes(key)} disabled={busy || features === null} onValueChange={(enabled) => { setFeatures(previous => enabled ? [...(previous ?? []), key] : (previous ?? []).filter(item => item !== key)); setFeatureDirty(true); }} />
          </Field>)}
        </View>
      </Field>
      {Object.entries(management.schema).map(([key, definition]) => <Field key={key} label={key} hint={definition.description}>
        {management.overriddenSettings.includes(key) ? <Text style={settingsStyles.rowHint}>{t("nativePlugin.details.settingOverride", { defaultValue: "此工作区的配置覆盖仍优先；这里修改的是安装项自身的配置。" })}</Text> : null}
        {definition.secret ? <Text style={settingsStyles.rowHint}>{management.secretConfigured[key] ? t("nativePlugin.details.secretConfigured", { defaultValue: "已配置" }) : t("nativePlugin.details.secretNotConfigured", { defaultValue: "未配置" })} · {t("nativePlugin.details.secretUnavailable", { defaultValue: "Desktop 不支持敏感输入，请使用选定 OMP CLI；不会显示或读取密钥。" })}</Text> : <View style={{ gap: 8 }}>
          {definition.type === "boolean" ? <Switch value={drafts[key] === "true"} disabled={busy || deleted.has(key)} onValueChange={value => edit(key, String(value))} /> : definition.type === "enum" ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{definition.values?.map(value => <Button key={value} variant={drafts[key] === value ? "default" : "outline"} disabled={busy || deleted.has(key)} onPress={() => edit(key, value)}>{value}</Button>)}</View> : <FormTextInput resetKey={`${resetVersion}:${deleted.has(key)}`} initialValue={deleted.has(key) ? "" : drafts[key] ?? ""} editable={!busy && !deleted.has(key)} onChangeText={value => edit(key, value)} />}
          <Button variant="ghost" disabled={busy} onPress={() => { setDeleted(previous => new Set(previous).add(key)); setDirty(previous => { const next = new Set(previous); next.delete(key); return next; }); }}>{t("nativePlugin.details.reset", { defaultValue: "移除此配置值，使用环境或默认值" })}</Button>
        </View>}
      </Field>)}
      <Button disabled={busy || (!dirty.size && !deleted.size && !featureDirty)} onPress={() => void save()}>{busy ? t("nativePlugin.details.saving", { defaultValue: "正在保存…" }) : t("nativePlugin.details.save", { defaultValue: "保存原生配置" })}</Button>
    </>}
  </View>;
}
