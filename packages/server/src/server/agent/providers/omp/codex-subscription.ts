import { z } from "zod";
import type { OmpCodexSubscription } from "@omp-desktop/protocol/messages";
import type {
  CodexAccountQuotaCredential,
  CodexAccountQuotaFetchOptions,
} from "./codex-account-quota.js";

export const CODEX_SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/wham/accounts/check";

const SubscriptionClaimsSchema = z.object({
  exp: z.number().finite(),
  "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().optional(),
    chatgpt_subscription_active_until: z.string().nullable().optional(),
  }),
});
const AccountIdentitySchema = z.union([
  z.object({ id: z.string(), plan_type: z.string().nullable().optional() }),
  z.object({
    account: z.object({
      account_id: z.string(),
      plan_type: z.string().nullable().optional(),
    }),
  }),
]);
const AccountResponseSchema = z.object({
  accounts: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
});
const EntitlementSchema = z.object({
  has_active_subscription: z.boolean(),
  expires_at: z.string().nullable().optional(),
});
const AccountEntitlementSchema = z.object({ entitlement: EntitlementSchema.optional() });

class SubscriptionResponseError extends Error {}

function subscriptionDate(value: unknown, nowMs: number): OmpCodexSubscription | null {
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const expiresMs = Date.parse(value);
  if (!Number.isFinite(expiresMs)) return null;
  return {
    status: expiresMs > nowMs ? "active" : "expired",
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

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
    return subscriptionDate(auth.chatgpt_subscription_active_until, nowMs) ?? unavailable;
  } catch {
    return unavailable;
  }
}

function parseAccountSubscription(
  payload: unknown,
  accountId: string,
  nowMs: number,
): OmpCodexSubscription {
  const response = AccountResponseSchema.safeParse(payload);
  if (!response.success)
    throw new SubscriptionResponseError("Codex subscription response was malformed");
  let selected: unknown;
  let selectedPlan: string | null | undefined;
  for (const value of Object.values(response.data.accounts)) {
    const identity = AccountIdentitySchema.safeParse(value);
    if (!identity.success) continue;
    const id = "id" in identity.data ? identity.data.id : identity.data.account.account_id;
    if (id !== accountId) continue;
    if (selected !== undefined)
      throw new SubscriptionResponseError("Codex subscription account was ambiguous");
    selected = value;
    selectedPlan =
      "id" in identity.data ? identity.data.plan_type : identity.data.account.plan_type;
  }
  // The default/personal workspace may belong to a different account.
  if (selected === undefined) {
    throw new SubscriptionResponseError("Codex subscription response omitted the selected account");
  }
  const account = AccountEntitlementSchema.safeParse(selected);
  if (!account.success)
    throw new SubscriptionResponseError("Codex subscription entitlement was malformed");
  const entitlement = account.data.entitlement;
  // WHAM supports account/plan lookup but may not expose billing entitlement metadata.
  if (!entitlement) {
    return selectedPlan?.trim().toLowerCase() === "free"
      ? { status: "none", expiresAt: null }
      : { status: "unavailable", expiresAt: null, unavailableReason: "unsupported" };
  }
  if (entitlement.expires_at != null) {
    const subscription = subscriptionDate(entitlement.expires_at, nowMs);
    if (!subscription)
      throw new SubscriptionResponseError("Codex subscription expiry was not a valid timestamp");
    return { ...subscription, source: "account" };
  }
  return entitlement.has_active_subscription
    ? { status: "unavailable", expiresAt: null, unavailableReason: "not_provided" }
    : { status: "none", expiresAt: null };
}

export async function fetchCodexSubscription(
  options: CodexAccountQuotaFetchOptions,
  planLabel: string | null,
): Promise<OmpCodexSubscription> {
  const now = options.now ?? Date.now;
  const metadata = resolveCodexSubscription(options.credential, planLabel, now());
  if (metadata.status !== "unavailable") {
    return metadata.expiresAt ? { ...metadata, source: "token" } : metadata;
  }
  const accessToken = options.credential.accessToken.trim();
  const accountId = options.credential.accountId?.trim();
  if (!accessToken || !accountId) {
    return {
      status: "unavailable",
      expiresAt: null,
      error: "Codex subscription lookup requires an account credential and identifier",
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetch ?? fetch)(CODEX_SUBSCRIPTION_ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
      },
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return { status: "unavailable", expiresAt: null, unavailableReason: "unsupported" };
    }
    if (!response.ok) {
      return {
        status: "unavailable",
        expiresAt: null,
        error: `Codex subscription lookup failed (HTTP ${response.status})`,
      };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: "unavailable",
        expiresAt: null,
        error: "Codex subscription response was not valid JSON",
      };
    }
    return parseAccountSubscription(payload, accountId, now());
  } catch (error) {
    // Never expose fetch errors that may contain credentials or response bodies.
    let message = "Codex subscription lookup failed";
    if (controller.signal.aborted) message = "Codex subscription lookup timed out";
    else if (error instanceof SubscriptionResponseError) message = error.message;
    return {
      status: "unavailable",
      expiresAt: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
