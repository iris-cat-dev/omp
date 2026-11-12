import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import type { PluginClientContext, PluginSettingsPageProps, PluginStorageSnapshot } from "@omp-desktop/plugin";
import { DEFAULT_PET_CONFIG, PetConfigSchema } from "./config.js";
import { getDesktopPetClientHost } from "./client-host.js";
import { deriveDesktopPetTasks } from "./model.js";
import { launchDesktopPetCreation } from "./creation.js";
import { getPetAuthoringDraft } from "./authoring-draft.js";
import type { DesktopPetActivity, DesktopPetActivityResult, DesktopPetSettings, PetDescriptor, PetSize } from "./types.js";
export { configureDesktopPetClientHost } from "./client-host.js";
export type { DesktopPetClientHost, PetCreationHost, PetActivitySnapshot, PetHostActivity, PetActivityAgent, PetCreationDraft } from "./client-host.js";
export default function setup(ctx: PluginClientContext) {
  const Settings = (props: PluginSettingsPageProps) => <DesktopPetSettingsPage {...props} context={ctx} />;
  ctx.addSettingsPage({ id: "settings", title: "Desktop pet", icon: "paw-print", Component: Settings });
  if (ctx.mode === "active") ctx.addOverlay({ id: "pet", Component: () => <DesktopPetActivitySync context={ctx} /> });
}
function usePetConfiguration(ctx: PluginClientContext) {
  const [snapshot, setSnapshot] = useState<PluginStorageSnapshot<DesktopPetSettings>>({ revision: -1, values: DEFAULT_PET_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const host = getDesktopPetClientHost();
  const { t } = host.useTranslation();
  const feedback = host.useFeedback();
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const raw = await ctx.storage.get();
      const next = { revision: raw.revision, values: PetConfigSchema.parse(raw.values) };
      if (!disposed && next.revision >= current.current.revision) { current.current = next; setSnapshot(next); }
    };
    const remove = ctx.native.subscribe("plugins:changed", () => { void load().catch((error) => feedback.reportError(error, t("desktop.settings.loadFailed"))); });
    void load().catch((error) => feedback.reportError(error, t("desktop.settings.loadFailed"))).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; void remove(); };
  }, [ctx, feedback, t]);
  const patch = async (values: Partial<DesktopPetSettings>) => {
    setSaving(true);
    try { const raw = await ctx.storage.patch(values, current.current.revision); const next = { revision: raw.revision, values: PetConfigSchema.parse(raw.values) }; current.current = next; setSnapshot(next); }
    catch (error) { feedback.reportError(error, t("desktop.settings.saveFailed")); }
    finally { setSaving(false); }
  };
  return { config: snapshot.values, loading: loading || snapshot.revision < 0, saving, patch };
}
function DesktopPetSettingsPage({ context: ctx, theme }: PluginSettingsPageProps & { context: PluginClientContext }) {
  const host = getDesktopPetClientHost();
  const { t } = host.useTranslation();
  const feedback = host.useFeedback();
  const { config, loading, saving, patch } = usePetConfiguration(ctx);
  const [pets, setPets] = useState<PetDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = async () => { setBusy(true); try { setPets(await ctx.native.invoke<PetDescriptor[]>("pet:list")); setLoadError(null); } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  useEffect(() => { void refresh(); }, [ctx]);
  const disabled = loading || saving || busy;
  const importPet = async () => {
    setBusy(true);
    try {
      const directory = await ctx.native.invoke<string | null>("dialog.open", { title: t("desktop.pets.importTitle"), directory: true, multiple: false });
      if (!directory) return;
      await ctx.native.invoke("pet:import", { directory });
      setPets(await ctx.native.invoke<PetDescriptor[]>("pet:list"));
      feedback.notify(t("desktop.pets.imported"), "success");
    } catch (error) { feedback.reportError(error, t("desktop.pets.importFailed", { message: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  return <View style={[styles.page, { backgroundColor: theme.colors.surface0 }]}>
    <View style={styles.row}><Text style={[styles.title, { color: theme.colors.foreground }]}>{t("desktop.pets.size")}</Text><View style={styles.actions}>{(["small", "medium", "large"] as PetSize[]).map((size) => <Action key={size} title={t(`desktop.pets.sizes.${size}`)} selected={config.size === size} disabled={disabled} onPress={() => { void patch({ size }); }} color={theme.colors.foreground} accent={theme.colors.accent} />)}</View></View>
    {loadError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{loadError}</Text> : null}
    <View style={styles.gallery}>{pets.map((pet) => <Pressable key={pet.id} disabled={disabled} onPress={() => { void patch({ selectedId: pet.id }); }} accessibilityRole="button" accessibilityLabel={t("desktop.pets.selectPet", { name: pet.name })} accessibilityState={{ selected: config.selectedId === pet.id, disabled }} style={[styles.petCard, { borderColor: config.selectedId === pet.id ? theme.colors.accent : theme.colors.foregroundMuted }]}>
      <Image source={{ uri: pet.previewUrl }} resizeMode="contain" accessibilityIgnoresInvertColors style={styles.preview} />
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{pet.name}</Text><Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted }}>{pet.description}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{t(config.selectedId === pet.id ? "desktop.pets.selected" : pet.builtIn ? "desktop.pets.builtIn" : "desktop.pets.custom")}</Text>
    </Pressable>)}</View>
    <View style={styles.actions}><Action title={t(busy ? "desktop.pets.importing" : "desktop.pets.import")} disabled={disabled} onPress={() => { void importPet(); }} color={theme.colors.foreground} accent={theme.colors.accent} /><Action title={t("desktop.pets.refresh")} disabled={disabled} onPress={() => { void refresh(); }} color={theme.colors.foreground} accent={theme.colors.accent} /></View>
    <PetCreator context={ctx} disabled={disabled} theme={theme} />
  </View>;
}
function Action({ title, selected = false, disabled, onPress, color, accent }: { title: string; selected?: boolean; disabled: boolean; onPress(): void; color: string; accent: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.button, { borderColor: selected ? accent : color, opacity: disabled ? 0.45 : 1 }]}><Text style={{ color: selected ? accent : color }}>{title}</Text></Pressable>;
}
function PetCreator({ context: ctx, disabled, theme }: { context: PluginClientContext; disabled: boolean; theme: PluginSettingsPageProps["theme"] }) {
  const host = getDesktopPetClientHost();
  const { t, locale } = host.useTranslation();
  const feedback = host.useFeedback();
  const authoring = getPetAuthoringDraft(ctx.installation.id);
  const { description, creating } = useSyncExternalStore(authoring.subscribe, authoring.getSnapshot, authoring.getSnapshot);
  const initialPreferences = useRef(authoring.getSnapshot().preferences).current;
  const draft = host.useCreationDraft(ctx.installation.id, disabled || creating, initialPreferences);
  useEffect(() => { if (draft.ready) authoring.patch({ preferences: draft.preferences }); }, [authoring, draft.ready, draft.preferences]);
  const create = async () => {
    if (!draft.ready || !draft.host) return;
    authoring.patch({ creating: true });
    try { const workspace = await draft.host.prepareWorkspace(description.trim()); await launchDesktopPetCreation({ host: draft.host, workspace, preferences: draft.preferences, locale }); }
    catch (error) { feedback.reportError(error, t("desktop.pets.createFailed", { message: error instanceof Error ? error.message : String(error) })); }
    finally { authoring.patch({ creating: false }); }
  };
  return <View style={styles.creation}><Text style={[styles.title, { color: theme.colors.foreground }]}>{t("desktop.pets.createTitle")}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{t("desktop.pets.createHint")}</Text>{draft.controls}
    <TextInput multiline value={description} onChangeText={(description) => authoring.patch({ description })} maxLength={8000} placeholder={t("desktop.pets.descriptionPlaceholder")} accessibilityLabel={t("desktop.pets.descriptionLabel")} style={[styles.description, { borderColor: theme.colors.foregroundMuted, color: theme.colors.foreground }]} />
    <Action title={t(creating ? "desktop.pets.creating" : "desktop.pets.create")} disabled={disabled || creating || !draft.ready} onPress={() => { void create(); }} color={theme.colors.foreground} accent={theme.colors.accent} />
    {draft.error ? <Text style={{ color: theme.colors.foregroundMuted }}>{draft.error}</Text> : null}
  </View>;
}
function DesktopPetActivitySync({ context: ctx }: { context: PluginClientContext }) {
  const host = getDesktopPetClientHost();
  const { t } = host.useTranslation();
  const feedback = host.useFeedback();
  const snapshot = host.useActivitySnapshot();
  const revalidations = useRef(new Map<string, string>());
  const activity = useMemo<DesktopPetActivity>(() => {
    const connected = snapshot.hosts.filter((host) => host.connected);
    const serverIds = new Set(connected.map(({ serverId }) => serverId));
    const tasks = connected.flatMap((host) => deriveDesktopPetTasks(host.agents, serverIds, t("desktop.pets.untitledTask"), host.serverId, host.resolveAgentLabel));
    const revisions = Object.fromEntries(connected.map((host) => [host.serverId, host.revision]));
    return { tasks, revisions, connected: connected.length > 0, serverIds: [...serverIds], fontFamily: snapshot.fontFamily, labels: { idle: t("desktop.pets.activity.idle"), offline: t("desktop.pets.activity.offline"), running: t("desktop.pets.activity.running"), needs_input: t("desktop.pets.activity.needsInput"), ready: t("desktop.pets.activity.ready"), blocked: t("desktop.pets.activity.blocked"), openApp: t("desktop.pets.activity.openApp"), openTask: t("desktop.pets.activity.openTask"), hide: t("desktop.pets.activity.hide"), resetPosition: t("desktop.pets.activity.resetPosition"), taskCount: t("desktop.pets.activity.taskCount") } };
  }, [snapshot, t]);
  useEffect(() => {
    let disposed = false;
    void ctx.native.invoke<DesktopPetActivityResult>("pet.activity", activity).then(async ({ revalidate }) => {
      for (const { serverId, generation } of revalidate) {
        if (disposed || ctx.signal.aborted) return;
        const fingerprint = JSON.stringify([generation, activity.revisions[serverId], snapshot.hosts.find((host) => host.serverId === serverId)?.connectionKey]);
        if (revalidations.current.get(serverId) === fingerprint) continue;
        revalidations.current.set(serverId, fingerprint);
        await host.refreshAgentDirectory(serverId, generation);
      }
    }).catch((error) => { if (!disposed && !ctx.signal.aborted) feedback.reportError(error, t("desktop.pets.activityFailed")); });
    return () => { disposed = true; };
  }, [activity, ctx, host, feedback, snapshot, t]);
  return null;
}
const styles = StyleSheet.create({ page: { padding: 16, gap: 16 }, row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }, title: { fontSize: 15, fontWeight: "600" }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }, gallery: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, petCard: { width: 168, padding: 12, borderWidth: 1, borderRadius: 10, gap: 6 }, preview: { width: "100%", height: 96 }, creation: { gap: 10, paddingTop: 16 }, description: { minHeight: 76, padding: 12, borderWidth: 1, borderRadius: 8 } });
