import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PluginLogRedactor } from "./log-redaction.js";
import { PluginOutputCapture } from "./worker-output.js";

describe("installation-scoped log redaction", () => {
  it("redacts scoped secret set/get results and staging references without hiding normal fields", () => {
    const redactor = new PluginLogRedactor();
    redactor.rememberSecret({ operation: "set", value: "test-app-secret" });
    redactor.rememberSecret({ operation: "get" }, "test-access-token");
    redactor.rememberSecret({ operation: "configured" }, true);
    expect(redactor.redact('account=one test-app-secret test-access-token credentialKey="credential-draft:11111111-2222-3333-4444-555555555555"'))
      .toBe('account=one [redacted] [redacted] credentialKey="[redacted]"');
    expect(new PluginLogRedactor().redact("test-app-secret")).toBe("test-app-secret");
  });

  it("redacts multiline and JSON-escaped secret values", () => {
    const redactor = new PluginLogRedactor();
    const secret = 'test-key-line\nsecond-test-line"';
    redactor.rememberSecret({ operation: "get" }, secret);
    expect(redactor.redact(JSON.stringify({ value: secret }))).toBe('{"value":"[redacted]"}');
    expect(redactor.redact("test-key-line")).toBe("[redacted]");
  });

  it("assembles fragmented UTF-8/secret output before redaction and masks a truncated secret prefix", () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const redactor = new PluginLogRedactor();
    const secret = "test-unicode-secret-😀-suffix";
    redactor.rememberSecret({ operation: "get" }, secret);
    const lines: string[] = [];
    new PluginOutputCapture(child, (_stream, message, truncated) => lines.push(redactor.redact(message, truncated)));
    const bytes = Buffer.from(`account=one ${secret}\n`);
    const split = bytes.indexOf(Buffer.from("😀")) + 1;
    child.stdout.emit("data", bytes.subarray(0, split));
    expect(lines).toEqual([]);
    child.stdout.emit("data", bytes.subarray(split));
    expect(lines).toEqual(["account=one [redacted]"]);
    child.stderr.emit("data", `${"z".repeat(16 * 1024 - 12)}${secret}\n`);
    expect(lines[1]).toBe(`${"z".repeat(16 * 1024 - 12)}[redacted]`);
    child.stdout.emit("data", "closing tail");
    child.emit("close");
    expect(lines.at(-1)).toBe("closing tail");
  });
});
