// Visitas heat map (v1, simplest). A merchant pins at its FreeHub Location, coloured by
// the same HEAT bands the list column uses — green ≤7d, yellow ≤14d, orange ≤30d, red
// after that; gray for merchants with no visit yet (map-only — the list keeps red). A tap
// on a pin opens the same VisitSheet a row tap opens in the list.

import { useEffect, useMemo } from 'react';
import type { CircleMarkerOptions, LatLngBoundsExpression, LatLngTuple } from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { HEAT, HEAT_NEVER, MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM, MAP_NO_VISIT } from '../config.ts';
import type { Merchant } from '../lib/freehub.ts';
import { heat } from '../lib/heat.ts';

interface Props {
  merchants: Merchant[];
  /** Merchant id → unix seconds of its newest visit. */
  lastVisit: Map<string, number>;
  /** The merchant's position in the `merchants` array. Same contract Tracker uses. */
  onOpenMerchant: (i: number) => void;
}

interface Pin {
  i: number;
  m: Merchant;
  pos: LatLngTuple;
  color: string;
  label: string;
}

const PIN_RADIUS = 7; // ~14px disc, bumped from the spec's 12–14 lean for finger targets.
const PIN_STYLE: CircleMarkerOptions = { weight: 1, color: '#222', fillOpacity: 0.95 };

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

export default function MapView({ merchants, lastVisit, onOpenMerchant }: Props) {
  const pins: Pin[] = useMemo(
    () =>
      merchants
        .map((m, i) => ({ i, m }))
        .filter(({ m }) => m.lat !== null && m.lon !== null)
        .map(({ i, m }) => {
          const ts = lastVisit.get(m.id);
          const band = ts ? heat(ts) : MAP_NO_VISIT;
          return { i, m, pos: [m.lat as number, m.lon as number] as LatLngTuple, color: band.color, label: band.label };
        }),
    [merchants, lastVisit],
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
            radius={PIN_RADIUS}
            pathOptions={{ ...PIN_STYLE, fillColor: p.color }}
            eventHandlers={{ click: () => onOpenMerchant(p.i) }}
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
