import { describe, expect, it } from "vitest";
import {
  isMousePointerEvent,
  isTouchDeviceFromEnvironment,
  isTouchLikePointerEvent,
  resolveTouchInteractionState,
  type StaticDeviceInputSnapshot,
} from "./device-input";

const DESKTOP_MAC: StaticDeviceInputSnapshot = {
  isNative: false,
  isElectron: false,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  platform: "MacIntel",
  maxTouchPoints: 0,
  userAgentDataMobile: false,
  userAgentDataPlatform: "macOS",
  hasFinePointerMedia: true,
  hasCoarsePointerMedia: false,
  hasAnyCoarsePointerMedia: false,
  hasHoverMedia: true,
};

describe("isTouchDeviceFromEnvironment", () => {
  it("identifies iPadOS 13+ desktop Safari via Mac UA + maxTouchPoints > 1 even when fine pointer media matches", () => {
    const ipadDesktopMode: StaticDeviceInputSnapshot = {
      ...DESKTOP_MAC,
      maxTouchPoints: 5,
      // Simulates iPad with Magic Keyboard/trackpad or spoofed fine-pointer media query.
      hasFinePointerMedia: true,
      hasCoarsePointerMedia: false,
      hasAnyCoarsePointerMedia: false,
      hasHoverMedia: true,
    };
    expect(isTouchDeviceFromEnvironment(ipadDesktopMode)).toBe(true);
  });

  it("identifies explicit iPad and Android tablet UAs regardless of pointer media", () => {
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPad",
        maxTouchPoints: 0,
      }),
    ).toBe(true);
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36",
        platform: "Linux armv81",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it("identifies Client Hints mobile/iOS/Android signals", () => {
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        userAgentDataMobile: true,
      }),
    ).toBe(true);
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        userAgentDataPlatform: "Android",
      }),
    ).toBe(true);
  });

  it("does not misclassify macOS with trackpad (maxTouchPoints <= 1) or Electron desktop", () => {
    expect(isTouchDeviceFromEnvironment({ ...DESKTOP_MAC, maxTouchPoints: 1 })).toBe(false);
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        isElectron: true,
        maxTouchPoints: 10,
        hasAnyCoarsePointerMedia: true,
      }),
    ).toBe(false);
  });

  it("identifies native apps and primary coarse pointer environments", () => {
    expect(isTouchDeviceFromEnvironment({ ...DESKTOP_MAC, isNative: true })).toBe(true);
    expect(
      isTouchDeviceFromEnvironment({
        ...DESKTOP_MAC,
        hasCoarsePointerMedia: true,
      }),
    ).toBe(true);
  });
});

describe("resolveTouchInteractionState", () => {
  it("switches a desktop browser into touch interaction on runtime touch/pen input and back on mouse", () => {
    const touchState = resolveTouchInteractionState({
      preference: "auto",
      environment: DESKTOP_MAC,
      runtimePointer: "touch",
    });
    expect(touchState).toEqual({
      isTouchInteraction: true,
      isTouchDevice: false,
      supportsHover: false,
    });

    const mouseState = resolveTouchInteractionState({
      preference: "auto",
      environment: DESKTOP_MAC,
      runtimePointer: "mouse",
    });
    expect(mouseState).toEqual({
      isTouchInteraction: false,
      isTouchDevice: false,
      supportsHover: true,
    });
  });

  it("keeps iPad in touch interaction even after a mouse/trackpad event when preference is auto", () => {
    const ipadState = resolveTouchInteractionState({
      preference: "auto",
      environment: { ...DESKTOP_MAC, maxTouchPoints: 5 },
      runtimePointer: "mouse",
    });
    expect(ipadState).toEqual({
      isTouchInteraction: true,
      isTouchDevice: true,
      supportsHover: false,
    });
  });

  it("respects explicit on/off user overrides regardless of detected device", () => {
    expect(
      resolveTouchInteractionState({
        preference: "on",
        environment: DESKTOP_MAC,
        runtimePointer: "mouse",
      }),
    ).toEqual({
      isTouchInteraction: true,
      isTouchDevice: true,
      supportsHover: false,
    });

    expect(
      resolveTouchInteractionState({
        preference: "off",
        environment: { ...DESKTOP_MAC, maxTouchPoints: 5 },
        runtimePointer: "touch",
      }),
    ).toEqual({
      isTouchInteraction: false,
      isTouchDevice: false,
      supportsHover: true,
    });
  });
});

describe("pointer event helpers", () => {
  it("distinguishes touch/pen events from mouse and synthetic mouse events", () => {
    expect(isTouchLikePointerEvent({ nativeEvent: { pointerType: "touch" } })).toBe(true);
    expect(isTouchLikePointerEvent({ pointerType: "pen" })).toBe(true);
    expect(isTouchLikePointerEvent({ nativeEvent: { pointerType: "mouse" } })).toBe(false);
    expect(isTouchLikePointerEvent({})).toBe(false);

    expect(isMousePointerEvent({ nativeEvent: { pointerType: "mouse" } })).toBe(true);
    expect(isMousePointerEvent({})).toBe(true);
    expect(isMousePointerEvent({ nativeEvent: { pointerType: "touch" } })).toBe(false);
    expect(isMousePointerEvent({ pointerType: "pen" })).toBe(false);
  });
});
