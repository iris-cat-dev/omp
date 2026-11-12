export function redactQqMessage(text: string, values: Iterable<string>): string {
  for (const value of values) {
    if (!value) continue;
    text = text.replaceAll(value, '[redacted]');
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) text = text.replaceAll(escaped, '[redacted]');
  }
  return text.replace(/("(?:access.?token|app.?secret|client.?secret|token)"\s*:\s*")((?:\\.|[^"\\])*)"/gi, '$1[redacted]"').replace(/(Authorization\s*[:=]\s*(?:QQBot|Bearer)\s+)\S+/gi, '$1[redacted]');
}
