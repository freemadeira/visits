// What stays on this phone only: urgent flags (a planning aid) and the "nearby" radius.
// Merchants, visits and heat live in FreeHub.

import { useCallback, useState } from 'react';
import { DEFAULT_RADIUS_KM } from '../config.ts';

export interface TrackerState {
  /** merchant id → palette index. */
  urgent: Record<string, number>;
  radiusKm: number;
}

const lsKey = (pubkey: string) => `visit-tracker.state.${pubkey}`;
const empty = (): TrackerState => ({ urgent: {}, radiusKm: DEFAULT_RADIUS_KM });

type Raw = Partial<TrackerState>;

function readRaw(pubkey: string): Raw {
  try {
    const raw = localStorage.getItem(lsKey(pubkey));
    return raw ? (JSON.parse(raw) as Raw) : {};
  } catch {
    return {};
  }
}

export function useTrackerState(pubkey: string) {
  const [state, setState] = useState<TrackerState>(() => {
    const raw = readRaw(pubkey);
    return { ...empty(), urgent: raw.urgent ?? {}, radiusKm: raw.radiusKm ?? DEFAULT_RADIUS_KM };
  });
  const [saveFailed, setSaveFailed] = useState(false);

  const update = useCallback(
    (fn: (s: TrackerState) => TrackerState) => {
      const next = fn(state);
      setState(next);
      try {
        localStorage.setItem(lsKey(pubkey), JSON.stringify(next));
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    },
    [pubkey, state],
  );
  return { state, update, saveFailed };
}

/** Today in the device's local time zone, as YYYY-MM-DD. */
export function today(): string {
  return localDate(Date.now() / 1000);
}

export function localDate(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Flag with the least-used palette colour (lowest index on ties), or unflag. */
export function toggleUrgent(s: TrackerState, key: string, paletteSize: number): TrackerState {
  const urgent = { ...s.urgent };
  if (key in urgent) {
    delete urgent[key];
  } else {
    const uses = Array.from({ length: paletteSize }, (_, i) => Object.values(urgent).filter((c) => c === i).length);
    urgent[key] = uses.indexOf(Math.min(...uses));
  }
  return { ...s, urgent };
}
