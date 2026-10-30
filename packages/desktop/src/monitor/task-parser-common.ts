// Agent Speed v1.5.0 task parsers (MIT), upstream 29dffc4e6fbe1da435071e40781b1571dd45ac22.
import { createHash } from "node:crypto";

export type TaskObject = Record<string, unknown>;
export const taskObject = (value: unknown): TaskObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TaskObject)
    : null;
export const taskLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const taskTrim = (text: string): string => text.replace(/^[ \t]+|[ \t]+$(?![^])/g, "");
export const taskLf = (text: string): string => text.replace(/\r\n?/g, "\n");
export function taskScalars(text: string): string {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (value) =>
    value.length === 2 ? value : "\uFFFD",
  );
}
export const taskSha16 = (text: string): string =>
  createHash("sha256").update(taskScalars(text)).digest("hex").slice(0, 16);
export const taskCut = (text: string, count: number): string =>
  Array.from(taskScalars(text)).slice(0, count).join("");
export const taskInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
export function taskNumber(text: string): number {
  const digits = text.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  return (text.startsWith("-") ? -1 : 1) * (digits.length > 18 ? 1e18 : Number(digits));
}
export function taskJson(text: string): unknown {
  // Reject non-finite numbers and implementation-defined excessive nesting before retaining a value.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 512) return null;
    } else if (char === "}" || char === "]") depth--;
  }
  try {
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new SyntaxError("Non-finite JSON number");
      return value;
    });
  } catch {
    return null;
  }
}
export function taskArgs(value: unknown): TaskObject | null {
  if (typeof value === "string" && /^[ \t\r\n]*\{/.test(value)) return taskObject(taskJson(value));
  return taskObject(value);
}
export function taskBlocks(content: unknown): string {
  if (typeof content === "string") return taskScalars(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value) => {
      const b = taskObject(value);
      return b &&
        ["text", "input_text", "output_text"].includes(String(b.type)) &&
        typeof b.text === "string"
        ? [taskScalars(b.text)]
        : [];
    })
    .join("\n");
}
export function taskCwd(cwd: string | null): string | null {
  return cwd?.replace(/\\/g, "/").replace(/\/+$/, "") || null;
}
export function taskRelative(text: string, cwd: string | null): [string, boolean] {
  const root = taskCwd(cwd);
  if (!root) return [text, false];
  const [a, b] = /^[A-Za-z]:\//.test(root + "/")
    ? [taskLower(text), taskLower(root)]
    : [text, root];
  if (a === b) return ["", true];
  return a.startsWith(b + "/") ? [text.slice(root.length + 1), true] : [text, false];
}
// Metadata only: no arbitrary paths, titles or source text may enter task records or cache.
export function taskModel(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/@+ -]*$(?![^])/.test(value)
  )
    return null;
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("..") || value.includes("://")
    ? null
    : value;
}
export function taskEffort(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:off|none|minimal|low|medium|high|xhigh|max|auto|adaptive)$(?![^])/.test(value)
    ? value
    : null;
}
