// Phone features: camera capture into the work folder, location, and handing off to a
// navigation app. Native (sideloaded APK) through the FieldMedia plugin; in a plain
// browser, capture is unavailable and navigation opens in a new tab.

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Merchant } from './freehub.ts';

interface FieldMediaPlugin {
  capture(o: { kind: 'photo' | 'video'; folder: string; filename: string }): Promise<{ saved: boolean; path?: string }>;
  openUrl(o: { url: string }): Promise<void>;
}

const FieldMedia = registerPlugin<FieldMediaPlugin>('FieldMedia');

export const isNative = () => Capacitor.isNativePlatform();

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'merchant';

/** Local time, sortable: 20261006-143005. */
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Opens the phone's camera app, saving into Pictures/FREE Madeira/<date>_<merchant>/. */
export async function capture(kind: 'photo' | 'video', merchant: Merchant, date: string): Promise<string | null> {
  const r = await FieldMedia.capture({
    kind,
    folder: `${date}_${slug(merchant.name)}`,
    filename: `${slug(merchant.name)}_${stamp()}`,
  });
  return r.saved && r.path ? r.path : null;
}

/** The phone's position; `accuracy` is the fix's radius in metres, when the device gives one. */
export function currentPosition(): Promise<{ lat: number; lon: number; accuracy?: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No location on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: Number(p.coords.latitude.toFixed(7)),
          lon: Number(p.coords.longitude.toFixed(7)),
          accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : undefined,
        }),
      (e) => reject(new Error(e.message || 'Location unavailable.')),
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  });
}

async function open(url: string) {
  if (isNative()) await FieldMedia.openUrl({ url });
  else window.open(url, '_blank', 'noopener');
}

const point = (m: Merchant) => `${m.lat},${m.lon}`;
const hasPoint = (m: Merchant) => m.lat !== null && m.lon !== null;

/**
 * One business: a geo: link, so Android offers Organic Maps, Google Maps or any other
 * navigation app. Without coordinates, search by name.
 */
export function navigateTo(m: Merchant) {
  const url = hasPoint(m)
    ? `geo:${point(m)}?q=${point(m)}(${encodeURIComponent(m.name)})`
    : `geo:0,0?q=${encodeURIComponent(`${m.name}, Madeira`)}`;
  return open(url);
}

/** The next place: the first picked business not yet visited today. */
export function nextStop(stops: Merchant[], visitedToday: (m: Merchant) => boolean): Merchant | undefined {
  return stops.find((m) => !visitedToday(m));
}
