import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isNative, isWeb } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  resolveTouchInteractionState,
  type RuntimePointerModality,
  type StaticDeviceInputSnapshot,
  type TouchInteractionState,
} from "@/utils/device-input";

const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const PRIMARY_COARSE_POINTER_QUERY = "(pointer: coarse)";
const ANY_COARSE_POINTER_QUERY = "(any-pointer: coarse)";
const HOVER_MEDIA_QUERY = "(hover: hover)";

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
}

function getPointerQueryList(query: string): MediaQueryList | null {
  if (!isWeb || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(query);
}

function queryMatches(query: string): boolean {
  return getPointerQueryList(query)?.matches ?? false;
}

// Single shared runtime pointer modality tracker across the app: captures the latest real
// pointerdown event so hybrid devices or spoofed UAs still respond to actual touch/mouse usage.
let runtimePointerModality: RuntimePointerModality = null;
const runtimePointerListeners = new Set<() => void>();
let runtimePointerAttached = false;

function handleGlobalPointerDown(event: PointerEvent): void {
  const next: RuntimePointerModality =
    event.pointerType === "touch" || event.pointerType === "pen" || event.pointerType === "mouse"
      ? event.pointerType
      : null;
  if (!next || next === runtimePointerModality) return;
  runtimePointerModality = next;
  for (const listener of runtimePointerListeners) {
    listener();
  }
}

function subscribeRuntimePointerModality(listener: () => void): () => void {
  runtimePointerListeners.add(listener);
  if (isWeb && typeof window !== "undefined" && !runtimePointerAttached) {
    window.addEventListener("pointerdown", handleGlobalPointerDown, {
      capture: true,
      passive: true,
    });
    runtimePointerAttached = true;
  }
  return () => {
    runtimePointerListeners.delete(listener);
    if (
      runtimePointerListeners.size === 0 &&
      runtimePointerAttached &&
      typeof window !== "undefined"
    ) {
      window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
      runtimePointerAttached = false;
    }
  };
}

function getRuntimePointerModalitySnapshot(): RuntimePointerModality {
  return runtimePointerModality;
}

/** Test-only reset helper for deterministic pointer modality assertions. */
export function resetRuntimePointerModalityForTests(): void {
  runtimePointerModality = null;
}

function readStaticDeviceInputSnapshot(): StaticDeviceInputSnapshot {
  const nav =
    typeof navigator !== "undefined" ? (navigator as NavigatorWithUserAgentData) : undefined;
  const hasMatchMedia =
    isWeb && typeof window !== "undefined" && typeof window.matchMedia === "function";
  return {
    isNative,
    isElectron: isWeb && isElectronRuntime(),
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
    maxTouchPoints: typeof nav?.maxTouchPoints === "number" ? nav.maxTouchPoints : 0,
    userAgentDataMobile: nav?.userAgentData?.mobile ?? null,
    userAgentDataPlatform: nav?.userAgentData?.platform ?? null,
    hasMatchMedia,
    hasFinePointerMedia: queryMatches(FINE_POINTER_QUERY),
    hasCoarsePointerMedia: queryMatches(PRIMARY_COARSE_POINTER_QUERY),
    hasAnyCoarsePointerMedia: queryMatches(ANY_COARSE_POINTER_QUERY),
    hasHoverMedia: queryMatches(HOVER_MEDIA_QUERY),
  };
}

function useMediaQueryMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => queryMatches(query));

  useEffect(() => {
    const mediaQuery = getPointerQueryList(query);
    if (!mediaQuery) return;
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener?.("change", handleChange);
    return () => {
      mediaQuery.removeEventListener?.("change", handleChange);
    };
  }, [query]);

  return matches;
}

/** True when a mouse-like pointer drives the UI. Always false on native. */
export function hasFinePointer(): boolean {
  return queryMatches(FINE_POINTER_QUERY);
}

/**
 * Full device + pointer + user-override interaction state, independent of screen resolution.
 */
export function useTouchInteractionState(): TouchInteractionState {
  const preference = useSidebarViewStore((state) => state.touchMode);
  const runtimePointer = useSyncExternalStore(
    subscribeRuntimePointerModality,
    getRuntimePointerModalitySnapshot,
    getRuntimePointerModalitySnapshot,
  );
  const hasFinePointerMedia = useMediaQueryMatch(FINE_POINTER_QUERY);
  const hasCoarsePointerMedia = useMediaQueryMatch(PRIMARY_COARSE_POINTER_QUERY);
  const hasAnyCoarsePointerMedia = useMediaQueryMatch(ANY_COARSE_POINTER_QUERY);
  const hasHoverMedia = useMediaQueryMatch(HOVER_MEDIA_QUERY);

  return useMemo(() => {
    const environment: StaticDeviceInputSnapshot = {
      ...readStaticDeviceInputSnapshot(),
      hasFinePointerMedia,
      hasCoarsePointerMedia,
      hasAnyCoarsePointerMedia,
      hasHoverMedia,
    };
    return resolveTouchInteractionState({ preference, environment, runtimePointer });
  }, [
    preference,
    runtimePointer,
    hasFinePointerMedia,
    hasCoarsePointerMedia,
    hasAnyCoarsePointerMedia,
    hasHoverMedia,
  ]);
}

/**
 * True when touch-sized controls and touch-safe interaction rules should be active.
 * Driven strictly by device identity, pointer capabilities, runtime pointer modality,
 * and the explicit user touch-mode override — never by viewport width or breakpoints.
 */
export function useTouchInteraction(): boolean {
  return useTouchInteractionState().isTouchInteraction;
}

/** True when the current environment is identified as a touch-first device (or forced on). */
export function useIsTouchDevice(): boolean {
  return useTouchInteractionState().isTouchDevice;
}

/** True when hover-triggered surfaces (hover cards, mouse tooltips, flyouts) should activate. */
export function useSupportsHover(): boolean {
  return useTouchInteractionState().supportsHover;
}

/**
 * Reactive `hasFinePointer()` — respects explicit touch-mode overrides and device detection
 * so touch tablets (e.g. iPadOS desktop Safari) do not render hairline mouse-only handles.
 */
export function useHasFinePointer(): boolean {
  const preference = useSidebarViewStore((state) => state.touchMode);
  const finePointerMedia = useMediaQueryMatch(FINE_POINTER_QUERY);
  const { isTouchInteraction } = useTouchInteractionState();
  if (preference === "on") return false;
  if (preference === "off") return !isNative;
  return !isTouchInteraction && finePointerMedia;
}

/** Includes hybrid devices with both touch and a fine mouse pointer. */
export function useHasCoarsePointer(): boolean {
  return useMediaQueryMatch(ANY_COARSE_POINTER_QUERY);
}

/** Stable action affordances for touch, keyboard-only, and compact layouts. */
export function useShowPersistentActions(): boolean {
  const compact = useIsCompactFormFactor();
  const isTouchInteraction = useTouchInteraction();
  const finePointer = useHasFinePointer();
  const coarsePointer = useHasCoarsePointer();
  return compact || isTouchInteraction || !finePointer || coarsePointer;
}
