// Visitas heat map (v1, simplest). READ-ONLY: a merchant pins at its FreeHub Location,
// coloured by the same HEAT bands the list column uses — green ≤7d, yellow ≤14d, orange
// ≤30d, red after that; gray for merchants with no activity yet. All editing stays on the
// list (tap a row there to check in).
//
// Colour is driven by `lastTouch` (newest visit OR note), not `lastVisit`. Reason: a
// pre-wipe round logged visits as notes, and the wipe left many merchants without any
// visit event even though they'd been visited. `lastTouch` picks up those notes so the
// map shows them coloured rather than gray. The list keeps the stricter `lastVisit`.

import { useEffect, useMemo } from 'react';
import type { CircleMarkerOptions, LatLngBoundsExpression, LatLngTuple } from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { HEAT, HEAT_NEVER, MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM, MAP_NO_VISIT } from '../config.ts';
import type { Merchant } from '../lib/freehub.ts';
import { heat } from '../lib/heat.ts';

interface Props {
  merchants: Merchant[];
  /** Merchant id → unix seconds of the newest activity on it (visit OR note). */
  lastTouch: Map<string, number>;
  /** Merchant ids the user has checked (urgent-flagged) in the list — pop them. */
  urgentIds: Set<string>;
}

interface Pin {
  i: number;
  m: Merchant;
  pos: LatLngTuple;
  color: string;
  label: string;
  urgent: boolean;
}

const PIN_RADIUS = 7; // ~14px disc, bumped from the spec's 12–14 lean for finger targets.
const PIN_RADIUS_URGENT = 10; // ~20px disc for checked merchants; same HEAT fill, louder presence.
const PIN_STYLE: CircleMarkerOptions = { weight: 1, color: '#222', fillOpacity: 0.95 };
const PIN_STYLE_URGENT: CircleMarkerOptions = { weight: 3, color: '#ffffff', fillOpacity: 1 };

/** Zoom/pan to fit the pins once per data change; falls back to Funchal on an empty set. */
function FitToPins({ pins }: { pins: Pin[] }) {
  const map = useMap();
  useEffect(() => {
    if (pins.length === 0) {
      map.setView(MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM);
      return;
    }
    if (pins.length === 1) {
      map.setView(pins[0].pos, 16);
      return;
    }
    const bounds: LatLngBoundsExpression = pins.map((p) => p.pos);
    map.fitBounds(bounds, { padding: [24, 24] });
  }, [map, pins]);
  return null;
}

export default function MapView({ merchants, lastTouch, urgentIds }: Props) {
  const pins: Pin[] = useMemo(
    () =>
      merchants
        .map((m, i) => ({ i, m }))
        .filter(({ m }) => m.lat !== null && m.lon !== null)
        .map(({ i, m }) => {
          const ts = lastTouch.get(m.id);
          const band = ts ? heat(ts) : MAP_NO_VISIT;
          return {
            i,
            m,
            pos: [m.lat as number, m.lon as number] as LatLngTuple,
            color: band.color,
            label: band.label,
            urgent: urgentIds.has(m.id),
          };
        }),
    [merchants, lastTouch, urgentIds],
  );

  const mapped = pins.length;
  const total = merchants.length;

  // Items in the map's own legend: the four HEAT bands (deduped by label, as Tracker's
  // legend already does) plus the gray "no visit yet" swatch at the end.
  const legend = [...HEAT, HEAT_NEVER, MAP_NO_VISIT].filter(
    (h, i, a) => a.findIndex((x) => x.label === h.label) === i,
  );

  return (
    <div className="map-wrap">
      <MapContainer
        center={MAP_FALLBACK_CENTER}
        zoom={MAP_FALLBACK_ZOOM}
        scrollWheelZoom
        style={{ height: '60vh', width: '100%', borderRadius: 8 }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitToPins pins={pins} />
        {pins.map((p) => (
          <CircleMarker
            key={p.m.id}
            center={p.pos}
            radius={p.urgent ? PIN_RADIUS_URGENT : PIN_RADIUS}
            pathOptions={
              p.urgent
                ? { ...PIN_STYLE_URGENT, fillColor: p.color }
                : { ...PIN_STYLE, fillColor: p.color }
            }
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
              {p.m.name} · {p.label}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>

      <div className="legend small" aria-label="Map legend">
        {legend.map((h) => (
          <span key={h.label}>
            <span className="dot" style={{ background: h.color }} /> {h.label}
          </span>
        ))}
        <span className="muted">· {mapped} of {total} on map</span>
      </div>
    </div>
  );
}
