import { z } from "zod";

function isWhitespaceOrControl(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    /\s/u.test(character) || codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f
  );
}

const SafeSshTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("-"), "SSH values cannot begin with '-'")
  .refine(
    (value) => !Array.from(value).some(isWhitespaceOrControl),
    "SSH values cannot contain whitespace or control characters",
  );

export const RemoteSshTargetSchema = z.object({
  host: SafeSshTokenSchema,
  username: SafeSshTokenSchema.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine(
      (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
      "Identity path contains invalid characters",
    )
    .optional(),
});

export const RemoteSshStartInputSchema = z.object({
  operationId: z.string().uuid(),
  target: RemoteSshTargetSchema,
  relayAddress: z.string().trim().min(1).max(2048).optional(),
  expectedServerId: z.string().trim().min(1).max(255).optional(),
});

export const RemoteSshOperationInputSchema = z.object({
  operationId: z.string().uuid(),
});

export const RemoteSshInputSchema = RemoteSshOperationInputSchema.extend({
  input: z.string().max(4096),
});

export const RemoteSshProfileInputSchema = z.object({
  serverId: z.string().trim().min(1).max(255),
  target: RemoteSshTargetSchema,
  runtimeRoot: z.string().trim().min(1).max(4096),
  deployedVersion: z.string().trim().min(1).max(255),
  modelSource: z.enum(["local", "remote"]).optional(),
});

export const RemoteSshServerIdInputSchema = z.object({
  serverId: z.string().trim().min(1).max(255),
});

export type RemoteSshTarget = z.infer<typeof RemoteSshTargetSchema>;
export type RemoteSshStartInput = z.infer<typeof RemoteSshStartInputSchema>;
export type RemoteSshProfileInput = z.infer<typeof RemoteSshProfileInputSchema>;

export type RemoteSshPhase =
  | "connecting"
  | "inspecting"
  | "preparing-runtime"
  | "uploading"
  | "installing"
  | "starting"
  | "pairing"
  | "complete";

export type RemoteSshEvent =
  | {
      operationId: string;
      type: "phase";
      phase: RemoteSshPhase;
      message: string;
      progress?: number;
    }
  | { operationId: string; type: "terminal"; data: string }
  | { operationId: string; type: "interactive"; enabled: boolean }
  | { operationId: string; type: "failed"; message: string };

export interface RemoteSshDeployResult {
  operationId: string;
  offerUrl: string;
  hostname: string;
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  runtimeRoot: string;
  deployedVersion: string;
  target: RemoteSshTarget;
}
