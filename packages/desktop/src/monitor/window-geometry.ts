import type { Rectangle } from "electron";
import type { MonitorPosition } from "./window-preferences.js";

export interface MonitorDisplay {
  id: number | string;
  workArea: Rectangle;
}
export interface OrbNeighbour {
  bounds: Rectangle;
  size: number;
}
const SNAP_DISTANCE = 24;
const EDGE_MARGIN = 12;

export function monitorArrangement(displays: readonly MonitorDisplay[]): string {
  return displays
    .map(({ id, workArea: a }) => `${id}:${a.x},${a.y},${a.width},${a.height}`)
    .sort()
    .join("+")
    .slice(0, 512);
}
export function nearestMonitorArea(
  point: MonitorPosition,
  displays: readonly MonitorDisplay[],
): Rectangle {
  let result: Rectangle | undefined;
  let closest = Infinity;
  for (const { workArea: area } of displays) {
    if (area.width <= 0 || area.height <= 0) continue;
    const dx = Math.max(area.x - point.x, 0, point.x - area.x - area.width);
    const dy = Math.max(area.y - point.y, 0, point.y - area.y - area.height);
    const distance = dx * dx + dy * dy;
    if (distance < closest) {
      closest = distance;
      result = area;
    }
  }
  if (!result) throw new Error("No available monitor display");
  return result;
}
export function clampMonitorPanel(
  bounds: Rectangle,
  displays: readonly MonitorDisplay[],
): Rectangle {
  const area = nearestMonitorArea(
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    displays,
  );
  const width = Math.min(Math.max(1, Math.round(bounds.width)), area.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), area.height);
  return {
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))),
    width,
    height,
  };
}

/** Agent Speed DESIGN2: a1.5S transparent viewport around a sizeS disc. */
export function placeMonitorOrb(
  position: MonitorPosition | undefined,
  size: number,
  displays: readonly MonitorDisplay[],
  index = 0,
): Rectangle {
  const primary = displays[0]?.workArea;
  if (!primary) throw new Error("No available monitor display");
  const desired = position ?? {
    x: primary.x + primary.width - EDGE_MARGIN - size * 1.25 - (index % 4) * (size + 12),
    y: primary.y + 50 + Math.floor(index / 4) * (size + 48),
  };
  const area = nearestMonitorArea(
    { x: desired.x + size * 0.75, y: desired.y + size * 0.75 },
    displays,
  );
  const x = Math.max(area.x - size * 0.25, Math.min(desired.x, area.x + area.width - size * 1.25));
  const y = Math.max(area.y - size * 0.25, Math.min(desired.y, area.y + area.height - size * 1.25));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.ceil(size * 1.5),
    height: Math.ceil(size * 1.5 + 32),
  };
}

export function snapMonitorOrb(
  bounds: Rectangle,
  size: number,
  displays: readonly MonitorDisplay[],
  neighbours: readonly OrbNeighbour[],
): Rectangle {
  const area = nearestMonitorArea(
    { x: bounds.x + size * 0.75, y: bounds.y + size * 0.75 },
    displays,
  );
  let x = bounds.x,
    y = bounds.y;
  const left = x + size * 0.25,
    right = x + size * 1.25;
  const top = y + size * 0.25,
    bottom = y + size * 1.25;
  if (Math.abs(left - area.x) <= SNAP_DISTANCE) x = area.x + EDGE_MARGIN - size * 0.25;
  else if (Math.abs(area.x + area.width - right) <= SNAP_DISTANCE)
    x = area.x + area.width - EDGE_MARGIN - size * 1.25;
  if (Math.abs(top - area.y) <= SNAP_DISTANCE) y = area.y + EDGE_MARGIN - size * 0.25;
  else if (Math.abs(area.y + area.height - bottom) <= SNAP_DISTANCE)
    y = area.y + area.height - EDGE_MARGIN - size * 1.25;
  let nearest = Infinity;
  for (const neighbour of neighbours) {
    const n = neighbour.bounds,
      s = neighbour.size;
    const cx = n.x + s * 0.75 - size * 0.75;
    const cy = n.y + s * 0.75 - size * 0.75;
    const positions = [
      { x: n.x + s * 1.25 + 12 - size * 0.25, y: cy },
      { x: n.x + s * 0.25 - 12 - size * 1.25, y: cy },
      { x: cx, y: n.y + s * 1.25 + 12 - size * 0.25 },
      { x: cx, y: n.y + s * 0.25 - 12 - size * 1.25 },
    ];
    for (const position of positions) {
      const dx = position.x - bounds.x,
        dy = position.y - bounds.y;
      const distance = dx * dx + dy * dy;
      if (Math.abs(dx) <= SNAP_DISTANCE && Math.abs(dy) <= SNAP_DISTANCE && distance < nearest) {
        nearest = distance;
        x = position.x;
        y = position.y;
      }
    }
  }
  return placeMonitorOrb({ x, y }, size, displays);
}

export function monitorNameplate(
  bounds: Rectangle,
  size: number,
  displays: readonly MonitorDisplay[],
  neighbours: readonly OrbNeighbour[],
): { placement: "above" | "below"; maxWidth: number } {
  const area = nearestMonitorArea(
    { x: bounds.x + size * 0.75, y: bounds.y + size * 0.75 },
    displays,
  );
  const font = Math.max(9, Math.min(12, Math.round(0.066 * size * 2) / 2));
  const height = Math.round(1.78 * font);
  const gap = Math.max(4, Math.min(7, Math.round(0.034 * size)));
  const centerX = bounds.x + size * 0.75;
  const belowFits = bounds.y + size * 1.25 + gap + height <= area.y + area.height - 3;
  let maxWidth = Math.min(
    size * 1.5,
    (centerX - area.x - 3) * 2,
    (area.x + area.width - 3 - centerX) * 2,
  );
  for (const { bounds: other, size: otherSize } of neighbours) {
    const otherX = other.x + otherSize * 0.75;
    const dy = Math.abs(other.y + otherSize * 0.75 - (bounds.y + size * 0.75));
    if (dy >= (size + otherSize) / 2) continue;
    const distance = Math.abs(otherX - centerX);
    if (distance > 0)
      maxWidth = Math.min(maxWidth, 2 * ((distance * size) / (size + otherSize) - 3));
  }
  return { placement: belowFits ? "below" : "above", maxWidth: Math.max(0, Math.floor(maxWidth)) };
}
