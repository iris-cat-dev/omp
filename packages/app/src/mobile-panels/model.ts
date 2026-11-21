import type { MobilePanelSelection, MobilePanelView } from "@/stores/panel-store";

export interface MobilePanelMotionState extends MobilePanelSelection {
  motionTarget: MobilePanelView;
  settledTarget: MobilePanelView;
}

export interface MobilePanelTransition {
  animationTarget?: MobilePanelView;
  state: MobilePanelMotionState;
}

export type MobilePanelEvent =
  | { type: "command"; selection: MobilePanelSelection }
  | { type: "animation.finished"; revision: number; target: MobilePanelView };

export function createMobilePanelMotionState(
  selection: MobilePanelSelection,
): MobilePanelMotionState {
  return {
    ...selection,
    motionTarget: selection.target,
    settledTarget: selection.target,
  };
}

export function transitionMobilePanel(
  state: MobilePanelMotionState,
  event: MobilePanelEvent,
): MobilePanelTransition {
  "worklet";
  if (event.type === "command") {
    if (event.selection.revision <= state.revision) {
      return { state };
    }
    return {
      animationTarget: event.selection.target,
      state: {
        ...state,
        ...event.selection,
        motionTarget: event.selection.target,
      },
    };
  }

  const ownsCurrentRevision = event.revision === state.revision;
  const isCanonicalTarget = event.target === state.target;
  const isCurrentMotionTarget = event.target === state.motionTarget;
  if (!ownsCurrentRevision || !isCanonicalTarget || !isCurrentMotionTarget) {
    return { state };
  }
  return {
    state: { ...state, settledTarget: event.target },
  };
}

export function getMobilePanelAnchor(panel: MobilePanelView): number {
  "worklet";
  if (panel === "agent-list") {
    return -1;
  }
  if (panel === "file-explorer") {
    return 1;
  }
  return 0;
}

export function getMobilePanelFrame(position: number, width: number) {
  "worklet";
  const clampedPosition = Math.max(-1, Math.min(1, position));
  return {
    leftBackdropOpacity: Math.max(0, -clampedPosition),
    leftTranslateX: -Math.min(1, clampedPosition + 1) * width,
    rightBackdropOpacity: Math.max(0, clampedPosition),
    rightTranslateX: Math.min(1, 1 - clampedPosition) * width,
  };
}
