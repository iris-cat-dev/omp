import { z } from "zod";
import { LocalPluginDocumentSchema, LocalPluginPatchSchema, type LocalPluginDocument } from "@omp-desktop/protocol/desktop-local-plugins";
export type { LocalPluginDocument, LocalPluginRecord, LocalPluginSnapshot, LocalPluginStatus, LocalPluginPatch } from "@omp-desktop/protocol/desktop-local-plugins";
export function createLocalPluginDocument(): LocalPluginDocument {
  return { revision: 0, backgroundProvider: null, backgroundSelectionEdited: false, installations: [] };
}
export function clonePluginDocument(document: LocalPluginDocument): LocalPluginDocument { return structuredClone(document); }
export function parseLocalPluginDocument(input: unknown): LocalPluginDocument {
  const document = LocalPluginDocumentSchema.parse(input);
  for (const record of document.installations) record.config = validatePluginConfig(record.config);
  return document;
}
export function validatePluginConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(config, "enabled")) throw new TypeError("Plugin enabled state is not configuration.");
  return z.record(z.string(), z.json()).parse(config);
}
export function applyLocalPluginPatch(document: LocalPluginDocument, raw: unknown): LocalPluginDocument {
  const input = LocalPluginPatchSchema.parse(raw);
  const next = clonePluginDocument(document);
  const record = next.installations.find(({ id }) => id === input.installationId);
  if (!record) throw new Error("Plugin installation is not installed.");
  if (record.source.type === "builtin") throw new Error("Legacy bundled plugin records cannot be changed or activated.");
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
  if (patch.config !== undefined) record.config = validatePluginConfig({ ...record.config, ...patch.config });
  record.revision += 1;
  record.migrationVersion = 1;
  next.revision += 1;
  return next;
}
