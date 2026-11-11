import type { ZodType } from "zod";
import { desktopPetBuiltin } from "@omp-desktop/plugin-desktop-pet/config";
import { wallpaperBuiltin } from "@omp-desktop/plugin-wallpaper/builtin";
import { agentSpeedBuiltinDescriptor } from "@omp-desktop/plugin-agent-speed/builtin";
export interface BuiltinLocalPluginDescriptor {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly defaultEnabled: boolean;
  readonly defaultConfig: Readonly<object>;
  readonly configSchema?: ZodType;
}
export const builtinLocalPluginDescriptors: readonly BuiltinLocalPluginDescriptor[] = [desktopPetBuiltin, wallpaperBuiltin, agentSpeedBuiltinDescriptor];
