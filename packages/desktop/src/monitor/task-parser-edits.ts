// Agent Speed v1.5.0 edit-hunk parser (MIT), TASK-PARSERS §6. Never invents old text for hashline/AST rewrites.
import type { MonitorTaskHunk } from "./task-events.js";
import {
  taskArgs,
  taskJson,
  taskLf,
  taskLower,
  taskObject,
  taskRelative,
  taskSha16,
  taskTrim,
} from "./task-parser-common.js";
import type { TaskObject } from "./task-parser-common.js";
import { taskCommandText, taskParseShell } from "./task-parser-shell.js";
import type { TaskShell } from "./task-parser-shell.js";

function editPath(path: string, cwd: string | null): string {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith("file://")) p = p.slice(7);
  p = taskRelative(p, cwd)[0].replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.includes("/./")) p = p.replace(/\/\.\//g, "/");
  return p;
}
function textLines(text: string): string[] {
  const lines = taskLf(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  let start = 0,
    end = lines.length;
  while (start < end && !lines[start]) start++;
  while (end > start && !lines[end - 1]) end--;
  return lines.slice(start, end);
}
function hunk(path: string, old: string, next: string, cwd: string | null): MonitorTaskHunk {
  const a = textLines(old),
    b = textLines(next);
  let start = 0,
    aEnd = a.length,
    bEnd = b.length;
  while (start < aEnd && start < bEnd && a[start] === b[start]) start++;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  return {
    file: taskSha16(editPath(path, cwd)),
    old: taskSha16(a.slice(start, aEnd).join("\n")),
    new: taskSha16(b.slice(start, bEnd).join("\n")),
  };
}
function whole(path: string, text: string, cwd: string | null): MonitorTaskHunk {
  return {
    file: taskSha16(editPath(path, cwd)),
    old: null,
    new: taskSha16(textLines(text).join("\n")),
  };
}
function chunks(path: string, lines: string[], cwd: string | null): MonitorTaskHunk[] {
  const result: MonitorTaskHunk[] = [];
  let old: string[] = [],
    next: string[] = [],
    changed = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (changed) result.push(hunk(path, old.join("\n"), next.join("\n"), cwd));
      old = [];
      next = [];
      changed = false;
    } else if (line === "*** End of File") continue;
    else if (line.startsWith("-")) {
      old.push(line.slice(1));
      changed = true;
    } else if (line.startsWith("+")) {
      next.push(line.slice(1));
      changed = true;
    } else {
      const context = line.startsWith(" ") ? line.slice(1) : line;
      old.push(context);
      next.push(context);
    }
  }
  if (changed) result.push(hunk(path, old.join("\n"), next.join("\n"), cwd));
  return result;
}
const PATCH_HEADER = /^\*\*\* (Add File|Delete File|Update File|Move to): (.+)$/;
function patch(text: string, cwd: string | null): MonitorTaskHunk[] {
  const lines = taskLf(text).split("\n"),
    begin = lines.findIndex((line) => taskTrim(line) === "*** Begin Patch");
  const sections: { op: string; path: string; move: string | null; body: string[] }[] = [];
  for (const line of lines.slice(begin < 0 ? 0 : begin + 1)) {
    if (taskTrim(line) === "*** End Patch") break;
    const m = PATCH_HEADER.exec(line.replace(/[ \t]+$/, "")),
      last = sections.at(-1);
    if (m && m[1] === "Move to" && last?.op === "Update File") last.move = taskTrim(m[2]);
    else if (m && m[1] !== "Move to")
      sections.push({ op: m[1], path: taskTrim(m[2]), move: null, body: [] });
    else last?.body.push(line);
  }
  const result: MonitorTaskHunk[] = [];
  for (const s of sections) {
    if (s.op === "Add File")
      result.push(
        whole(
          s.path,
          s.body
            .filter((l) => l.startsWith("+"))
            .map((l) => l.slice(1))
            .join("\n"),
          cwd,
        ),
      );
    else if (s.op === "Delete File") result.push(whole(s.path, "", cwd));
    else {
      if (s.move) result.push(whole(s.path, "", cwd));
      result.push(...chunks(s.move ?? s.path, s.body, cwd));
    }
  }
  return result;
}
function hashline(text: string, cwd: string | null): MonitorTaskHunk[] {
  const lines = taskLf(text).split("\n"),
    result: MonitorTaskHunk[] = [];
  let path: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[ \t]+$/, ""),
      header = /^\[(.+)#([0-9A-Za-z]{4})\]$/.exec(line);
    if (header) {
      path = taskTrim(header[1]);
      continue;
    }
    if (path === null) continue;
    if (/^PUT (?:<[0-9]+|>[0-9]+\*?|>\$):$/.test(line)) {
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("+")) body.push(lines[++i].slice(1));
      if (body.length) result.push(hunk(path, "", body.join("\n"), cwd));
    } else if (line === "REM") result.push(whole(path, "", cwd));
    else {
      const move = /^MV (.+)$/.exec(line);
      if (move) {
        result.push(whole(path, "", cwd));
        path = taskTrim(move[1]);
      }
    }
  }
  return result;
}
function inputHunks(input: string, cwd: string | null): MonitorTaskHunk[] {
  const lines = taskLf(input).split("\n");
  if (lines.some((line) => PATCH_HEADER.test(line.replace(/[ \t]+$/, ""))))
    return patch(input, cwd);
  if (lines.some((line) => /^\[(.+)#[0-9A-Za-z]{4}\]$/.test(line.replace(/[ \t]+$/, ""))))
    return hashline(input, cwd);
  return [];
}
function replacementHunks(args: TaskObject, path: string, cwd: string | null): MonitorTaskHunk[] {
  const editValue = typeof args.edits === "string" ? taskJson(args.edits) : args.edits;
  let edits: unknown[];
  if (Array.isArray(editValue)) edits = editValue;
  else if (taskObject(editValue)) edits = [editValue];
  else edits = [];
  const pairs: [string, string][] = [];
  for (const edit of edits) {
    const o = taskObject(edit);
    if (typeof o?.oldText === "string" && typeof o.newText === "string")
      pairs.push([o.oldText, o.newText]);
  }
  if (
    typeof args.oldText === "string" &&
    typeof args.newText === "string" &&
    !pairs.some(([a, b]) => a === args.oldText && b === args.newText)
  )
    pairs.push([args.oldText, args.newText]);
  return pairs.map(([old, next]) => hunk(path, old, next, cwd));
}
export function taskEditHunks(
  tool: string,
  input: unknown,
  cwd: string | null = null,
  shell: TaskShell | null = null,
): MonitorTaskHunk[] {
  const name = taskLower(tool),
    args = taskArgs(input);
  if (name === "bash") {
    const command = taskCommandText(tool, input);
    return command === null
      ? []
      : (shell ?? taskParseShell(command, cwd)).patches.flatMap((text) => patch(text, cwd));
  }
  if (name !== "edit" && name !== "write") return [];
  if (!args) return [];
  const path = typeof args.path === "string" ? args.path : null;
  if (name === "write")
    return path && typeof args.content === "string" ? [whole(path, args.content, cwd)] : [];
  if (typeof args.input === "string") return inputHunks(args.input, cwd);
  if (!path) return [];
  if (typeof args.old_string === "string" && typeof args.new_string === "string")
    return [hunk(path, args.old_string, args.new_string, cwd)];
  if (
    Array.isArray(args.edits) &&
    args.edits.some((e) => {
      const o = taskObject(e);
      return o && ("diff" in o || "op" in o);
    })
  ) {
    return args.edits.flatMap((e) => {
      const o = taskObject(e);
      if (!o) return [];
      const op = o.op || "update",
        diff = typeof o.diff === "string" ? o.diff : "";
      if (op === "delete") return [whole(path, "", cwd)];
      if (op === "create") {
        let body = taskLf(diff).split("\n");
        if (body.filter(Boolean).every((l) => l.startsWith("+")))
          body = body.map((l) => l.slice(1));
        return [whole(path, body.join("\n"), cwd)];
      }
      const rename = typeof o.rename === "string" && o.rename ? o.rename : null;
      return [
        ...(rename ? [whole(path, "", cwd)] : []),
        ...chunks(rename ?? path, taskLf(diff).split("\n"), cwd),
      ];
    });
  }
  return replacementHunks(args, path, cwd);
}
