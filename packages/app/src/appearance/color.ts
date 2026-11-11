export function setCssColorAlpha(color: string, alpha: number): string {
  const boundedAlpha = Math.max(0, Math.min(1, alpha));
  const normalizedColor = color.trim();
  // Unistyles web styles carry live CSS variables rather than resolved RGB.
  // Relative color syntax replaces their alpha without losing theme updates.
  if (normalizedColor.startsWith("var(")) {
    return `rgb(from ${normalizedColor} r g b / ${boundedAlpha})`;
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(normalizedColor);
  if (hex) {
    const value = hex[1];
    return `rgba(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(value.slice(2, 4), 16)}, ${Number.parseInt(value.slice(4, 6), 16)}, ${boundedAlpha})`;
  }

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(
    normalizedColor,
  );
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${boundedAlpha})`;
  }

  return color;
}
