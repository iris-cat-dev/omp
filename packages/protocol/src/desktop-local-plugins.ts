import { z } from "zod";
import { DesktopPluginMetadataSchema } from "./desktop-plugins.js";
export const LocalPluginRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const LocalPluginConfigSchema = z.record(z.string(), z.json()).transform((value): Record<string, unknown> => value);
export const LocalPluginRecordSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/), packageId: z.string().min(1), owner: z.literal("desktop"), version: z.string().min(1), generation: LocalPluginRevisionSchema, enabled: z.boolean(), installed: z.boolean().default(true),
  source: z.object({ type: z.enum(["builtin", "local"]), identity: z.string().min(1) }), trusted: z.boolean(), config: LocalPluginConfigSchema,
  declaredCapabilities: z.array(z.string()), grantedCapabilities: z.array(z.string()), revision: LocalPluginRevisionSchema, migrationVersion: LocalPluginRevisionSchema,
  format: z.enum(["builtin", "legacy", "package"]).default("builtin"), metadata: DesktopPluginMetadataSchema.nullable().default(null),
}).refine((record) => record.grantedCapabilities.every((capability) => record.declaredCapabilities.includes(capability)), "Plugin grants exceed declared capabilities.");
export type LocalPluginRecord = z.infer<typeof LocalPluginRecordSchema>;
export const LocalPluginStatusSchema = z.enum(["removed", "disabled", "waiting", "activating", "active", "failed"]);
export type LocalPluginStatus = z.infer<typeof LocalPluginStatusSchema>;
export const LocalPluginBackgroundProviderSchema = z.object({ installationId: z.string(), extensionId: z.string() }).nullable();
export const LocalPluginSnapshotSchema = z.object({ revision: LocalPluginRevisionSchema, backgroundProvider: LocalPluginBackgroundProviderSchema, installations: z.array(LocalPluginRecordSchema.safeExtend({ status: LocalPluginStatusSchema, error: z.string().nullable(), clientBundle: z.string().optional() })) });
export type LocalPluginSnapshot = z.infer<typeof LocalPluginSnapshotSchema>;
export const LocalPluginPatchSchema = z.object({ installationId: z.string(), expectedRevision: LocalPluginRevisionSchema, patch: z.object({ enabled: z.boolean().optional(), config: LocalPluginConfigSchema.optional(), grantedCapabilities: z.array(z.string()).optional(), trusted: z.boolean().optional() }).strict() }).strict();
export type LocalPluginPatch = z.infer<typeof LocalPluginPatchSchema>;
export const LocalPluginDocumentSchema = z.object({ revision: LocalPluginRevisionSchema, backgroundProvider: LocalPluginBackgroundProviderSchema.default(null), backgroundSelectionEdited: z.boolean().default(false), installations: z.array(LocalPluginRecordSchema) }).refine((document) => new Set(document.installations.map(({ id }) => id)).size === document.installations.length, "Duplicate installation identity.");
export type LocalPluginDocument = z.infer<typeof LocalPluginDocumentSchema>;
export const LocalPluginInvocationSchema = z.object({ installationId: z.string(), generation: LocalPluginRevisionSchema, documentEpoch: LocalPluginRevisionSchema, clientActivationId: z.string().min(1), method: z.string(), input: z.unknown().optional() });
export const LocalPluginSelectionSchema = z.object({ provider: LocalPluginBackgroundProviderSchema, expectedRevision: LocalPluginRevisionSchema });
export const LocalPluginActionSchema = z.object({ installationId: z.string(), expectedRevision: LocalPluginRevisionSchema });
export const LocalPluginDirectoryInspectionSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), version: z.string(), format: z.enum(["legacy", "package"]), metadata: DesktopPluginMetadataSchema.nullable(), capabilities: z.array(z.string()), directory: z.string(), clientEntry: z.string().optional(), serviceEntry: z.string().optional() });
export type LocalPluginDirectoryInspection = z.infer<typeof LocalPluginDirectoryInspectionSchema>;
export const LocalPluginDirectoryInstallSchema = z.object({ directory: z.string().min(1), installationId: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(), expectedRevision: LocalPluginRevisionSchema, approval: z.object({ trusted: z.literal(true), version: z.string(), capabilities: z.array(z.string()) }).optional() });
export type LocalPluginDirectoryInstall = z.infer<typeof LocalPluginDirectoryInstallSchema>;
export const LocalPluginLogEntrySchema = z.object({ timestamp: z.string(), stream: z.enum(["stdout", "stderr", "host"]), message: z.string() });
export type LocalPluginLogEntry = z.infer<typeof LocalPluginLogEntrySchema>;
export const LocalPluginClientScopeSchema = z.object({ installationId: z.string(), generation: LocalPluginRevisionSchema, documentEpoch: LocalPluginRevisionSchema, clientActivationId: z.string().min(1), mode: z.enum(["manage", "active"]) });
export type LocalPluginClientScope = z.infer<typeof LocalPluginClientScopeSchema>;
