# spec — Visitas heat-map view (v1, simplest)

**Status:** settled — ready to build
**Captured:** 2026-10-13, from `/vibe-spec` brief by Zapa — "visitas app is missing a heat map, I need a visual map so I can see what areas I did vs what I need to visit, following my heat map prior idea". Mid-draft redirect: **"basically I'm looking for the simplest implementation atm"** and **"gray never visited (no field notes), then by colour as we keep visiting merchants"**.
**So that:** the operator opens Visitas, flips to Map, and sees at a glance which merchants have been visited (coloured by recency) vs. untouched (gray).
**Part of:** `data/build-order.md` #5 (originally a FreeHub-side "weather map"; this spec moves the scope into Visitas as a minimal v1 so it ships without waiting on FreeHub).
**Needs .keys:** no

## The problem, confirmed

Visitas already carries every signal a map would need, but presents them only as a sortable column:

- `apps/visits/src/components/Tracker.tsx:43–47` — `heat(ts)` picks a `HEAT` band from days-since-last-visit, with `HEAT_NEVER` for merchants never visited. Local to Tracker.
- `apps/visits/src/lib/freehub.ts:303–309` — `FreeHubData.lastVisit: Map<string, number>` populated from kind-1111 events tagged `activity=visit`, newest per merchant.
- `apps/visits/src/lib/freehub.ts:286–300` — every merchant with a valid Location has `lat`/`lon`. `validLocation` (198–202) is the gate.
- `apps/visits/src/config.ts:28–34` — `HEAT` bands (green ≤7d, yellow ≤14d, orange ≤30d, red >30d) and `HEAT_NEVER` red "never".
- No map view exists; coverage can only be read by sorting the list and knowing the geography by heart.

Row #5 of `data/build-order.md` (status `not written`) is the originating idea; it was scoped to FreeHub. This spec builds the simplest version inside Visitas so it ships now; FreeHub can still add its own view later. Row #10 (archived `spec-visitas-map-location.md`) is the dependency: Location field migration is already done.

## What exists to reuse

