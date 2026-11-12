// Historical names are accepted only by the legacy source compiler adapter.
export const PLUGIN_SDK_SPECIFIERS = [
  "@omp-desktop/plugin",
  "@omp-desktop/plugin/server",
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@paseo/plugin",
  "@paseo/plugin/server",
] as const;

export const PLUGIN_FORBIDDEN_HOST_SPECIFIER = /^(?:@omp-desktop\/(?:app|server)(?:\/|$)|@omp-desktop\/client\/internal(?:\/|$)|@getpaseo\/client\/internal(?:\/|$)|@oh-my-pi\/pi-coding-agent(?:\/|$)|oh-my-pi(?:\/|$))/;

export function isPluginSdkSpecifier(name: string): boolean {
  return (PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(name);
}
