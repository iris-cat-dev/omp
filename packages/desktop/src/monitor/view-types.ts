import type { OmpMonitorScope, OmpMonitorSnapshot } from "./types.js";
import type { OmpMonitorBoardSummary } from "./board-types.js";
import type { OmpTitleThemeId, OmpTitleThemesState } from "./title-themes.js";

export type OmpMonitorSurface = "orb" | "dashboard" | "history" | "settings" | "board";
export type OmpMonitorOrbStyle = "led" | "needle" | "liquid" | "reactor" | "minimal";
export type OmpMonitorEffects = "off" | "soft" | "standard" | "max";
export type OmpMonitorTitleTheme = OmpTitleThemeId;

export interface OmpMonitorPreferences {
  appearance: "system" | "dark" | "light";
  effects: OmpMonitorEffects;
  language: "system" | "en" | "zh";
  metric: "output" | "total";
  liveUnit: "tokens" | "cost";
  celebratePeaks: boolean;
  responsePulses: boolean;
  showOrbs: boolean;
  redline: number;
  redlineOutput: number;
  redlineTotal: number;
  orbRedlineOutput: number | null;
  orbRedlineTotal: number | null;
  orbUnit: "tokens" | "cost";
  style: OmpMonitorOrbStyle;
  titleTheme: OmpMonitorTitleTheme;
  orbTitleTheme: OmpMonitorTitleTheme | null;
  size: number;
  opacity: number;
  pinned: boolean;
  clickThrough: boolean;
  fadeWhenIdle: boolean;
  nameMode: "auto" | "always" | "never";
  showName: "auto" | "on" | "off";
  orbName: string | null;
  showPerformance: boolean;
  showThinking: boolean;
}

export type OmpMonitorConfigure = Partial<OmpMonitorPreferences>;

export type OmpMonitorOrbCommand =
  | { type: "visible"; instanceId: string; visible: boolean }
  | { type: "duplicate" | "remove" | "merge" | "resetPosition"; instanceId: string }
  | { type: "move"; instanceId: string; index: number }
  | { type: "undo" | "dismissUndo" };

/** A visual-only, explicitly labelled 20-second demo; never a worker/log projection. */
export interface OmpMonitorEffectsPreview {
  active: boolean;
  sequence: number;
  startedAt: number | null;
  endsAt: number | null;
}

export interface OmpMonitorSourceState {
  enabled: boolean;
  /** Canonical source configuration, exposed only to the authenticated Settings surface. */
  folder: string;
  usingDefaultFolder: boolean;
  status: "disabled" | "scanning" | "ready" | "missing" | "error";
  sessions: number;
  changing: boolean;
  /** Explicit injected QA roots cannot open a picker or escape their owned source. */
  canChangeFolder: boolean;
}

export type OmpMonitorChooseSourceResult = "changed" | "cancelled";

/** The isolated view receives only safe preferences and the numeric log projection. */
export interface OmpMonitorViewState {
  language: "zh" | "en";
  surface: OmpMonitorSurface;
  nativeFrame: boolean;
  instanceId: string;
  orbVisible: boolean;
  nameplatePlacement: "above" | "below";
  nameplateMaxWidth: number;
  maxFps: 30 | 60;
  activity: OmpMonitorActivityEvents;
  preferences: OmpMonitorPreferences;
  effectiveRedline: number;
  effectiveTitleTheme: OmpMonitorTitleTheme;
  orbName: string;
  titleThemes: OmpTitleThemesState;
  launchAtLogin: { enabled: boolean; supported: boolean; error: boolean };
  effectsPreview: OmpMonitorEffectsPreview;
  ompSource: OmpMonitorSourceState;
  orbUndo: { kind: "remove" | "merge"; expiresAt: number } | null;
  orbManagement: { canSplit: false; canMerge: boolean; reason: "single-omp-source" };
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

export interface OmpMonitorModeExportRange extends OmpMonitorExportRange {
  kind: "effort" | "speed";
}

export interface OmpMonitorActivityEvents {
  responseSequence: number;
  peakSequence: number;
  lastResponseAt: number | null;
  /** Completion revealing the selected metric's measured peak, never history discovery. */
  lastPeakAt: number | null;
}

export interface OmpMonitorOrbSummary {
  instanceId: string;
  name: string;
  effectiveRedline: number;
  scope: OmpMonitorScope;
  style: OmpMonitorOrbStyle;
  size: number;
  titleTheme: OmpMonitorTitleTheme;
  visible: boolean;
  clickThrough: boolean;
  pinned: boolean;
}