- **`HEAT` + `HEAT_NEVER` + `heat()`** — the colour function. `heat()` lives inside `Tracker.tsx`; v1 may inline it in the map too or extract it. Extracting is cleaner and one-file (see DECIDE AT BUILD).
- **`FreeHubData.lastVisit`** — the same `Map<merchantId, unixTime>` powers map colours; no new fetch.
- **`Merchant.lat`/`lon` + `validLocation`** — pin positions; a `null` lat/lon merchant is skipped.
- **`VisitSheet`** (`src/components/VisitSheet.tsx`) — a pin tap opens the same sheet a row tap opens today, with the same props. No new sheet.
- **Tracker shell** — the sync bar and filter chips stay above both views; only the body switches. The existing HEAT legend row stays above the **list** only (part of the "list is perfect as-is" decision); the Map view renders its own small legend (see What to build #6).

## What to build

Tagged `REAL` throughout; no `.keys`.

1. **View toggle** — a two-state Map/List control in Tracker, directly above the table-wrap. Persisted in the same `useTrackerState` the radius already uses, so a reload restores the chosen view. Default: **List**. — `REAL`
2. **`MapView` component** (`src/components/MapView.tsx`) — props: `{ merchants, lastVisit, onOpenMerchant: (i: number) => void }`. Pure view. — `REAL`
3. **Pin layer** — one small filled-circle pin per merchant with a valid Location:
   - `lastVisit` present → HEAT-coloured per `heat(ts)`.
   - `lastVisit` absent → **gray `#9e9e9e`** (via the new `MAP_NO_VISIT` constant in `src/config.ts`). The list's `HEAT_NEVER` red is unchanged — gray is a map-only concept.
   - A tap on a pin calls `onOpenMerchant(i)`, which opens `VisitSheet` for that merchant — same path as a row tap in the list. — `REAL`
4. **Initial viewport** — bounding box of all mapped merchants, with a small pad; if zero mapped merchants, centre on Funchal at a fixed zoom. Both constants named in `config.ts` so they are not magic. — `REAL`
5. **Attribution** — "© OpenStreetMap contributors" on the map, non-dismissable (OSM tile policy). — `REAL`
6. **Map legend** — the Map view renders its own small legend inside/below the map (not touching the list's existing legend row): the four HEAT bands + a gray swatch labelled "no visit yet". The list view's legend and column colours are unchanged — the list is perfect as-is. — `REAL`

Explicitly **not** in v1:

- No radius ring on the map.
- No area blobs / zoom aggregation.
- No clustering library.
- No urgent-flag outlines on pins.
- No tile cache beyond the browser's default.

Data flow: `useFreeHub` → `FreeHubData` → `Tracker` already has everything. `Tracker` passes `{ merchants, lastVisit, onOpenMerchant: (i) => setOpen(i) }` to `MapView`. `MapView` renders. No new fetch, no new state, no new relay subscription.

## Leaves room for

- **Radius ring + area blobs + zoom aggregation** — a v2. The seam is `MapView`'s prop shape: it already receives `merchants`, `lastVisit` and an open-merchant callback. v2 adds `anchors` and `radiusKm` props without changing the ones v1 defines. — points at `data/build-order.md` #5.
- **FreeHub's own map view** — the HEAT reading function and HEAT bands are the shared contract. FreeHub later can read the same visit activity events and apply the same bands. — points at `data/build-order.md` #5.
- **Offline tile caching / bundled PMTiles** — out of scope; tiles can go blank offline, pins still render on cached data. — points at a possible follow-on spec.

## What this does NOT cover

- **No trip planning on the map.** Selecting pins, drawing routes — stays in the list's `goNext` flow.
- **No "map-only" merchants.** Merchants without a Location don't appear. Add-from-map is out.
- **No clustering library.** Pins just overlap at Funchal zoom; v2 handles it.
- **No FreeHub UI changes.** This spec stays inside `freemadeira/visits`.
- **No heatmap gradient tile** (Leaflet.heat-style blob overlay). HEAT-coloured pins are the signal.
- **No historical heat animation / time slider.** `lastVisit` holds only the newest per merchant.
- **No iOS/PWA build changes.** `data/build-order.md` #9 is untouched.

## Open questions

### BLOCKING

1. **~~Gray "no visit yet" — exact hex.~~** _Settled 2026-10-13:_ gray lives **only on the map**; the list view is unchanged. Hex: **`#9e9e9e`**. The map legend labels this swatch "no visit yet". A new `MAP_NO_VISIT = '#9e9e9e'` constant goes in `src/config.ts` next to `HEAT`/`HEAT_NEVER` so the map and its legend read from one place.
2. **~~Map library.~~** _Settled 2026-10-13:_ **`leaflet` + `react-leaflet`**. Install: `pnpm add leaflet react-leaflet` and `pnpm add -D @types/leaflet`. Import Leaflet's CSS once at the Visitas entry (`src/main.tsx` or `src/App.tsx`) — Leaflet needs it or the map renders broken. The build must stay green on Vite 8 / React 19 (current package.json versions).
3. **~~Dark basemap approach.~~** _Settled 2026-10-13:_ **standard light OSM tiles**, accept the inconsistency with the app's dark-first default. Tile URL: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`. Attribution: `© OpenStreetMap contributors`. HEAT pin colours (and the `#9e9e9e` gray) must stay legible on the light basemap — v1 ships against this constraint without further compensation.

### DECIDE AT BUILD

- **Extract `heat()` to a shared module** vs. inline a copy in `MapView`. Lean: extract to `src/lib/field.ts` (where time helpers already live — grep for `localDate`, `today` — and update Tracker.tsx's single call site). Decide by whether the extraction stays a 1-call-site rename or starts touching other files; if it does, inline for v1.
- **Pin size** — lean: a 12–14px filled circle with a thin dark border. Decide by eyeballing on the Android build; bump to 18px if HEAT bands are hard to tell apart on a bright day.
- **Toggle control style** — lean: a two-button segmented control styled like `.chip` (matches `Tracker.tsx:269` chip style). Decide by looking at the existing chip and sync-bar buttons.
- **"N of M on map" readout** — lean: append to the existing `.muted small` line in `Tracker.tsx:257–259` (`${mapped} of ${merchants.length} on map`). Decide by whether that line's already crowded on a phone screen.

### LATER

- Radius ring on the map (v2).
- Area blobs + zoom aggregation (v2).
- Trip planning on the map (`data/build-order.md` #6).
- Offline tile cache / bundled PMTiles.
- iOS PWA (`data/build-order.md` #9).

## Test plan

Unit tests:

- `heat(undefined) === HEAT_NEVER`.
- `heat(now - 1*day)` is the ≤7d band.
- `heat(now - 10*day)` is the ≤14d band.
- `heat(now - 100*day)` is the >30d band.

Build:

- `pnpm build` and `pnpm lint` green.

Live check on real device (per [[device-testing-by-zapa]]):

- `pnpm apk`, install, open Visitas.
- Toggle List → Map: the same merchants are present (within the "has Location" caveat).
- A never-visited merchant pins **gray**; recently visited pins green; older ones yellow/orange/red per HEAT bands.
- Tapping a pin opens the same `VisitSheet` a row tap would. Saving a visit from the pin tap, back on Map, re-colours the pin on next refresh.
- Light OSM basemap renders; HEAT pin colours and the `#9e9e9e` gray are all distinguishable from each other and from the basemap at normal zoom.
- Kill network, reload: the map opens from cache, pins render; tiles may be blank (expected).

Shipping (external `freemadeira/visits` repo):

- Branch off `main`, commit identity `190519253+zapabug@users.noreply.github.com` (per [[freemadeira-commit-identity]]).
- Push to fork, open PR against `freemadeira/visits`.
- STATUS.md touched only with one new line per [[status-light-planning-carries-story]].

## References

- `apps/visits/src/components/Tracker.tsx` — list view, local `heat()`, HEAT legend render.
- `apps/visits/src/config.ts` — `HEAT`, `HEAT_NEVER`.
- `apps/visits/src/lib/freehub.ts` — `Merchant`, `FreeHubData.lastVisit`, `validLocation`.
- `apps/visits/src/components/VisitSheet.tsx` — what a pin tap opens.
- `apps/visits/data/build-order.md` row #5 (originating idea), row #10 (archived Location spec).
- `madfree/archive/spec-visitas-map-location.md` — the Location-field migration this depends on.
- `madfree/CLAUDE.md` — external repo editing rules, fork→PR, dark-theme default, no-mock rule.
- `Homebase/CLAUDE.md` — no-mock-data rule, device-testing convention.
