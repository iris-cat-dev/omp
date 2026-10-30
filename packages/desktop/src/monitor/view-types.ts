import type { OmpMonitorScope, OmpMonitorSnapshot } from "./types.js";
import type { OmpMonitorBoardSummary } from "./board-types.js";

export type OmpMonitorSurface = "orb" | "dashboard" | "history" | "settings" | "board";
export type OmpMonitorOrbStyle = "led" | "needle" | "liquid" | "reactor" | "minimal";
export type OmpMonitorEffects = "off" | "soft" | "standard" | "max";
export type OmpMonitorTitleTheme =
  | "vehicles"
  | "animals"
  | "wind"
  | "space"
  | "cultivation"
  | "wuxia"
  | "mage"
  | "gameRank"
  | "engineer";

export interface OmpMonitorPreferences {
  appearance: "system" | "dark" | "light";
  effects: OmpMonitorEffects;
  language: "system" | "en" | "zh";
  redline: number;
  style: OmpMonitorOrbStyle;
  titleTheme: OmpMonitorTitleTheme;
  size: number;
  opacity: number;
  pinned: boolean;
  clickThrough: boolean;
  fadeWhenIdle: boolean;
  nameMode: "auto" | "always" | "never";
  showPerformance: boolean;
  showThinking: boolean;
}

export type OmpMonitorConfigure = Partial<OmpMonitorPreferences>;

/** The isolated view receives only safe preferences and the numeric log projection. */
export interface OmpMonitorViewState {
  language: "zh" | "en";
  surface: OmpMonitorSurface;
  instanceId: string;
  orbVisible: boolean;
  nameplatePlacement: "above" | "below";
  nameplateMaxWidth: number;
  maxFps: 30 | 60;
  activity: OmpMonitorActivityEvents;
  preferences: OmpMonitorPreferences;
  scope: OmpMonitorScope;
  scopes: { profiles: string[]; projects: string[] };
  snapshot: OmpMonitorSnapshot | null;
  workerError: boolean;
  preferenceError: boolean;
  refreshing: boolean;
  windowCount: number;
  orbs: OmpMonitorOrbSummary[];
  maxWindows: number;
  board: OmpMonitorBoardSummary | null;
  boards: OmpMonitorBoardSummary[];
}

export type OmpMonitorExportResult = "saved" | "cancelled" | "unavailable" | "failed";

export interface OmpMonitorExportRange {
  startDate: string;
  endDate: string;
}

export interface OmpMonitorActivityEvents {
  responseSequence: number;
  peakSequence: number;
  lastResponseAt: number | null;
  /** Completion that revealed the peak; measurement time is snapshot.activity.peakAt. */
  lastPeakAt: number | null;
}

export interface OmpMonitorOrbSummary {
  instanceId: string;
  scope: OmpMonitorScope;
  style: OmpMonitorOrbStyle;
  size: number;
  visible: boolean;
  clickThrough: boolean;
  pinned: boolean;
}
