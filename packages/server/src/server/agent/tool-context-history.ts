import { Buffer } from "node:buffer";
import type { AgentToolContextChange } from "./agent-timeline-store-types.js";

export interface ToolContext {
  summary: string;
  log: string;
}

export function toolContextKey(callId: string, turnId?: string): string {
  return JSON.stringify([turnId ?? null, callId]);
}

export function copyContextText(text: string): string {
  // Keep a short summary/edit from retaining an arbitrarily large V8 parent string.
  return Buffer.from(text, "utf16le").toString("utf16le");
}

export function createToolContextChange(input: {
  callId: string;
  turnId?: string;
  previous?: ToolContext;
  next: ToolContext;
}): AgentToolContextChange | null {
  const { previous, next } = input;
  const oldLog = previous?.log ?? "";
  if (previous?.summary === next.summary && oldLog === next.log) return null;
  const change: AgentToolContextChange = {
    callId: input.callId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(previous?.summary !== next.summary ? { summary: copyContextText(next.summary) } : {}),
  };
  if (oldLog !== next.log) {
    let prefix = 0;
    const limit = Math.min(oldLog.length, next.log.length);
    while (prefix < limit && oldLog.charCodeAt(prefix) === next.log.charCodeAt(prefix)) prefix += 1;
    let oldEnd = oldLog.length;
    let newEnd = next.log.length;
    while (
      oldEnd > prefix &&
      newEnd > prefix &&
      oldLog.charCodeAt(oldEnd - 1) === next.log.charCodeAt(newEnd - 1)
    ) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    change.log = {
      prefix,
      deleteCount: oldEnd - prefix,
      text: copyContextText(next.log.slice(prefix, newEnd)),
    };
  }
  return change;
}

export function applyToolContextChanges(
  contexts: Map<string, ToolContext>,
  changes: readonly AgentToolContextChange[],
): void {
  for (const change of changes) {
    const key = toolContextKey(change.callId, change.turnId);
    const previous = contexts.get(key);
    const oldLog = previous?.log ?? "";
    const log = change.log
      ? copyContextText(
          oldLog.slice(0, change.log.prefix) +
            change.log.text +
            oldLog.slice(change.log.prefix + change.log.deleteCount),
        )
      : oldLog;
    contexts.set(key, { summary: change.summary ?? previous?.summary ?? "", log });
  }
}
