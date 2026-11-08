import { z } from "zod";

export const PromptContextEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  text: z.string(),
  tokens: z.number(),
  info: z.string().optional(),
  path: z.string().optional(),
  timestamp: z.number().optional(),
  callId: z.string().optional(),
  interrupted: z.boolean().optional(),
  thinkingGroup: z
    .object({
      id: z.string(),
      label: z.string(),
      tokens: z.number(),
      interrupted: z.boolean().optional(),
    })
    .optional(),
});
export type PromptContextEntry = z.infer<typeof PromptContextEntrySchema>;

const PromptContextCategoryLeafSchema = z.object({
  id: z.enum([
    "system-prompt",
    "skills",
    "built-in-tools",
    "custom-tools",
    "user-messages",
    "assistant-messages",
    "assistant-thinking",
    "tool-calls",
    "tool-output",
  ]),
  key: z.string().optional(),
  label: z.string(),
  tokens: z.number(),
  entries: z.array(PromptContextEntrySchema),
});

// Native tool-output children are leaf groups, not recursively nested categories.
export const PromptContextCategorySchema = PromptContextCategoryLeafSchema.extend({
  children: z.array(PromptContextCategoryLeafSchema).optional(),
});
export type PromptContextCategory = z.infer<typeof PromptContextCategorySchema>;

/** Current native context, with local attribution estimates rather than a provider request capture. */
export const AgentPromptContextSchema = z.object({
  capturedAt: z.iso.datetime(),
  model: z.object({ provider: z.string(), id: z.string() }).nullable(),
  breakdown: z.object({
    contextWindow: z.number(),
    usedTokens: z.number(),
    freeTokens: z.number(),
    autoCompactBufferTokens: z.number(),
    thresholdTokens: z.number().optional(),
    categories: z.array(z.object({ id: z.string(), label: z.string(), tokens: z.number() })),
  }),
  categories: z.array(PromptContextCategorySchema),
});
export type AgentPromptContext = z.infer<typeof AgentPromptContextSchema>;

export const AgentPromptContextRequestSchema = z.object({
  type: z.literal("agent_prompt_context_request"),
  requestId: z.string(),
  agentId: z.string(),
});
export const AgentPromptContextResponseSchema = z.object({
  type: z.literal("agent_prompt_context_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    context: AgentPromptContextSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type AgentPromptContextPayload = z.infer<typeof AgentPromptContextResponseSchema>["payload"];
