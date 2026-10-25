import { describe, expect, it } from "vitest";
import {
  clampMonitorPanel,
  monitorArrangement,
  monitorNameplate,
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
