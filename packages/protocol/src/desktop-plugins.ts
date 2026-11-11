import { z } from "zod";
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const DesktopPluginMetadataSchema = z.object({
  apiVersion: z.literal(1), id, owner: z.enum(["desktop", "daemon"]),
  entries: z.object({ client: z.string().min(1).optional(), service: z.string().min(1).optional() }).strict().refine(v => !!(v.client || v.service), "At least one entry is required"),
  capabilities: z.array(z.string().min(1)).default([]),
}).strict();
export type DesktopPluginMetadata = z.infer<typeof DesktopPluginMetadataSchema>;
export const DesktopPluginApprovalSchema = z.object({ version: z.string(), capabilities: z.array(z.string()), trusted: z.literal(true) }).strict();
export const DesktopPluginExpectedInstallationSchema=z.object({sourcePath:z.string().min(1),packageId:z.string().min(1),generation:z.number().int().nonnegative()}).strict();
export type DesktopPluginExpectedInstallation=z.infer<typeof DesktopPluginExpectedInstallationSchema>;
export const DesktopPluginCatalogEntrySchema = z.object({
  id, packageId: z.string(), owner: z.enum(["desktop", "daemon"]), version: z.string(),
  generation: z.number().int().nonnegative(), enabled: z.boolean(), effectiveEnabled: z.boolean(),
  installed: z.boolean().optional(), bundled: z.boolean().optional(),
  source: z.object({ type: z.literal("directory"), path: z.string() }),
  format: z.enum(["legacy", "package"]), metadata: DesktopPluginMetadataSchema.nullable(),
  declaredCapabilities: z.array(z.string()), grantedCapabilities: z.array(z.string()),
  trusted: z.boolean(), status: z.enum(["running", "disabled", "failed", "waiting", "starting"]),
  error: z.string().optional(), waitingReason: z.string().optional(), clientBundle: z.string().optional(),
  revision: z.number().int().nonnegative(),
});
export type DesktopPluginCatalogEntry = z.infer<typeof DesktopPluginCatalogEntrySchema>;
export const DesktopPluginStorageSnapshotSchema = z.object({revision: z.number().int().nonnegative(), values: z.record(z.string(),z.unknown())});
export const DesktopPluginApproveRequestSchema = z.object({type:z.literal("plugin.approve.request"),requestId:z.string(),pluginId:id,approval:DesktopPluginApprovalSchema,expectedInstallation:DesktopPluginExpectedInstallationSchema});
export const DesktopPluginStorageGetRequestSchema = z.object({type:z.literal("plugin.storage.get.request"),requestId:z.string(),pluginId:id,generation:z.number().int().nonnegative()});
export const DesktopPluginStoragePatchRequestSchema = z.object({type:z.literal("plugin.storage.patch.request"),requestId:z.string(),pluginId:id,generation:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative(),patch:z.record(z.string(),z.unknown())});
export const DesktopPluginSecretRequestSchema = z.object({type:z.literal("plugin.secret.request"),requestId:z.string(),pluginId:id,generation:z.number().int().nonnegative(),key:z.string().min(1),operation:z.enum(["configured","set","delete"]),value:z.string().optional()});
export const DesktopPluginDataClearRequestSchema = z.object({type:z.literal("plugin.data.clear.request"),requestId:z.string(),pluginId:id});
export const DesktopPluginApproveResponseSchema = z.object({type:z.literal("plugin.approve.response"),payload:z.object({requestId:z.string(),plugin:DesktopPluginCatalogEntrySchema})});
export const DesktopPluginStorageGetResponseSchema = z.object({type:z.literal("plugin.storage.get.response"),payload:z.object({requestId:z.string(),snapshot:DesktopPluginStorageSnapshotSchema})});
export const DesktopPluginStoragePatchResponseSchema = z.object({type:z.literal("plugin.storage.patch.response"),payload:z.object({requestId:z.string(),snapshot:DesktopPluginStorageSnapshotSchema})});
export const DesktopPluginSecretResponseSchema = z.object({type:z.literal("plugin.secret.response"),payload:z.object({requestId:z.string(),configured:z.boolean()})});
export const DesktopPluginDataClearResponseSchema = z.object({type:z.literal("plugin.data.clear.response"),payload:z.object({requestId:z.string()})});
export const DesktopPluginRevokeTrustRequestSchema=z.object({type:z.literal("plugin.trust.revoke.request"),requestId:z.string(),pluginId:id});
export const DesktopPluginRevokeTrustResponseSchema=z.object({type:z.literal("plugin.trust.revoke.response"),payload:z.object({requestId:z.string(),plugin:DesktopPluginCatalogEntrySchema})});

const scalar = z.union([z.string(),z.number(),z.boolean()]);
const settingCommon={description:z.string().optional(),secret:z.boolean().optional(),env:z.string().optional()};
const settingSchema=z.discriminatedUnion("type",[
 z.object({...settingCommon,type:z.literal("string"),default:z.string().optional()}),
 z.object({...settingCommon,type:z.literal("number"),default:z.number().optional(),min:z.number().optional(),max:z.number().optional(),step:z.number().optional()}),
 z.object({...settingCommon,type:z.literal("boolean"),default:z.boolean().optional()}),
 z.object({...settingCommon,type:z.literal("enum"),values:z.array(z.string()),default:z.string().optional()}),
]);
export const OmpPluginManagementSchema = z.object({
 name:z.string(),scope:z.enum(["user","project"]),
 schema:z.record(z.string(),settingSchema),
 settings:z.record(z.string(),scalar),secretConfigured:z.record(z.string(),z.boolean()),enabledFeatures:z.array(z.string()).nullable(),availableFeatures:z.record(z.string(),z.object({description:z.string().optional(),default:z.boolean().optional()})),effectiveFeatures:z.array(z.string()),secretInput:z.literal("unavailable"),appliesTo:z.literal("new-or-resumed-sessions"),
 overriddenSettings:z.array(z.string()),featuresOverridden:z.boolean(),
});
export type OmpPluginManagement = z.infer<typeof OmpPluginManagementSchema>;
export const OmpPluginManagementGetRequestMessageSchema=z.object({type:z.literal("ompPlugins.management.get.request"),requestId:z.string(),name:z.string(),scope:z.enum(["user","project"]).optional(),cwd:z.string().optional()});
export const OmpPluginManagementUpdateRequestMessageSchema=z.object({type:z.literal("ompPlugins.management.update.request"),requestId:z.string(),name:z.string(),scope:z.enum(["user","project"]).optional(),cwd:z.string().optional(),patch:z.object({enabledFeatures:z.array(z.string()).nullable().optional(),settings:z.record(z.string(),scalar).optional(),deleteSettings:z.array(z.string()).optional()}).strict()});
export const OmpPluginManagementGetResponseMessageSchema=z.object({type:z.literal("ompPlugins.management.get.response"),payload:z.object({requestId:z.string(),management:OmpPluginManagementSchema})});
export const OmpPluginManagementUpdateResponseMessageSchema=z.object({type:z.literal("ompPlugins.management.update.response"),payload:z.object({requestId:z.string(),management:OmpPluginManagementSchema})});
