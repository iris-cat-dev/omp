import type { MonitorPosition } from "./window-preferences.js";
export type OmpMonitorBoardStyle = "glass" | "timing" | "neon";
export type OmpMonitorBoardSize = "small" | "medium" | "large";
export interface OmpMonitorBoardPreferences {
  style: OmpMonitorBoardStyle;
  size: OmpMonitorBoardSize;
  showPerformance: boolean;
  showThinking: boolean;
  showCost: boolean;
  pinned: boolean;
  clickThrough: boolean;
}
export interface OmpMonitorBoardSummary extends OmpMonitorBoardPreferences {
  id: string;
  orbId: string;
  visible: boolean;
}
export interface OmpMonitorBoardRecord extends OmpMonitorBoardSummary {
  positions: Record<string, MonitorPosition>;
}
export const MAX_MONITOR_BOARDS = 4;
export const DEFAULT_BOARD_PREFERENCES: Readonly<OmpMonitorBoardPreferences> = Object.freeze({
  style: "glass",
  size: "medium",
  showPerformance: true,
  showThinking: true,
  showCost: true,
  pinned: true,
  clickThrough: false,
});
