import { z } from "zod";

export const RUNTIME_KEEP_LABEL = "paseo.runtime-keep";

export const RuntimeResourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["python_kernel", "javascript_kernel", "shell", "helper"]),
  ownerSessionId: z.string(),
  ownerAgentId: z.string().optional(),
  pid: z.number().int().positive().optional(),
  state: z.enum(["starting", "running", "retained", "stopping"]),
  retentionReasons: z.array(z.string()),
  liveHandles: z.number().int().nonnegative(),
  releasable: z.boolean(),
});
export type RuntimeResource = z.infer<typeof RuntimeResourceSchema>;

export const AgentRuntimeRetentionSchema = z.object({
  state: z.enum(["resident", "unloading", "unloaded"]),
  reasons: z.array(z.object({
    code: z.enum(["initializing", "running", "background", "kernel", "permission", "submission", "user_keep", "unrecoverable", "checking"]),
    detail: z.string().optional(),
    resourceId: z.string().optional(),
  })),
  canUnload: z.boolean(),
  recoverable: z.boolean(),
  idleSince: z.string().nullable(),
});
export type AgentRuntimeRetention = z.infer<typeof AgentRuntimeRetentionSchema>;

export const AgentRuntimeResourcesRequestSchema = z.object({
  type: z.literal("agent_runtime_resources_request"),
  requestId: z.string(),
  agentId: z.string(),
});
export const AgentRuntimeResourcesResponseSchema = z.object({
  type: z.literal("agent_runtime_resources_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    resources: z.array(RuntimeResourceSchema),
    error: z.string().nullable(),
  }),
});
export const AgentRuntimeResourceReleaseRequestSchema = z.object({
  type: z.literal("agent_runtime_resource_release_request"),
  requestId: z.string(),
  agentId: z.string(),
  resourceId: z.string(),
});
export const AgentRuntimeResourceReleaseResponseSchema = z.object({
  type: z.literal("agent_runtime_resource_release_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    resourceId: z.string(),
    released: z.boolean(),
    error: z.string().nullable(),
  }),
});
export const UnloadAgentRuntimeRequestSchema = z.object({
  type: z.literal("unload_agent_runtime_request"),
  requestId: z.string(),
  agentId: z.string(),
});
export const UnloadAgentRuntimeResponseSchema = z.object({
  type: z.literal("unload_agent_runtime_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    success: z.boolean(),
    error: z.string().nullable(),
    runtimeRetention: AgentRuntimeRetentionSchema.optional(),
  }),
});
