import { z } from "zod";

export const PluginClientTrustInstallationSchema = z.object({
  hostId: z.string(),
  installationId: z.string(),
});
export type PluginClientTrustInstallation = z.infer<typeof PluginClientTrustInstallationSchema>;
export const PluginClientTrustIdentitySchema = z.tuple([
  z.string(), z.string(), z.string(), z.string(),
]);
export const PluginClientTrustDocumentSchema = z.record(
  z.string(),
  z.strictObject({ capabilities: z.array(z.string()) }),
);
export type PluginClientTrustDocument = z.infer<typeof PluginClientTrustDocumentSchema>;

const source = PluginClientTrustInstallationSchema.extend({
  packageId: z.string(),
  sourcePath: z.string(),
  capabilities: z.array(z.string()),
});
const operationSchema = z.discriminatedUnion("action", [
  source.strict().extend({ action: z.literal("check") }),
  source.strict().extend({ action: z.literal("approve") }),
  PluginClientTrustInstallationSchema.strict().extend({ action: z.literal("revoke") }),
]);
export type PluginClientTrustOperation = z.infer<typeof operationSchema>;
export const PluginClientTrustRequestSchema = z.strictObject({
  operation: operationSchema,
  initial: PluginClientTrustDocumentSchema.optional(),
});
export type PluginClientTrustRequest = z.infer<typeof PluginClientTrustRequestSchema>;

export function applyPluginClientTrust(
  document: PluginClientTrustDocument,
  operation: PluginClientTrustOperation,
): boolean {
  const { hostId, installationId } = operation;
  if (operation.action === "revoke") {
    const prefix = `${JSON.stringify([hostId, installationId]).slice(0, -1)},`;
    for (const key of Object.keys(document)) {
      if (key.startsWith(prefix)) delete document[key];
    }
    return true;
  }

  const key = JSON.stringify([hostId, installationId, operation.packageId, operation.sourcePath]);
  if (operation.action === "check") {
    const saved = document[key];
    return !!saved && operation.capabilities.every((capability) => saved.capabilities.includes(capability));
  }

  const saved = (document[key] ??= { capabilities: [] });
  for (const capability of operation.capabilities) {
    if (!saved.capabilities.includes(capability)) saved.capabilities.push(capability);
  }
  return true;
}
