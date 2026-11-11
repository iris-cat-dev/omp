import type { DesktopPetActivity } from "./types.js";

// Keep this factory self-contained: html.ts embeds its emitted JavaScript in the sandboxed page.
export function createWorkChatter() {
  const lines = [
    { text: "智商变高了！", animation: "ready" },
    { text: "不想上班...", animation: "running" },
    { text: "大佬！", animation: "ready" },
    { text: "wooo！wow！", animation: "ready" },
    { text: "Tibo什么时候重置...", animation: "running" },
  ] as const;

  return {
    line: null as (typeof lines)[number] | null,
    nextAt: Infinity,
    update(
      activity: Pick<DesktopPetActivity, "connected" | "tasks">,
      now: number,
      enabled: boolean,
    ): boolean {
      // Attention keeps its existing priority, even if another task is still running.
      if (!enabled || !activity.connected || activity.tasks[0]?.status !== "running") {
        const changed = this.line !== null;
        this.line = null;
        this.nextAt = Infinity;
        return changed;
      }
      if (this.nextAt === Infinity) {
        this.nextAt = now + 30_000 + Math.random() * 30_000;
        return false;
      }
      if (now < this.nextAt) return false;
      if (this.line) {
        this.line = null;
        this.nextAt = now + 30_000 + Math.random() * 30_000;
      } else {
        this.line = lines[Math.floor(Math.random() * lines.length)];
        this.nextAt = now + 5_000;
      }
      return true;
    },
  };
}
