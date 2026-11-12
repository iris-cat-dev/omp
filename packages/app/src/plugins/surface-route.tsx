import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { PluginSurfaceScreen } from "./surface-screen";

export function PluginSurfaceRoute({ owner }: { owner: "desktop" | "daemon" }) {
  const params = useLocalSearchParams<{ serverId?: string; pluginId?: string; contributionKind?: string; contributionId?: string }>();
  const { t } = useTranslation();
  const hostId = owner === "desktop" ? "desktop" : params.serverId;
  if (typeof hostId !== "string" || typeof params.pluginId !== "string" || typeof params.contributionId !== "string" || (params.contributionKind !== "sidebar" && params.contributionKind !== "surface")) return <Text accessibilityRole="alert">{t("plugins.unavailable")}</Text>;
  return <PluginSurfaceScreen hostId={hostId} owner={owner} pluginId={params.pluginId} identity={{ kind: params.contributionKind, id: params.contributionId }} />;
}
