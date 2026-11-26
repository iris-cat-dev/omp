import { describe, expect, it } from "vitest";
import { classifyAuthenticationError } from "./authentication-error";

const legacyMissingDetails =
  "No API key found for openai-codex.\n\n" +
  "Use /login, set an API key environment variable, or create /home/user/.omp/agent/auth.db";

function refreshMessage(cause: string, provider = "openai-codex"): string {
  return `[System Error] OAuth token refresh failed for provider ${provider}: ${cause}`;
}

describe("classifyAuthenticationError", () => {
  it("keeps the original missing-key database hint in details and selects the missing guidance path", () => {
    expect(classifyAuthenticationError(`[System Error] ${legacyMissingDetails}`)).toEqual({
      kind: "missing",
      provider: "openai-codex",
      details: legacyMissingDetails,
    });
  });

  it("does not infer refresh causes from historical missing-key text or provider names", () => {
    const details =
      "No API key found for timeout-provider.\n\n" +
      "Use /login, set an API key environment variable, or create " +
      "/home/user/unsupported_country_region_territory/auth.db";
    expect(classifyAuthenticationError(`[System Error] ${details}`)).toEqual({
      kind: "missing",
      provider: "timeout-provider",
      details,
    });
  });

  it.each([
    ['No API key found for "anthropic"', "anthropic"],
    ["No API key found for 'openai-codex'.", "openai-codex"],
    ["No API key for provider: github-copilot", "github-copilot"],
    ["MissingApiKeyError: No API key for provider: custom.provider", "custom.provider"],
  ])("recognizes genuine missing-key errors: %s", (details, provider) => {
    expect(classifyAuthenticationError(`[System Error] ${details}`)).toEqual({
      kind: "missing",
      provider,
      details,
    });
  });

  it("does not invent a provider for a providerless missing-key error", () => {
    const details = "No API key available";
    expect(classifyAuthenticationError(`[System Error] ${details}`)).toEqual({
      kind: "missing",
      details,
    });
  });

  it.each([
    'Token refresh failed: 403 {"error":{"code":"unsupported_country_region_territory"}}',
    "403: Country, region, or territory not supported",
  ])("recognizes explicit region rejection during OAuth refresh: %s", (cause) => {
    expect(classifyAuthenticationError(refreshMessage(cause))).toEqual({
      kind: "region",
      provider: "openai-codex",
      details: `OAuth token refresh failed for provider openai-codex: ${cause}`,
    });
  });

  it("gives region rejection precedence over timeout and generic refresh failure", () => {
    const message = refreshMessage(
      "Request timed out after 403 unsupported_country_region_territory",
    );
    expect(classifyAuthenticationError(message)?.kind).toBe("region");
  });

  it.each([
    "OAuth token refresh timed out for provider: openai-codex",
    "Request timed out.",
    "The operation was aborted due to timeout",
    "TimeoutError: request deadline exceeded",
    "connect ETIMEDOUT 203.0.113.1:443",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("gives explicit timeout precedence over generic refresh failure: %s", (cause) => {
    expect(classifyAuthenticationError(refreshMessage(cause))?.kind).toBe("timeout");
  });

  it.each([
    "OAuth token refresh timed out for provider: anthropic",
    "OAuthError: OAuth token refresh timed out for provider: anthropic",
  ])("recognizes the standalone refresh timeout message: %s", (details) => {
    expect(classifyAuthenticationError(`[System Error] ${details}`)).toEqual({
      kind: "timeout",
      provider: "anthropic",
      details,
    });
  });

  it.each(["fetch failed", "Token refresh failed: 403 Forbidden", "500 Internal Server Error"])(
    "preserves a generic refresh cause without inventing a region or timeout: %s",
    (cause) => {
      expect(classifyAuthenticationError(refreshMessage(cause))).toEqual({
        kind: "refresh",
        provider: "openai-codex",
        details: `OAuth token refresh failed for provider openai-codex: ${cause}`,
      });
    },
  );

  it("looks for refresh causes in the cause, not the provider identifier", () => {
    expect(classifyAuthenticationError(refreshMessage("fetch failed", "timeout-provider"))?.kind)
      .toBe("refresh");
  });

  it("preserves the complete technical error verbatim after removing the system prefix", () => {
    const details =
      "OAuthRefreshUnavailableError: OAuth token refresh failed for provider openai-codex: " +
      'Token refresh failed: 403\n  {"error":{"code":"unsupported_country_region_territory"}}\n  ';
    expect(classifyAuthenticationError(`[System Error] ${details}`)).toEqual({
      kind: "region",
      provider: "openai-codex",
      details,
    });
  });

  it.each([
    "",
    legacyMissingDetails,
    "OAuth token refresh failed for provider openai-codex: fetch failed",
    "Here is the error: [System Error] No API key found for openai-codex.",
    " [System Error] No API key found for openai-codex.",
    "```\n[System Error] No API key found for openai-codex.\n```",
    "[System Error] Provider execution failed",
    "[System Error] Request timed out.",
    "[System Error] 403 unsupported_country_region_territory",
    "[System Error] The logs mention No API key found for openai-codex.",
    "[System Error] The logs mention OAuth token refresh failed for provider anthropic: timeout",
  ])("leaves ordinary assistant messages and unrelated system errors unchanged: %s", (message) => {
    expect(classifyAuthenticationError(message)).toBeNull();
  });
});
