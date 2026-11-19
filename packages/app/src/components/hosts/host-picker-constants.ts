import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";

export const ADD_HOST_OPTION_ID = "__add_host__";
export const ALL_HOSTS_OPTION_ID = "__all_hosts__";
export const ENABLE_BUILT_IN_DAEMON_OPTION_ID = "__enable_built_in_daemon__";

export function getHostPickerLabel(
  hosts: Array<{ label: string; serverId: string }>,
  value: string,
  config?: { includeAllHost?: boolean; includeAddHost?: boolean },
  t: TFunction = i18n.t,
): string {
  if (config?.includeAllHost && value === ALL_HOSTS_OPTION_ID) {
    return t("sidebar.display.hostFilter.all");
  }
  if (config?.includeAddHost && value === ADD_HOST_OPTION_ID) {
    return t("settings.addHost");
  }
  return (
    hosts.find((host) => host.serverId === value)?.label ??
    (config?.includeAllHost ? t("sidebar.display.hostFilter.all") : t("settings.groups.host"))
  );
}
