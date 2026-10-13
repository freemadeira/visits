// How "hot" a merchant is right now — days since last visit mapped to a HEAT band, with
// HEAT_NEVER as the "no visit yet" fallback. Shared by the list column and the map view.

import { HEAT, HEAT_NEVER } from '../config.ts';

export function heat(ts: number | undefined) {
  if (!ts) return HEAT_NEVER;
  const days = (Date.now() / 1000 - ts) / 86400;
  return HEAT.find((h) => days <= h.maxDays) ?? HEAT_NEVER;
}
