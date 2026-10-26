import { z } from "zod";

export const LOCAL_MODEL_PROVIDER = "desktop-local";
export const LOCAL_MODEL_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
// A detached source is gone until explicitly reattached, not a retryable upstream outage.
export const LOCAL_MODEL_UNAVAILABLE_STATUS = 410;

// Deliberately omit URLs, headers, account identities and credential-shaped model fields.
export const LocalModelSchema = z.object({
  provider: z.string().min(1).max(255),
  id: z.string().min(1).max(2048),
  name: z.string().max(2048).optional(),
  api: z.string().min(1).max(255),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  thinking: z
    .object({
      mode: z.string().optional(),
      efforts: z.array(z.string()).optional(),
      defaultLevel: z.string().optional(),
      effortMap: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  cost: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative(),
    })
    .optional(),
  serviceTiers: z.array(z.string()).optional(),
});
export type LocalModel = z.infer<typeof LocalModelSchema>;
export const LocalModelCatalogSchema = z.array(LocalModelSchema).max(10_000);

export const LocalModelInferenceRequestSchema = z.object({
  modelId: z.string().min(1).max(2318),
  context: z
    .object({
      systemPrompt: z.array(z.string()).optional(),
      messages: z.array(z.unknown()),
      tools: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  options: z.record(z.string(), z.unknown()).optional(),
  stream: z.literal(true).default(true),
});
export type LocalModelInferenceRequest = z.infer<typeof LocalModelInferenceRequestSchema>;

export const LocalModelStreamFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("headers"),
    status: z.number().int().min(100).max(599),
    contentType: z.string().max(255),
  }),
  z.object({ type: z.literal("chunk"), data: z.string().max(128 * 1024) }),
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("error"), message: z.string().max(4096) }),
]);
export type LocalModelStreamFrame = z.infer<typeof LocalModelStreamFrameSchema>;
