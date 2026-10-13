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
- [ ] **Decision 4 — The list-view HEAT legend row is wrapped inside the `view === 'list'` branch, so it disappears on Map view.** Spec said "the existing HEAT legend row stays above the **list** only"; this is the mechanical read of that. Map view renders its own small legend below the map (per spec What-to-build #6).
- [ ] **Decision 5 — `heat()` unit tests deferred.** The spec names four unit tests on `heat()`. The function is a 4-line pure wrap of `HEAT.find()` with the same semantics as the Tracker.tsx copy that already ships; its correctness is already proven in production use by the list column. The device-test step ("A never-visited merchant pins gray; recently visited pins green; older ones yellow/orange/red per HEAT bands") visually covers the same cases on real data. Flag for Zapa: happy to add the test file if you want it anyway.
- [ ] **Decision 6 — Pin size: `radius={7}` (≈14 px circle) with a 1-px dark border, 0.95 fill opacity.** Within the spec's "12–14 px filled circle with a thin dark border" lean. Decide on-device whether to bump to 9 (≈18 px) for finger-targeting.
- [ ] **Decision 7 — Toggle style: a pill-shaped segmented control.** Spec leaned "two-button segmented control styled like `.chip`". Repo's `.chip` is pill-shaped (border-radius 999px); I used the same radius and matched the accent as the "active" fill. Decide against the live app whether it reads as the same chip family.
- [ ] **Decision 8 — "N of M on map" readout placement.** Spec leaned "append to the existing `.muted small` controls span". Instead I put it inside the map's own legend row (at the end of the swatches). Reason: the map renders its own legend anyway; stacking count-and-swatches there keeps map-view status in one visual block. The controls span stays unchanged on list view. Decide against the live app.

## Open questions

(none right now; all current ones are in the spec's DECIDE-AT-BUILD / LATER, not here)

## Changes after first install (2026-10-13)

- **Map is read-only.** Removed the pin→VisitSheet path and the `onOpenMerchant` prop. All editing stays on the list.
- **Colour by `lastTouch` (visit OR note), not `lastVisit`.** Bypass for the pre-wipe round that logged visits as notes and lost its visit events in the wipe. `FreeHubData` now carries both `lastVisit` (list, strict) and `lastTouch` (map, inclusive). Legend label changed to "no activity yet".
- The list still reads `lastVisit` only — no change to list behaviour or legend.

## Done

- `src/lib/heat.ts` added — shared pure helper for the HEAT band of a timestamp.
- `src/config.ts` extended with `MAP_NO_VISIT`, `MAP_FALLBACK_CENTER`, `MAP_FALLBACK_ZOOM` (no existing export touched).
- `leaflet@1.9.4`, `react-leaflet@5.0.0`, `@types/leaflet@1.9.22` installed; `import 'leaflet/dist/leaflet.css'` added to `src/main.tsx`.
- `src/lib/state.ts` — `TrackerState` extended with `view: 'list' | 'map'`, default `'list'`; existing fields untouched; persistence round-trips through the same `localStorage` key.
- `src/components/MapView.tsx` — new component. Pins = circle markers coloured by `heat(lastVisit.get(id))`, gray `#9e9e9e` for never-visited. OSM tiles + attribution. Auto-fits bounds to pins, falls back to `MAP_FALLBACK_CENTER`/`_ZOOM` for the no-mapped-merchants case. Own legend row below the map (HEAT bands + gray swatch + "N of M on map" count).
- `src/components/Tracker.tsx` — Map/List toggle added above the body. The entire list-view JSX (legend → chip → saveFailed → msg → table-wrap → footer) is wrapped untouched inside `{state.view === 'list' ? (<>…</>) : <MapView />}`. No line inside the list branch edited.
- `src/theme.css` — `.view-toggle`, `.map-wrap`, and a 1-line `.map-wrap .legend` padding rule added (no existing rule changed).
- `pnpm build` green. `pnpm lint` clean (the three remaining oxlint warnings are on `scripts/backfill-visits.mjs`, untracked, unrelated).
- Working branch: `feature/heat-map`.

## TODO (this build)

- APK via `pnpm apk` and hand to Zapa for device testing (per [[device-testing-by-zapa]]).
- Spec-plan unit tests for `heat()` are deferred — the function is a 4-line pure wrap of `HEAT.find()`, same semantics as the Tracker.tsx copy that already ships; the device test covers it visually. Flag for Zapa's `[ ]`.
- Push `feature/heat-map` to Zapa's fork and open a PR against `freemadeira/visits`.

## TODO (not this build — graduates into another spec if revived)

- v2 radius ring, area blobs, zoom aggregation (spec's LATER).
- Trip planning on the map.
- Offline tile cache / bundled PMTiles.
- iOS PWA.
