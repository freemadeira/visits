import type { Merchant } from './freehub.ts';

/** Great-circle distance in km. */
export function distanceKm(a: Merchant, b: Merchant): number {
  // A merchant without a location (added in the field) is never "nearby".
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export interface Highlight {
  /** Palette index of the urgent business this row belongs to. */
  color: number;
  /** The urgent business itself (true) or a neighbour within the radius (false). */
  urgent: boolean;
  /** For neighbours: which urgent business, and how far. */
  near?: { name: string; km: number };
}

/**
 * Colour every row: urgent rows get their own colour; any other row within
 * `radiusKm` of an urgent one takes the colour of the NEAREST urgent one.
 */
export function highlights(
  merchants: Merchant[],
  keyOf: (m: Merchant) => string,
  urgent: Record<string, number>,
  radiusKm: number,
): Map<number, Highlight> {
  const out = new Map<number, Highlight>();
  const flagged = merchants
    .map((m, i) => ({ m, i, color: urgent[keyOf(m)] }))
    .filter((x) => x.color !== undefined);

  for (const f of flagged) out.set(f.i, { color: f.color, urgent: true });

  merchants.forEach((m, i) => {
    if (out.has(i)) return;
    let best: { f: (typeof flagged)[number]; km: number } | null = null;
    for (const f of flagged) {
      const km = distanceKm(m, f.m);
      if (km <= radiusKm && (!best || km < best.km)) best = { f, km };
    }
    if (best) out.set(i, { color: best.f.color, urgent: false, near: { name: best.f.m.name, km: best.km } });
  });
  return out;
}
