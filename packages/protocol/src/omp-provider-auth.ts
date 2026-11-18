// SDK get_login_providers reports /login availability for every auth strategy.
// Browser-capable flows here emit onAuth without requiring a preceding prompt
// and never use the Desktop OAuth code input for secrets. Keep unknown and
// extension-defined flows terminal-only until the SDK advertises their strategy.
const OMP_BROWSER_LOGIN_PROVIDERS: Readonly<Record<string, true>> = {
  anthropic: true,
  cursor: true,
  devin: true,
  "gitlab-duo": true,
  "gitlab-duo-agent": true,
  "google-antigravity": true,
  "google-gemini-cli": true,
  kilo: true,
  "openai-codex": true,
  "openai-codex-device": true,
  openrouter: true,
  stencil: true,
  "zai-coding-plan": true,
};

/** Also serves as a conservative fallback for hosts without supportsBrowserLogin. */
export function isKnownOmpBrowserLoginProvider(providerId: string): boolean {
  return Object.hasOwn(OMP_BROWSER_LOGIN_PROVIDERS, providerId);
}
