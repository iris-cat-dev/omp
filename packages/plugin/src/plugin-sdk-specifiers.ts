export const PLUGIN_SDK_SPECIFIERS = [
  "@omp-desktop/plugin",
  "@omp-desktop/plugin/server",
] as const;

export const PLUGIN_FORBIDDEN_HOST_SPECIFIER = /^(?:@omp-desktop\/(?:app|server)(?:\/|$)|@omp-desktop\/client\/internal(?:\/|$)|@oh-my-pi\/pi-coding-agent(?:\/|$)|oh-my-pi(?:\/|$))/;

export function isPluginSdkSpecifier(name: string): boolean {
  return (PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(name);
}
