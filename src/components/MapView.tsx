// Visitas heat map (v1, simplest). READ-ONLY: a merchant pins at its FreeHub Location,
// coloured by the same HEAT bands the list column uses — green ≤7d, yellow ≤14d, orange
// ≤30d, red after that; gray for merchants with no activity yet. All editing stays on the
// list (tap a row there to check in).
//
// Colour is driven by `lastTouch` (newest visit OR note), not `lastVisit`. Reason: a
// pre-wipe round logged visits as notes, and the wipe left many merchants without any
// visit event even though they'd been visited. `lastTouch` picks up those notes so the
// map shows them coloured rather than gray. The list keeps the stricter `lastVisit`.

import { useEffect, useMemo, useRef, useState } from 'react';
import L, { type CircleMarkerOptions, type LatLngBoundsExpression, type LatLngTuple, type Map as LeafletMap } from 'leaflet';
import { MapContainer, TileLayer, CircleMarker, Circle, Marker, Tooltip, useMap } from 'react-leaflet';
import { HEAT, HEAT_NEVER, MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM, MAP_NO_VISIT, PALETTE } from '../config.ts';
import type { Merchant } from '../lib/freehub.ts';
import { watchMyPosition, type Position } from '../lib/field.ts';
import { heat } from '../lib/heat.ts';

interface Props {
  merchants: Merchant[];
  /** Merchant id → unix seconds of the newest activity on it (visit OR note). */
  lastTouch: Map<string, number>;
  /** Merchant ids the user has selected in the list — the trip's anchors. These pin
   *  larger so the trip's shape reads at a glance. */
  selectedIds: Set<string>;
  /** Merchant id → PALETTE index of its urgent cluster. These pin as a `!` symbol in the
   *  urgent cluster's PALETTE colour, overriding the HEAT disc entirely — the signal is
   *  "needs attention", not "recency". */
  urgentById: Map<string, number>;
}

interface Pin {
  i: number;
  m: Merchant;
  pos: LatLngTuple;
  color: string;
  label: string;
  selected: boolean;
  /** PALETTE index of the urgent cluster, or undefined if not urgent. */
  urgent: number | undefined;
}

const PIN_RADIUS = 7; // ~14px disc, bumped from the spec's 12–14 lean for finger targets.
const PIN_RADIUS_SELECTED = 10; // ~20px disc for list-selected merchants (the trip anchors).
const PIN_STYLE: CircleMarkerOptions = { weight: 1, color: '#222', fillOpacity: 0.95 };
// Selected (non-urgent): same HEAT fill colour, brighter — thick white outline makes
// the fill read as lighter without changing hue. Replaces the earlier radius-ring idea.
const PIN_STYLE_SELECTED: CircleMarkerOptions = { weight: 3, color: '#ffffff', fillOpacity: 1 };

/** A `!` glyph icon for urgent-flagged merchants. Colour = the urgent cluster's PALETTE
 *  colour; size bumps when the merchant is also selected in the list (trip anchor). */
function urgentIcon(color: string, selected: boolean) {
  const size = selected ? 28 : 22;
  const font = selected ? 22 : 16;
  return L.divIcon({
    className: 'urgent-pin',
    html: `<span style="color:${color};font-size:${font}px;line-height:${size}px;font-weight:900;text-shadow:0 0 2px #000, 0 0 3px #000;">!</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// "You are here" dot: smaller than a merchant pin (radius 7 / 10 selected) so it reads
// as context, not a pin. Blue is the web convention for own-position.
const ME_RADIUS = 5;
const ME_STYLE: CircleMarkerOptions = { color: '#ffffff', weight: 2, fillColor: '#2962ff', fillOpacity: 1 };
// Translucent accuracy ring; muted enough not to compete with merchants.
const ME_ACCURACY_STYLE: CircleMarkerOptions = { color: '#2962ff', weight: 1, fillColor: '#2962ff', fillOpacity: 0.08 };

function MyLocation({ pos }: { pos: Position | null }) {
  if (!pos) return null;
  const latlng: LatLngTuple = [pos.lat, pos.lon];
  return (
    <>
      {pos.accuracy !== undefined && pos.accuracy > 0 && (
        <Circle center={latlng} radius={pos.accuracy} pathOptions={ME_ACCURACY_STYLE} />
      )}
      <CircleMarker center={latlng} radius={ME_RADIUS} pathOptions={ME_STYLE}>
        <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>You are here</Tooltip>
      </CircleMarker>
    </>
  );
}

/** Captures the map instance so the "📍 Me" button (which lives outside the map DOM so
 *  it floats as a UI control) can call setView. */
function CaptureMap({ mapRef }: { mapRef: React.MutableRefObject<LeafletMap | null> }) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
    return () => {
      mapRef.current = null;
    };
  }, [map, mapRef]);
  return null;
}

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

export default function MapView({ merchants, lastTouch, selectedIds, urgentById }: Props) {
  // "You are here" — streams while the Map view is mounted. Stops on unmount (view
  // switched back to List, or sheet opened over the map). KISS: no toggle, no settings.
  const [myPos, setMyPos] = useState<Position | null>(null);
  useEffect(() => watchMyPosition(setMyPos), []);
  const mapRef = useRef<LeafletMap | null>(null);

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
            selected: selectedIds.has(m.id),
            urgent: urgentById.get(m.id),
          };
        }),
    [merchants, lastTouch, selectedIds, urgentById],
  );

  const mapped = pins.length;
  const total = merchants.length;

  // Items in the map's own legend: the four HEAT bands (deduped by label, as Tracker's
  // legend already does) plus the gray "no visit yet" swatch at the end.
  const legend = [...HEAT, HEAT_NEVER, MAP_NO_VISIT].filter(
    (h, i, a) => a.findIndex((x) => x.label === h.label) === i,
  );

  const recentreMe = () => {
    if (!myPos || !mapRef.current) return;
    mapRef.current.setView([myPos.lat, myPos.lon], Math.max(mapRef.current.getZoom(), 16));
  };

  return (
    <div className="map-wrap">
      <button
        type="button"
        className="map-me small"
        aria-label="Centre on my position"
        disabled={!myPos}
        onClick={recentreMe}
      >
        📍 Me
      </button>
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
        <CaptureMap mapRef={mapRef} />
        <MyLocation pos={myPos} />
        {pins.map((p) =>
          p.urgent !== undefined ? (
            <Marker
              key={p.m.id}
              position={p.pos}
              icon={urgentIcon(PALETTE[p.urgent % PALETTE.length], p.selected)}
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
                {p.m.name} · urgent · {p.label}
              </Tooltip>
            </Marker>
          ) : (
            <CircleMarker
              key={p.m.id}
              center={p.pos}
              radius={p.selected ? PIN_RADIUS_SELECTED : PIN_RADIUS}
              pathOptions={
                p.selected
                  ? { ...PIN_STYLE_SELECTED, fillColor: p.color }
                  : { ...PIN_STYLE, fillColor: p.color }
              }
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
                {p.m.name} · {p.label}
              </Tooltip>
            </CircleMarker>
          ),
        )}
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
