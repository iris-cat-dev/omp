import type { PetPosition, PetSize } from "./types.js";

export interface PetBounds extends PetPosition {
  width: number;
  height: number;
}
export interface WorkArea extends PetBounds {}

export const PET_SPRITE_SIZE: Record<PetSize, number> = { small: 112, medium: 152, large: 200 };

export function petWindowSize(size: PetSize): { width: number; height: number } {
  return { width: PET_SPRITE_SIZE[size] + 108, height: PET_SPRITE_SIZE[size] + 76 };
}

export function clampPetBounds(
  position: PetPosition | null,
  size: PetSize,
  areas: readonly WorkArea[],
): PetBounds {
  if (!areas.length) throw new Error("No available display work area for desktop pet");
  const dimensions = petWindowSize(size);
  const primary = areas[0];
  const desired = position ?? {
    x: primary.x + primary.width - dimensions.width - 24,
    y: primary.y + primary.height - dimensions.height - 24,
  };
  let best: PetBounds | null = null;
  let nearest = Infinity;
  for (const area of areas) {
    const width = Math.min(dimensions.width, area.width);
    const height = Math.min(dimensions.height, area.height);
    const x = Math.round(Math.max(area.x, Math.min(desired.x, area.x + area.width - width)));
    const y = Math.round(Math.max(area.y, Math.min(desired.y, area.y + area.height - height)));
    const distance = (x - desired.x) ** 2 + (y - desired.y) ** 2;
    if (distance < nearest) {
      nearest = distance;
      best = { x, y, width, height };
    }
  }
  return best!;
}
