import { describe, expect, it } from "vitest";
import {
  clampMonitorPanel,
  monitorArrangement,
  monitorNameplate,
  monitorPerfCardArea,
  placeMonitorPerfCard,
  placeMonitorOrb,
  snapMonitorOrb,
} from "./window-geometry.js";
import type { MonitorDisplay } from "./window-geometry.js";

const displays: MonitorDisplay[] = [
  { id: "primary", workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
];
describe("original orb native geometry", () => {
  it("snaps the visible disc rather than its transparent effect viewport to a twelve-DIP edge margin", () => {
    const bounds = snapMonitorOrb({ x: -30, y: 100, width: 222, height: 254 }, 148, displays, []);
    expect(bounds.x + 148 * 0.25).toBe(12);
    expect(bounds.y).toBe(100);
  });
  it("magnetically aligns neighbouring discs with twelve-DIP spacing, allowing their transparent auras to overlap", () => {
    const other = { x: 400, y: 100, width: 222, height: 254 };
    const bounds = snapMonitorOrb({ x: 575, y: 100, width: 222, height: 254 }, 148, displays, [
      { bounds: other, size: 148 },
    ]);
    expect(bounds.x + 0.25 * 148 - (other.x + 1.25 * 148)).toBe(12);
    expect(bounds.y).toBe(other.y);
  });
  it("keeps the disc on a remaining monitor and moves its nameplate above when docked at the bottom", () => {
    const bounds = placeMonitorOrb({ x: 10000, y: 10000 }, 148, displays);
    expect(bounds.x + 1.25 * 148).toBeLessThanOrEqual(1920);
    expect(bounds.y + 1.25 * 148).toBeLessThanOrEqual(1040);
    expect(monitorNameplate(bounds, 148, displays, [])).toMatchObject({ placement: "above" });
    const remaining: MonitorDisplay[] = [
      { id: "left", workArea: { x: -1280, y: 0, width: 1280, height: 720 } },
    ];
    const panel = clampMonitorPanel({ x: 5000, y: 1000, width: 800, height: 680 }, remaining);
    expect(panel).toEqual({ x: -800, y: 40, width: 800, height: 680 });
  });
  it("keeps arrangement identity stable when native screen enumeration order changes", () => {
    const left = { id: "left", workArea: { x: -1280, y: 0, width: 1280, height: 720 } };
    expect(monitorArrangement([displays[0]!, left])).toBe(monitorArrangement([left, displays[0]!]));
  });
});

describe("performance-card placement", () => {
  const area = displays[0]!.workArea;
  it("prefers the right even when the left has more room", () => {
    const anchor = { x: 1000, y: 100, width: 340, height: 340 };
    expect(placeMonitorPerfCard(anchor, 180, 540, area)).toEqual({
      x: 1348,
      y: 180,
      slideFrom: -2,
      onLeft: false,
    });
  });
  it("uses the left only when the right cannot fit and the left can", () => {
    const right = { x: 1500, y: 100, width: 368, height: 400 };
    expect(placeMonitorPerfCard(right, 180, 540, area)).toEqual({
      x: 1172,
      y: 180,
      slideFrom: 2,
      onLeft: true,
    });
    const left = { x: 100, y: 100, width: 340, height: 340 };
    expect(placeMonitorPerfCard(left, 180, 540, area)).toEqual({
      x: 448,
      y: 180,
      slideFrom: -2,
      onLeft: false,
    });
    const middle = { x: 790, y: 100, width: 340, height: 340 };
    expect(placeMonitorPerfCard(middle, 180, 540, area).onLeft).toBe(false);
  });
  it("keeps an exactly fitting right card on the right", () => {
    const anchor = { x: 1244, y: 100, width: 340, height: 340 };
    expect(placeMonitorPerfCard(anchor, 180, 540, area)).toEqual({
      x: 1592,
      y: 180,
      slideFrom: -2,
      onLeft: false,
    });
  });
  it("clamps fixed-width cards at the work-area inset when neither side can hold them", () => {
    const narrow = { x: 0, y: 0, width: 1000, height: 800 };
    const anchor = { x: 270, y: 40, width: 480, height: 400 };
    expect(placeMonitorPerfCard(anchor, 100, 500, narrow)).toEqual({
      x: 672,
      y: 100,
      slideFrom: -2,
      onLeft: false,
    });
    const asymmetric = { x: 0, y: 0, width: 1200, height: 800 };
    const wide = { x: 300, y: 40, width: 640, height: 400 };
    expect(placeMonitorPerfCard(wide, 100, 500, asymmetric)).toEqual({
      x: 872,
      y: 100,
      slideFrom: -2,
      onLeft: false,
    });
  });
  it("keeps natural height independent of the host and clamps only against the screen work area", () => {
    const anchor = { x: -900, y: 600, width: 280, height: 280 };
    const work = { x: -1280, y: 40, width: 1280, height: 960 };
    expect(placeMonitorPerfCard(anchor, 680, 600, work)).toEqual({
      x: -612,
      y: 392,
      slideFrom: -2,
      onLeft: false,
    });
    expect(placeMonitorPerfCard(anchor, 680, 1200, work).y).toBe(48);
    expect(placeMonitorPerfCard(anchor, 680, 600, { ...work, width: 300 }).x).toBe(-1272);
  });
  it("uses the whole panel's largest monitor intersection, including monitors with negative origins", () => {
    const screens: MonitorDisplay[] = [
      {
        id: "left",
        bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
        workArea: { x: -1280, y: 0, width: 1280, height: 984 },
      },
      { id: "right", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: area },
    ];
    expect(monitorPerfCardArea({ x: -300, y: 100, width: 340, height: 340 }, screens)).toBe(
      screens[0]!.workArea,
    );
    expect(monitorPerfCardArea({ x: -100, y: 100, width: 340, height: 340 }, screens)).toBe(area);
    expect(monitorPerfCardArea({ x: -3000, y: 100, width: 340, height: 340 }, screens)).toBe(
      screens[0]!.workArea,
    );
  });
});
