import { z } from "zod";
import type { OmpCodexSubscription } from "@omp-desktop/protocol/messages";
import type { CodexAccountQuotaCredential } from "./codex-account-quota.js";

const SubscriptionClaimsSchema = z.object({
  exp: z.number().finite(),
  "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_subscription_active_until: z.string().nullable().optional(),
  }),
});

/** Display metadata only: OAuth claims are not an authorization or live billing decision. */
export function resolveCodexSubscription(
  credential: CodexAccountQuotaCredential,
  planLabel: string | null,
  nowMs: number,
): OmpCodexSubscription {
  if (planLabel?.trim().toLowerCase() === "free") {
    return { status: "none", expiresAt: null };
  }
  const unavailable: OmpCodexSubscription = { status: "unavailable", expiresAt: null };
  try {
    const parts = credential.accessToken.split(".");
    if (parts.length !== 3) return unavailable;
    const claims = SubscriptionClaimsSchema.parse(
      JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
    );
    // Never confuse the credential's expiration with the subscription's expiration.
    if (claims.exp * 1000 <= nowMs) return unavailable;
    const auth = claims["https://api.openai.com/auth"];
    if (credential.accountId && auth.chatgpt_account_id !== credential.accountId)
      return unavailable;
    const value = auth.chatgpt_subscription_active_until;
    // Require an unambiguous timezone-qualified timestamp rather than local-time guessing.
    if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return unavailable;
    const expiresMs = Date.parse(value);
    if (!Number.isFinite(expiresMs)) return unavailable;
    return {
      status: expiresMs > nowMs ? "active" : "expired",
      expiresAt: new Date(expiresMs).toISOString(),
    };
  } catch {
    return unavailable;
  }
}
