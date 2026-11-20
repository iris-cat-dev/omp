export type TouchInteractionPreference = "auto" | "on" | "off";

export type RuntimePointerModality = "mouse" | "touch" | "pen" | null;

export interface StaticDeviceInputSnapshot {
  isNative: boolean;
  isElectron: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  userAgentDataMobile?: boolean | null;
  userAgentDataPlatform?: string | null;
  /** False in non-browser/JSDOM environments where window.matchMedia is absent. */
  hasMatchMedia?: boolean;
  hasFinePointerMedia: boolean;
  hasCoarsePointerMedia: boolean;
  hasAnyCoarsePointerMedia: boolean;
  hasHoverMedia: boolean;
}

export interface TouchInteractionState {
  /** Whether touch-optimized hit targets and touch-safe interactions should be active. */
  isTouchInteraction: boolean;
  /** Whether the underlying device is identified as a touch-first device (or forced on). */
  isTouchDevice: boolean;
  /** Whether hover-driven surfaces (hover cards, mouse tooltips, flyouts) should activate. */
  supportsHover: boolean;
}

const MOBILE_OR_TABLET_UA_RE = /iPad|iPhone|iPod|Android|Mobile|Tablet|HarmonyOS|OpenHarmony/i;
const MAC_UA_OR_PLATFORM_RE = /Macintosh|Mac OS|Mac/i;
const MOBILE_CH_PLATFORM_RE = /^(Android|iOS|iPadOS)$/i;

/**
 * Classifies whether the current environment is a touch-first device (phone/tablet/native)
 * using only device identity and pointer capabilities — never viewport size or resolution.
 */
export function isTouchDeviceFromEnvironment(snapshot: StaticDeviceInputSnapshot): boolean {
  if (snapshot.isNative) {
    return true;
  }

  // Electron desktop hosts may run on touch-screen laptops; default to desktop interaction
  // unless an explicit preference override or runtime touch input switches modes.
  if (snapshot.isElectron) {
    return false;
  }

  if (snapshot.userAgentDataMobile === true) {
    return true;
  }

  if (
    snapshot.userAgentDataPlatform &&
    MOBILE_CH_PLATFORM_RE.test(snapshot.userAgentDataPlatform)
  ) {
    return true;
  }

  if (MOBILE_OR_TABLET_UA_RE.test(snapshot.userAgent)) {
    return true;
  }

  // iPadOS 13+ desktop Safari/WKWebView reports a Mac UA and platform="MacIntel",
  // while exposing multi-touch capability (maxTouchPoints > 1; real Macs report 0 or 1).
  const looksLikeMac =
    MAC_UA_OR_PLATFORM_RE.test(snapshot.userAgent) || MAC_UA_OR_PLATFORM_RE.test(snapshot.platform);
  if (looksLikeMac && snapshot.maxTouchPoints > 1) {
    return true;
  }

  const hasMatchMedia = snapshot.hasMatchMedia ?? true;
  if (hasMatchMedia) {
    if (snapshot.hasCoarsePointerMedia) {
      return true;
    }

    if (
      !snapshot.hasFinePointerMedia &&
      (snapshot.hasAnyCoarsePointerMedia || !snapshot.hasHoverMedia)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Combines explicit user preference, device identity, pointer media queries, and the latest
 * observed pointer modality into a single interaction state with zero resolution dependency.
 */
export function resolveTouchInteractionState({
  preference,
  environment,
  runtimePointer,
}: {
  preference: TouchInteractionPreference;
  environment: StaticDeviceInputSnapshot;
  runtimePointer: RuntimePointerModality;
}): TouchInteractionState {
  if (preference === "on") {
    return {
      isTouchInteraction: true,
      isTouchDevice: true,
      supportsHover: false,
    };
  }

  if (preference === "off") {
    return {
      isTouchInteraction: false,
      isTouchDevice: false,
      supportsHover: !environment.isNative,
    };
  }

  const isTouchDevice = isTouchDeviceFromEnvironment(environment);
  if (isTouchDevice) {
    return {
      isTouchInteraction: true,
      isTouchDevice: true,
      supportsHover: false,
    };
  }

  if (runtimePointer === "touch" || runtimePointer === "pen") {
    return {
      isTouchInteraction: true,
      isTouchDevice: false,
      supportsHover: false,
    };
  }

  const hasMatchMedia = environment.hasMatchMedia ?? true;
  return {
    isTouchInteraction: false,
    isTouchDevice: false,
    supportsHover:
      !environment.isNative &&
      (!hasMatchMedia || (environment.hasFinePointerMedia && environment.hasHoverMedia)),
  };
}

export function readPointerType(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const nativeEvent = Reflect.get(event, "nativeEvent");
  const source = typeof nativeEvent === "object" && nativeEvent !== null ? nativeEvent : event;
  const pointerType = Reflect.get(source, "pointerType");
  return typeof pointerType === "string" && pointerType.length > 0 ? pointerType : null;
}

export function isTouchLikePointerEvent(event: unknown): boolean {
  const pointerType = readPointerType(event);
  return pointerType === "touch" || pointerType === "pen";
}

export function isMousePointerEvent(event: unknown): boolean {
  const pointerType = readPointerType(event);
  // Treat synthetic MouseEvents without pointerType (e.g. JSDOM tests) as mouse-compatible,
  // while explicitly rejecting touch and pen pointers.
  return pointerType === null || pointerType === "mouse";
}
