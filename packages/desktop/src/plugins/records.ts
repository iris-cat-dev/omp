import { z } from "zod";
import { LocalPluginDocumentSchema, LocalPluginPatchSchema, type LocalPluginDocument, type LocalPluginRecord } from "@omp-desktop/protocol/desktop-local-plugins";
import { PetConfigSchema } from "@omp-desktop/plugin-desktop-pet/config";
import { WallpaperConfigSchema } from "@omp-desktop/plugin-wallpaper/builtin";
import { builtinLocalPluginDescriptors } from "./builtin-descriptors.js";
export type { LocalPluginDocument, LocalPluginRecord, LocalPluginSnapshot, LocalPluginStatus, LocalPluginPatch } from "@omp-desktop/protocol/desktop-local-plugins";
export const LegacyPluginMigrationSchema = z.object({ wallpaper: z.object({ enabled: z.boolean(), config: WallpaperConfigSchema, recovery: z.object({ directory: z.string().nullable(), path: z.string().nullable() }).optional() }).optional() }).strict();
const LegacyPetSchema = PetConfigSchema.extend({ enabled: z.boolean().optional() });
export function createLocalPluginDocument(legacyPet?: unknown): LocalPluginDocument {
  const installations: LocalPluginRecord[] = builtinLocalPluginDescriptors.map(({ id, version, defaultEnabled, capabilities, defaultConfig }) => ({ id, packageId: id, owner: "desktop", version, generation: 0, enabled: defaultEnabled, installed: true, source: { type: "builtin", identity: `builtin:${id}` }, declaredCapabilities: [...capabilities], grantedCapabilities: [...capabilities], trusted: true, config: { ...structuredClone(defaultConfig) }, revision: 0, migrationVersion: id === "wallpaper" ? 0 : 1, format: "builtin", metadata: null }));
  if (legacyPet !== undefined) {
    const defaults = installations.find(({ id }) => id === "desktop-pet")!;
    const { enabled, ...config } = LegacyPetSchema.partial().parse(legacyPet);
    const pet = defaults;
    pet.enabled = enabled ?? false;
    pet.config = PetConfigSchema.parse({ ...pet.config, ...config });
  }
  return { revision: 0, backgroundProvider: null, backgroundSelectionEdited: false, installations };
}
export function clonePluginDocument(document: LocalPluginDocument): LocalPluginDocument { return structuredClone(document); }
export function parseLocalPluginDocument(input: unknown): LocalPluginDocument {
  const document = LocalPluginDocumentSchema.parse(input);
  for (const record of document.installations) record.config = validatePluginConfig(record.packageId, record.config);
  return document;
}
export function validatePluginConfig(packageId: string, config: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(config, "enabled")) throw new TypeError("Plugin enabled state is not configuration.");
  const descriptor = builtinLocalPluginDescriptors.find(({ id }) => id === packageId);
  return z.record(z.string(), z.json()).parse(descriptor?.configSchema ? descriptor.configSchema.parse(config) : config);
}
export function applyLocalPluginPatch(document: LocalPluginDocument, raw: unknown): LocalPluginDocument {
  const input = LocalPluginPatchSchema.parse(raw);
  const next = clonePluginDocument(document);
  const record = next.installations.find(({ id }) => id === input.installationId);
  if (!record) throw new Error("Plugin installation is not installed.");
  if (record.revision !== input.expectedRevision) throw new Error("Plugin configuration changed. Reload it before saving.");
  if (record.revision === Number.MAX_SAFE_INTEGER || next.revision === Number.MAX_SAFE_INTEGER) throw new RangeError("Plugin revision exhausted.");
  const patch = input.patch;
  if (patch.enabled && !record.installed) throw new Error("Reinstall the plugin before enabling it.");
  if (patch.enabled !== undefined) record.enabled = patch.enabled;
  if (patch.trusted !== undefined) record.trusted = patch.trusted;
  if (patch.grantedCapabilities !== undefined) {
    if (patch.grantedCapabilities.some((capability) => !record.declaredCapabilities.includes(capability))) throw new TypeError("Plugin grants exceed declared capabilities.");
    record.grantedCapabilities = [...new Set(patch.grantedCapabilities)];
  }
  if (patch.config !== undefined) record.config = validatePluginConfig(record.packageId, { ...record.config, ...patch.config });
  record.revision += 1;
  record.migrationVersion = 1;
  next.revision += 1;
  return next;
}
