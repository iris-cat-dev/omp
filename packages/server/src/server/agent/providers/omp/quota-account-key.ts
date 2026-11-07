import { createHash } from "node:crypto";

interface QuotaCredentialIdentity {
  credentialId: number;
  provider: string;
  accessToken: string;
  identityKey?: string;
  accountId?: string;
  orgId?: string;
}

// Stable identity survives token refresh; token identity is a fallback only for
// credentials with no account metadata. The digest stays internal to the provider.
export function quotaAccountKey(databasePath: string, account: QuotaCredentialIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        databasePath,
        account.provider,
        account.credentialId,
        account.identityKey ?? null,
        account.accountId ?? null,
        account.orgId ?? null,
        account.identityKey || account.accountId || account.orgId ? null : account.accessToken,
      ]),
    )
    .digest("hex");
}
