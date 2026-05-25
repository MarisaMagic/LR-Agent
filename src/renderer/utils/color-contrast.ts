import type { CSSProperties } from 'react';

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  const n = parseInt(normalized, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

/** sRGB relative luminance (WCAG), ~0–1 */
function relativeLuminance(r: number, g: number, b: number): number {
  const transform = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [rs, gs, bs] = [r, g, b].map(transform);
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Pick black or white text for a solid hex background. */
export function getContrastTextColor(
  backgroundColor: string,
  light = '#ffffff',
  dark = '#000000',
): string {
  const rgb = parseHexColor(backgroundColor);
  if (!rgb) return light;
  return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.5 ? dark : light;
}

export function getLabelChipStyle(color: string): CSSProperties {
  return {
    backgroundColor: color,
    color: getContrastTextColor(color),
  };
}
