# build-approach — spec-visitas-heat-map

**Branch:** `feature/heat-map` off `main` in the external `freemadeira/visits` clone.
**Spec:** [`spec-visitas-heat-map.md`](spec-visitas-heat-map.md)
**Status:** in progress — building the v1 "simplest" shape.

## Rail Zapa set mid-build (2026-10-13)

**"Make sure we are only making changes by adding a map view — the rest of Visitas (list, legend, controls) stays as-is."**

This refines the spec's "list is perfect as-is" into a stricter diff-shape rule: anything that would touch the list's render or its behaviour is out, even when the spec's "What exists to reuse" section implied a shared file (e.g. a shared `heat()`). The map imports what it needs from its own new modules; nothing inside the list branch is edited beyond what the Map/List toggle switch mechanically requires (one `{view === 'map' ? <MapView /> : <existing-table-jsx /> }` wrap above the current table-wrap — the table JSX itself unchanged line-for-line).

## Built vs. spec

(filled in as slices land)

- [x] **Slice 1a — `src/lib/heat.ts`.** New pure helper, 4 lines; the exact function that lives in `Tracker.tsx` today, re-exposed as a module so `MapView` can import without pulling in Tracker's component tree. Per the rail, `Tracker.tsx`'s own local `heat()` is **not** swapped for the import — the list's code stays untouched.
- [x] **Slice 1b — `src/config.ts` additions.** Three new named exports appended at the bottom of the file; no existing export edited:
    - `MAP_NO_VISIT = { color: '#9e9e9e', label: 'no visit yet' }` — the gray swatch.
    - `MAP_FALLBACK_CENTER = [32.6471, -16.9080]` — central Funchal, used only when no mapped merchants exist.
    - `MAP_FALLBACK_ZOOM = 13` — matches the spec's "fixed zoom" note.

## Decisions made to keep flow

Each is a `[ ]` for Zapa to accept or redirect:

- [ ] **Decision 1 — `heat()` extracted to a new `src/lib/heat.ts` (not `src/lib/field.ts`), AND Tracker.tsx's local `heat()` kept.** Spec's DECIDE-AT-BUILD leaned toward extracting to `field.ts` and updating Tracker's call site. In the real repo, `field.ts` is camera / navigation / Capacitor code — a pure HEAT helper doesn't belong there. New standalone `src/lib/heat.ts` is cleaner. **The spec's second half of that lean (update Tracker's single call site) was dropped on Zapa's "list stays as-is" rail** — the list's own local copy of the function stays. Two 4-line copies of the same function exist; one for the list, one for the map's helper. Cheap price for an untouched list.
- [ ] **Decision 2 — `MAP_FALLBACK_CENTER` set to `[32.6471, -16.9080]` (central Funchal, Sé area).** Spec says "centre on Funchal at a fixed zoom"; it didn't name the coordinate. Picked a point near Praça do Município so it reads as Funchal rather than any specific merchant.
- [ ] **Decision 3 — Toggle shape in Tracker: `{view === 'map' ? <MapView /> : <existing table block, unindented, unedited />}` above `.table-wrap`.** Minimal-diff variant: the current table JSX is not re-indented or line-edited; it just becomes one branch of a conditional. Satisfies the "list stays as-is" rail.

## Open questions

(none right now; all current ones are in the spec's DECIDE-AT-BUILD / LATER, not here)

## Done

- `src/lib/heat.ts` added.
- `src/config.ts` extended with `MAP_NO_VISIT`, `MAP_FALLBACK_CENTER`, `MAP_FALLBACK_ZOOM`.
- Working branch: `feature/heat-map`.

## TODO (this build)

- Install `leaflet`, `react-leaflet`, `@types/leaflet`.
- Add `import 'leaflet/dist/leaflet.css'` to `src/main.tsx`.
- Extend `TrackerState` in `src/lib/state.ts` with `view: 'map' | 'list'`, default `'list'`.
- `src/components/MapView.tsx` — new component (pins + own small legend + attribution).
- `src/components/Tracker.tsx` — one minimal wrap above `.table-wrap` to swap Map vs. the existing table.
- `pnpm build` and `pnpm lint` green.
- APK via `pnpm apk`.
- Hand to Zapa for device testing (per [[device-testing-by-zapa]]).

## TODO (not this build — graduates into another spec if revived)

- v2 radius ring, area blobs, zoom aggregation (spec's LATER).
- Trip planning on the map.
- Offline tile cache / bundled PMTiles.
- iOS PWA.
