import { z } from "zod";
import { DEFAULT_WALLPAPER_CONFIGURATION } from "./source.js";

export const WallpaperConfigSchema = z.strictObject({
  source: z.enum(["none", "file", "url"]),
  candidateId: z.uuid().nullable(),
  url: z.string().nullable(),
  opacity: z.number().min(0).max(1),
});
export const wallpaperBuiltin = {
  id: "wallpaper",
  version: "0.6.1",
  capabilities: ["storage.scoped", "wallpaper.media", "ui.background", "ui.settings"],
  defaultEnabled: false,
  defaultConfig: DEFAULT_WALLPAPER_CONFIGURATION,
  configSchema: WallpaperConfigSchema,
} as const;
export default wallpaperBuiltin;
