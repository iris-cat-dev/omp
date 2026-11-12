import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { Image, Platform, View } from "react-native";
import type { PluginBackgroundIntent } from "@omp-desktop/plugin";
import { withUnistyles } from "react-native-unistyles";
import { setCssColorAlpha } from "@/appearance/color";
import { usePluginClientSnapshot, usePluginContributions } from "./hooks";
import { pluginClientRegistry, type RegisteredPluginContribution } from "./registry";
import { PluginView } from "./view";

interface PluginBackgroundState {
  status: "idle" | "loading" | "ready" | "error";
  opacity: number;
  requestKey: string | null;
  providerKey: string | null;
}
const listeners = new Set<() => void>();
const emptyState: PluginBackgroundState = { status: "idle", opacity: 0, requestKey: null, providerKey: null };
let backgroundState = emptyState;

function publish(state: PluginBackgroundState) {
  if (state.status === backgroundState.status && state.opacity === backgroundState.opacity && state.requestKey === backgroundState.requestKey && state.providerKey === backgroundState.providerKey) return;
  backgroundState = state;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function usePluginBackgroundState() {
  return useSyncExternalStore(subscribe, () => backgroundState, () => emptyState);
}

function BackgroundMedia({ entry }: { entry: RegisteredPluginContribution<"background"> }) {
  const { instance, contribution } = entry;
  const subscribeIntent = useCallback((listener: () => void) => {
    const cleanup = instance.scope.own(contribution.subscribe(listener));
    return () => { void Promise.resolve(cleanup()).catch((error: unknown) => pluginClientRegistry.fail(instance.key, error, instance.scope)); };
  }, [instance, contribution]);
  const intent: PluginBackgroundIntent | null = useSyncExternalStore(subscribeIntent, contribution.getSnapshot, () => null);
  const source = intent?.source;
  const requestKey = intent?.requestKey ?? null;
  const opacity = intent?.opacity ?? 0;
  if (intent && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !source?.uri || !requestKey)) throw new Error("Invalid plugin background intent");

  useLayoutEffect(() => {
    publish(source ? { status: "loading", opacity, requestKey, providerKey: entry.key } : emptyState);
    return () => {
      if (backgroundState.providerKey === entry.key && backgroundState.requestKey === requestKey) publish(emptyState);
    };
  }, [entry.key, requestKey, source?.uri, source?.kind]);
  useLayoutEffect(() => {
    if (backgroundState.providerKey === entry.key && backgroundState.requestKey === requestKey) {
      publish({ ...backgroundState, opacity });
    }
  }, [entry.key, requestKey, opacity]);

  const settle = useCallback((status: "ready" | "error") => {
    if (!intent || instance.scope.signal.aborted || pluginClientRegistry.getSnapshot().backgroundSelection !== entry.key) return;
    if (contribution.getSnapshot() !== intent || backgroundState.requestKey !== requestKey || backgroundState.providerKey !== entry.key) return;
    publish({ status, opacity, requestKey, providerKey: entry.key });
    if (status === "ready") intent.onReady(); else intent.onError();
  }, [entry, instance, intent, contribution, requestKey, opacity]);

  if (!source || !intent) return null;
  const style = { width: "100%" as const, height: "100%" as const, opacity };
  if (source.kind === "video") {
    if (Platform.OS !== "web") throw new Error("Video backgrounds are unavailable on this platform");
    return <video key={`${entry.key}:${requestKey}`} src={source.uri} autoPlay muted loop playsInline preload="auto" style={{ ...style, objectFit: "cover" }}
      onLoadedData={(event) => { const video = event.currentTarget; if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) settle("ready"); }}
      onCanPlay={(event) => { const video = event.currentTarget; if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) settle("ready"); }}
      onError={() => settle("error")} />;
  }
  return <Image key={`${entry.key}:${requestKey}`} source={{ uri: source.uri }} resizeMode="cover" style={style} onLoad={() => settle("ready")} onError={() => settle("error")} />;
}

function PluginBackgroundBase({ canvasColor }: { canvasColor: string }) {
  const snapshot = usePluginClientSnapshot();
  const entries = usePluginContributions("background", "desktop");
  const entry = entries.find((item) => item.key === snapshot.backgroundSelection);
  useLayoutEffect(() => { if (!entry) publish(emptyState); }, [entry]);
  return <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden", backgroundColor: canvasColor }}>
    {entry && <PluginView key={`${entry.key}:${entry.instance.scope.generation}`} instance={entry.instance}><BackgroundMedia entry={entry} /></PluginView>}
  </View>;
}

export const PluginBackground = withUnistyles(PluginBackgroundBase, (theme) => ({
  canvasColor: setCssColorAlpha(theme.colors.surface0, 1),
}));
