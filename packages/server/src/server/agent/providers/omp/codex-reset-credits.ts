import { z } from "zod";
import {
  OmpCodexResetCreditConsumeResultSchema,
  type OmpCodexResetCreditConsumeResult,
  type OmpCodexResetCredits,
} from "@omp-desktop/protocol/messages";
import type { CodexAccountQuotaFetchOptions } from "./codex-account-quota.js";

export const CODEX_RESET_CREDITS_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

const ResetCreditsResponseSchema = z.object({
  available_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credits: z.array(
    z.object({
      id: z.string().trim().min(1),
      reset_type: z.string(),
      status: z.string(),
      granted_at: z.string(),
      expires_at: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  ),
});
const ConsumeResponseSchema = z.object({
  code: OmpCodexResetCreditConsumeResultSchema.shape.code,
  windows_reset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function parseCredits(payload: unknown): OmpCodexResetCredits {
  const parsed = ResetCreditsResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Codex reset card response was malformed");
  const ids = new Set<string>();
  const credits = parsed.data.credits.map((credit) => {
    if (ids.has(credit.id)) throw new Error("Codex reset card response contained duplicate IDs");
    ids.add(credit.id);
    return {
      id: credit.id,
      resetType: credit.reset_type,
      status: credit.status,
      grantedAt: credit.granted_at,
      expiresAt: credit.expires_at ?? null,
      title: credit.title ?? null,
      description: credit.description ?? null,
    };
  });
  return { status: "available", availableCount: parsed.data.available_count, credits };
}

class ResetCreditRequestError extends Error {}

async function parseResetCreditResponse(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new ResetCreditRequestError("Codex account authentication expired");
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new ResetCreditRequestError("Codex reset cards are unavailable for this account");
  }
  if (!response.ok) {
    throw new ResetCreditRequestError(`Codex reset card request failed (HTTP ${response.status})`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ResetCreditRequestError("Codex reset card response was not valid JSON", {
      cause: error,
    });
  }
}

async function request(
  options: CodexAccountQuotaFetchOptions,
  consume?: { creditId: string; redeemRequestId: string },
): Promise<unknown> {
  const accessToken = options.credential.accessToken.trim();
  if (!accessToken) throw new Error("Codex account credential is unavailable");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (options.credential.accountId) headers["ChatGPT-Account-Id"] = options.credential.accountId;
    if (consume) headers["Content-Type"] = "application/json";
    const response = await (options.fetch ?? fetch)(
      consume ? `${CODEX_RESET_CREDITS_ENDPOINT}/consume` : CODEX_RESET_CREDITS_ENDPOINT,
      {
        method: consume ? "POST" : "GET",
        headers,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
        ...(consume
          ? {
              body: JSON.stringify({
                credit_id: consume.creditId,
                redeem_request_id: consume.redeemRequestId,
              }),
            }
          : {}),
      },
    );
    return await parseResetCreditResponse(response);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ResetCreditRequestError("Codex reset card request timed out", { cause: error });
    }
    // Do not expose network errors, request bodies, or authorization headers.
    if (error instanceof ResetCreditRequestError) throw error;
    throw new ResetCreditRequestError("Codex reset card request failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCodexResetCredits(
  options: CodexAccountQuotaFetchOptions,
): Promise<OmpCodexResetCredits> {
  try {
    return parseCredits(await request(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex reset card request failed";
    return {
      status:
        message.includes("unavailable") || message.includes("authentication expired")
          ? "unavailable"
          : "error",
      availableCount: null,
      credits: [],
      error: message,
    };
  }
}

export async function consumeCodexResetCredit(
  options: CodexAccountQuotaFetchOptions & { creditId: string; redeemRequestId: string },
): Promise<OmpCodexResetCreditConsumeResult> {
  if (!options.creditId.trim() || !options.redeemRequestId.trim()) {
    throw new Error("Codex reset card and redemption request IDs are required");
  }
  const details = await fetchCodexResetCredits(options);
  if (details.status !== "available")
    throw new Error(details.error ?? "Codex reset cards unavailable");
  const card = details.credits.find((credit) => credit.id === options.creditId);
  const expiry = card?.expiresAt === null ? null : Date.parse(card?.expiresAt ?? "");
  if (
    !card ||
    card.status !== "available" ||
    card.resetType !== "codex_rate_limits" ||
    (expiry !== null && (!Number.isFinite(expiry) || expiry <= (options.now ?? Date.now)()))
  ) {
    throw new Error("The selected Codex reset card is not available or has expired");
  }
  const result = ConsumeResponseSchema.safeParse(await request(options, options));
  if (!result.success) {
    throw new Error("Codex reset card consumption response was malformed");
  }
  return { code: result.data.code, windowsReset: result.data.windows_reset };
}
