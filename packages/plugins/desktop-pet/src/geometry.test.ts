import { describe, expect, it } from "vitest";
import { clampPetBounds, petWindowSize } from "./geometry.js";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1280, y: 80, width: 1280, height: 720 };

describe("companion display bounds", () => {
  it("preserves a valid negative-coordinate position on a secondary monitor", () => {
    expect(clampPetBounds({ x: -1000, y: 200 }, "medium", [primary, left])).toEqual({
      x: -1000,
      y: 200,
      ...petWindowSize("medium"),
    });
  });
  it("brings positions from disconnected displays onto an available work area", () => {
    expect(clampPetBounds({ x: -1000, y: 200 }, "medium", [primary])).toEqual({
      x: 0,
      y: 200,
      ...petWindowSize("medium"),
    });
  });
  it("clamps the whole resized window, including its bubble, to work-area edges", () => {
    const bounds = clampPetBounds({ x: 1850, y: 980 }, "large", [primary, left]);
    expect(bounds.x + bounds.width).toBe(primary.width);
    expect(bounds.y + bounds.height).toBe(primary.height);
    const tiny = clampPetBounds(null, "large", [{ x: 0, y: 0, width: 180, height: 150 }]);
    expect(tiny).toEqual({ x: 0, y: 0, width: 180, height: 150 });
  });
  it("selects the nearest actual monitor instead of leaving a pet in a display gap", () => {
    const separated = { x: 2600, y: 0, width: 1280, height: 720 };
    const bounds = clampPetBounds({ x: 2400, y: 100 }, "small", [primary, separated]);
    expect(bounds.x).toBe(2600);
    expect(bounds.y).toBe(100);
  });
});
