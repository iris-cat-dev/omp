import { z } from "zod";
export const PetConfigSchema = z.object({
  size: z.enum(["small", "medium", "large"]),
  selectedId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
  position: z.object({ x: z.number().finite().transform(Math.round), y: z.number().finite().transform(Math.round) }).nullable(),
}).strict();
export const DEFAULT_PET_CONFIG = { size: "medium", selectedId: "iris", position: null } as const;

export const desktopPetBuiltin = {
  id: "desktop-pet", version: "0.6.1", capabilities: ["native.overlay", "files.scoped", "native.dialog", "native.navigation", "agents.events"],
  defaultEnabled: false, defaultConfig: DEFAULT_PET_CONFIG, configSchema: PetConfigSchema,
} as const;