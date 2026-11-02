import { z } from "zod";
import {
  OmpAgentMessageSchema,
  OmpSubagentProgressSchema,
  OmpSubagentStatusSchema,
} from "./rpc-types.js";

const OmpByteOffsetSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const OmpSubagentSnapshotSchema = z
  .object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    agent: z.string(),
    agentSource: z.enum(["bundled", "user", "project"]),
    description: z.string().optional(),
    status: OmpSubagentStatusSchema,
    task: z.string().optional(),
    assignment: z.string().optional(),
    sessionFile: z.string().min(1).optional(),
    parentToolCallId: z.string().optional(),
    lastUpdate: OmpByteOffsetSchema,
    progress: OmpSubagentProgressSchema.optional(),
  })
  .passthrough()
  .refine((snapshot) => !snapshot.progress || snapshot.progress.id === snapshot.id, {
    message: "Subagent snapshot progress belongs to a different native id",
  });

export const OmpSubagentsResultSchema = z
  .object({ subagents: z.array(OmpSubagentSnapshotSchema) })
  .passthrough();

export const OmpSubagentMessagesSelectorSchema = z
  .object({
    subagentId: z.string().min(1).optional(),
    sessionFile: z.string().min(1).optional(),
    fromByte: OmpByteOffsetSchema.optional(),
  })
  .refine((selector) => Boolean(selector.subagentId || selector.sessionFile), {
    message: "get_subagent_messages requires subagentId or sessionFile",
  });

export const OmpSubagentSessionEntrySchema = z
  .object({
    type: z.string(),
    id: z.string(),
    parentId: z.string().nullable().optional(),
    timestamp: z.union([z.string(), z.number().finite()]).optional(),
    message: OmpAgentMessageSchema.optional(),
  })
  .passthrough()
  .refine((entry) => entry.type !== "message" || entry.message !== undefined, {
    message: "Subagent message entry must contain its native message",
  });

export const OmpSubagentMessagesResultSchema = z
  .object({
    sessionFile: z.string().min(1),
    fromByte: OmpByteOffsetSchema,
    nextByte: OmpByteOffsetSchema,
    reset: z.boolean(),
    entries: z.array(OmpSubagentSessionEntrySchema),
    messages: z.array(OmpAgentMessageSchema),
  })
  .passthrough()
  .refine((page) => page.nextByte >= page.fromByte, {
    message: "Subagent transcript cursor must not move backwards",
  })
  .refine((page) => !page.reset || page.fromByte === 0, {
    message: "Reset subagent transcript must start at byte zero",
  });

export const OmpSubagentRpcCommandSchema = z.union([
  z.object({ type: z.literal("get_subagents") }),
  z.object({ type: z.literal("get_subagent_messages") }).and(OmpSubagentMessagesSelectorSchema),
]);

export type OmpSubagentSnapshot = z.infer<typeof OmpSubagentSnapshotSchema>;
export type OmpSubagentMessagesSelector = z.infer<typeof OmpSubagentMessagesSelectorSchema>;
export type OmpSubagentMessagesResult = z.infer<typeof OmpSubagentMessagesResultSchema>;

/** A non-reset page must extend the cursor the caller actually requested. */
export function parseOmpSubagentMessagesResult(
  selector: OmpSubagentMessagesSelector,
  value: unknown,
): OmpSubagentMessagesResult {
  const page = OmpSubagentMessagesResultSchema.parse(value);
  if (!page.reset && page.fromByte !== (selector.fromByte ?? 0)) {
    throw new Error("OMP returned a subagent transcript page for a different cursor");
  }
  if (!selector.subagentId && selector.sessionFile !== page.sessionFile) {
    throw new Error("OMP returned a different subagent transcript session file");
  }
  return page;
}
