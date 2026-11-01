import type { Rectangle } from "electron";
import type { OmpMonitorViewState } from "./view-types.js";

// Agent Speed v1.6.1 PerfCardPlacement / PerfCardWindow, in DIP.
export const MONITOR_PERF_CARD_METRICS = {
  width: 320,
  gap: 8,
  inset: 8,
  shadow: { left: 24, top: 20, right: 24, bottom: 32 },
} as const;

/** The anchor is the host panel's client-space frame; rowTop is the hovered row's top. */
export interface OmpMonitorPerfCardRequest {
  agentId: string;
  anchor: Rectangle;
  rowTop: number;
  topCount: number;
  subAgents: number;
  facts: string[];
}

/** Read-only renderer state for the separate, nonactivating tooltip window. */
export interface OmpMonitorPerfCardState {
  sequence: number;
  request: OmpMonitorPerfCardRequest | null;
  view: OmpMonitorViewState;
  maxCardHeight: number;
  slideFrom: number;
}

export interface OmpMonitorPerfCardSize {
  sequence: number;
  height: number;
  compact: 0 | 1 | 2;
}
