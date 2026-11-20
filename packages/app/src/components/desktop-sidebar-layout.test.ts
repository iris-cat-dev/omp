import { describe, expect, it } from "vitest";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
  resolveDesktopSidebarWidth,
  resolveRequestedSidebarWidth,
  TOUCH_DEFAULT_SIDEBAR_WIDTH,
} from "@/components/desktop-sidebar-layout";
import { DEFAULT_SIDEBAR_WIDTH } from "@/stores/panel-store";

describe("desktop sidebar layout", () => {
  it("keeps a retained sidebar hidden while app chrome is suppressed", () => {
    expect(
      resolveDesktopSidebarVisibility({
        chromeEnabled: false,
        isCompactLayout: false,
        isMounted: true,
        isOpen: true,
        canShare: true,
      }),
    ).toBe(false);
  });

  it("clamps a persisted wide sidebar to preserve the center pane", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);

    expect(resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 1440 })).toBe(600);
  });

  it("yields app navigation when settings needs the shell width", () => {
    const settingsMinimum = resolveDesktopAppContentMinimum({ isSettingsRoute: true });
    expect(settingsMinimum).toBe(720);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: settingsMinimum,
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(false);
  });

  it("imposes no content minimum outside settings", () => {
    expect(resolveDesktopAppContentMinimum({ isSettingsRoute: false })).toBe(0);
    expect(
      canDesktopAppSidebarShare({
        contentMinimumWidth: resolveDesktopAppContentMinimum({ isSettingsRoute: false }),
        requestedSidebarWidth: 320,
        viewportWidth: 751,
      }),
    ).toBe(true);
  });

  it("widens the default sidebar for touch interaction while respecting explicit user widths", () => {
    expect(
      resolveRequestedSidebarWidth({
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        isTouchInteraction: false,
      }),
    ).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(
      resolveRequestedSidebarWidth({
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        isTouchInteraction: true,
      }),
    ).toBe(TOUCH_DEFAULT_SIDEBAR_WIDTH);
    expect(
      resolveRequestedSidebarWidth({
        sidebarWidth: 360,
        isTouchInteraction: true,
      }),
    ).toBe(360);
    expect(
      resolveRequestedSidebarWidth({
        sidebarWidth: 240,
        isTouchInteraction: true,
      }),
    ).toBe(240);
  });
});
