import { Component, useMemo, type ErrorInfo, type ReactNode } from "react";
import { Text, View, Platform } from "react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import type { PluginHostProps } from "@omp-desktop/plugin";
import { PaseoApiProvider, PluginRpcProvider, PluginClientStateProvider } from "@omp-desktop/plugin/host";
import { useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { setCssColorAlpha } from "@/appearance/color";
import { pluginClientRegistry, type PluginClientInstance } from "./registry";
import { createPluginClientStateSource } from "./client-state";
import { getPluginPaseo } from "./paseo";

class PluginErrorBoundary extends Component<{ instance: PluginClientInstance; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    const { instance } = this.props;
    pluginClientRegistry.remove(instance.key, instance.scope);
    pluginClientRegistry.fail(instance.key, error, instance.scope);
    void instance.scope.dispose("Plugin view failed").catch((cleanupError: unknown) => pluginClientRegistry.fail(instance.key, cleanupError, instance.scope));
  }
  render() {
    if (this.state.error) return <View><Text accessibilityRole="alert" style={settingsStyles.rowHint}>{this.state.error}</Text></View>;
    return this.props.children;
  }
}

export function usePluginHostProps(hostId: string, owner: "desktop" | "daemon" = "daemon"): PluginHostProps {
  const { theme } = useUnistyles();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const host = hosts.find((item) => item.serverId === hostId);
  return {
    host: Object.freeze({ id: hostId, label: owner === "desktop" ? "Desktop" : host?.label ?? hostId }),
    layout: Object.freeze({ compact, platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web" }),
    theme: Object.freeze({ colors: Object.freeze({
      surface0: setCssColorAlpha(theme.colors.surface0, 1), foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted, accent: theme.colors.accent,
      accentForeground: theme.colors.accentForeground, statusDanger: theme.colors.statusDanger,
    }) }),
  };
}

function PluginProviders({ instance, hostId, children }: { instance: PluginClientInstance; hostId?: string; children: ReactNode }) {
  const source = useMemo(() => createPluginClientStateSource(hostId ?? (instance.installation.owner === "daemon" ? instance.hostId : null)), [hostId, instance.hostId, instance.installation.owner]);
  const viewClient = useHostRuntimeClient(hostId ?? "");
  const paseo = useMemo(() => instance.installation.owner !== "desktop" || (hostId && viewClient) ? getPluginPaseo(instance, hostId) : null, [instance, hostId, viewClient]);
  return (
    <QueryClientProvider client={instance.queryClient}>
      <PluginClientStateProvider source={source}>
        {paseo ? <PaseoApiProvider paseo={paseo}><PluginRpcProvider invoke={instance.invoke}>{children}</PluginRpcProvider></PaseoApiProvider>
          : <PluginRpcProvider invoke={instance.invoke}>{children}</PluginRpcProvider>}
      </PluginClientStateProvider>
    </QueryClientProvider>
  );
}

export function PluginView(props: { instance: PluginClientInstance; hostId?: string; children: ReactNode }) {
  return <PluginErrorBoundary key={`${props.instance.key}:${props.instance.scope.id}`} instance={props.instance}>
    <PluginProviders {...props} />
  </PluginErrorBoundary>;
}
