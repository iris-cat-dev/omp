export interface AuthenticationErrorDetails {
  kind: "region" | "timeout" | "refresh" | "missing";
  provider?: string;
  details: string;
}

const systemErrorPrefix = "[System Error] ";
const refreshFailure = /^(?:OAuthRefreshUnavailableError: )?OAuth token refresh failed for provider ([\w.-]+):\s*/;
const refreshTimeout = /^(?:OAuthError: )?OAuth token refresh timed out for provider: ([\w.-]+)/;
const missingKey = /^(?:MissingApiKeyError: )?No API key (?:found for |for provider: )["']?([\w-]+(?:\.[\w-]+)*)["']?(?=[.\s]|$)/;
const missingKeyWithoutProvider = /^(?:MissingApiKeyError: )?No API key available[.]?(?:\s|$)/;
const regionRejection = /\bunsupported_country_region_territory\b|\bCountry, region, or territory not supported\b/i;
const timeoutCause = /\b(?:timed?\s*out|timeout|TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/i;

export function classifyAuthenticationError(message: string): AuthenticationErrorDetails | null {
  if (!message.startsWith(systemErrorPrefix)) return null;
  const details = message.slice(systemErrorPrefix.length);

  const refresh = refreshFailure.exec(details);
  if (refresh) {
    const cause = details.slice(refresh[0].length);
    const kind = regionRejection.test(cause)
      ? "region"
      : timeoutCause.test(cause)
        ? "timeout"
        : "refresh";
    return { kind, provider: refresh[1], details };
  }

  const timeout = refreshTimeout.exec(details);
  if (timeout) return { kind: "timeout", provider: timeout[1], details };

  // Historical missing-key errors also swallowed refresh failures. Their text
  // cannot establish whether credentials are absent or why refresh failed.
  const missing = missingKey.exec(details);
  if (missing) return { kind: "missing", provider: missing[1], details };
  if (missingKeyWithoutProvider.test(details)) return { kind: "missing", details };

  return null;
}
