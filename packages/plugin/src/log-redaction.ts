const REDACTED = "[redacted]";

/** Learns only secrets actually set/read through this installation's scoped host API. */
export class PluginLogRedactor {
  private readonly values = new Set<string>();
  private pattern: RegExp | undefined;

  rememberSecret(input: unknown, output?: unknown): void {
    if (!input || typeof input !== "object") return;
    const request = input as { operation?: unknown; value?: unknown };
    const value = request.operation === "set" ? request.value : request.operation === "get" ? output : undefined;
    if (typeof value !== "string" || value.length === 0) return;
    let changed = false;
    for (const candidate of [value, JSON.stringify(value).slice(1, -1), ...value.split(/\r?\n/)]) {
      if (!candidate || this.values.has(candidate)) continue;
      this.values.add(candidate);
      changed = true;
    }
    if (changed) this.pattern = new RegExp(
      [...this.values].sort((left, right) => right.length - left.length)
        .map(candidate => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "g",
    );
  }

  redact(message: string, truncated = false): string {
    if (truncated) {
      // Output capture deliberately retains only the line prefix. Do not disclose a
      // secret which straddles that byte boundary (including a split UTF-8 scalar).
      message = message.replace(/\uFFFD+$/, "");
      for (const value of this.values) {
        for (let length = Math.min(value.length - 1, message.length); length > 0; length -= 1) {
          if (!message.endsWith(value.slice(0, length))) continue;
          message = message.slice(0, -length) + REDACTED;
          break;
        }
      }
      message = message.replace(/credential-draft:[0-9a-f-]*$/gi, REDACTED);
    }
    return (this.pattern ? message.replace(this.pattern, REDACTED) : message)
      .replace(/credential-draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, REDACTED)
      .replace(/(["']?credentialKey["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, `$1"${REDACTED}"`);
  }
}
