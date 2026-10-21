# spec — Visitas as an installable iOS web app (PWA)

**Status:** built — unverified (device testing pending, see Test plan)
**Captured:** 2026-10-20, from Zapa: "visitas as a webapp for ios compatibility." Clarified in
conversation: ship as a **hosted PWA**, not a native iOS Capacitor target (no Mac/Apple Developer
account needed). Host **nsite for now**; the eventual home is likely a `freemadeira.org` subdomain,
which needs its own spec to the tech team (DNS + hosting are their call, not this repo's — see
[[freemadeira-tech-decisions]]).
**So that:** a FREE Madeira volunteer on an iPhone can open a link, add Visitas to their home
screen, log in with a Nostr signer, and do field visits — without Android/Amber or a native app
build.
**Part of:** no local `build-order.md` exists in this clone of `apps/visits` to anchor a row number
to (see "Note on build-order" below) — `spec-visitas-heat-map.md` references row #9 "iOS PWA" from
what must be the external `freemadeira/visits` repo's own planning doc, not something present here.
**Needs `.keys`:** no.

## Note on build-order

This spec was drafted from the local `madfree` clone of `apps/visits`, which has no
`build-order.md` on disk (only `data/field-sync/` exists under `data/`). `spec-visitas-heat-map.md`
cites row numbers (#5, #6, #9, #10) as if such a file exists — it may live only in the external
`freemadeira/visits` working copy this clone doesn't carry, or may never have been committed. Before
building, check `freemadeira/visits` directly for `build-order.md` and reconcile this spec's slot
into it; don't invent a row number here.

## The problem, confirmed

Visitas is a Vite + React + Capacitor app (`apps/visits/`). The exact same web bundle (`dist/`) runs
two ways today:

- **Android, sideloaded APK** (`pnpm apk`) — native Capacitor wrapper, `capacitor.config.json`
  (`appId: org.freemadeira.visittracker`).
- **Plain browser** (`pnpm dev` / `pnpm preview`) — already used for desktop testing today.

There is **no iOS build and no hosted deployment** — the only way to run Visitas today is
`pnpm dev`/`pnpm apk` from a checkout. An iPhone user has no way to open it at all.

The good news, confirmed by reading the code: the app's device-specific logic already branches
cleanly on `Capacitor.isNativePlatform()` and degrades to plain Web APIs, so **this is substantially
a packaging/hosting problem, not a rewrite**:

- **Signing** (`src/lib/signer.ts`) — already supports NIP-07 (browser extension), NIP-46
  (`bunker://` paste or `nostrconnect://` to any remote signer app), and NIP-55 (Amber, gated behind
  `Capacitor.isNativePlatform()` and an install check, so it silently doesn't appear in a browser).
  **No new signer code needed.** iOS has no NIP-55 equivalent (Amber is Android-only, intent-based) —
  the iOS path is NIP-46 to any remote signer app (`bunker://` or `nostrconnect://`), which already
  works in `Login.tsx` today. Spec this generically as "any NIP-46 signer app," not a named product —
  which apps support it will change over time.
- **Geolocation** (`src/lib/field.ts:51-81`, `currentPosition`/`watchMyPosition`) — plain
  `navigator.geolocation`, no Capacitor plugin. Works in iOS Safari/PWA as-is, with the caveats
  below.
- **Navigation handoff** (`field.ts:91-108`) — already falls back to `window.open` (new tab) when
  not native. Works on iOS as-is.
- **Backup export** (`field.ts:119-128`) — already falls back to a browser download when not native.
  Works on iOS as-is (downloads go to the Files app).
- **Camera/photo capture** (`field.ts:34-41`, via the native `FieldMedia` plugin) — **native-only**,
  no fallback exists. This is the one real functional gap; see "Live upload" below.

## What to build

Tagged `REAL` throughout; no `.keys`.

1. **Web app manifest** (`public/manifest.webmanifest` + `<link rel="manifest">` in `index.html`) —
   `name`/`short_name: "Visitas"`, `display: "standalone"`, `theme_color`/`background_color`
   matching `theme.css`'s dark palette (per Homebase's dark-default convention), and an icon set
   covering iOS's home-screen sizes (at minimum 180×180 `apple-touch-icon`, plus standard
   192/512 PWA sizes). — `REAL`
2. **iOS-specific meta tags** in `index.html` — `apple-mobile-web-app-capable`,
   `apple-mobile-web-app-status-bar-style`, and the `apple-touch-icon` link. iOS does not read
   `manifest.webmanifest` for install metadata the way Android/Chrome does; these tags are what
   actually control the home-screen icon/name/status-bar look on iOS. — `REAL`
3. **No install-prompt code.** iOS Safari has no `beforeinstallprompt` API — there is no
   programmatic "Add to Home Screen" button possible. Add a one-time, dismissable in-app hint (shown
   only when `navigator.standalone` is `false` and the UA looks like iOS Safari) telling the user to
   use the Share sheet → "Add to Home Screen" manually. — `REAL`
4. **Build + deploy pipeline to nsite** — `pnpm build` already produces `dist/`; add a `pnpm deploy`
   script following the same `nsyte deploy dist` pattern already used by
   `merchant-support/merchant-guide/nsite` (see that project's `package.json` for the exact
   invocation). Needs its own nsite identity (separate from the merchant-guide one) — decide at
   build whether that's a fresh `.keys`-staged key or an existing one Zapa already holds. — `REAL`
5. **`vite.config.ts` `base` path check** — confirm the build's asset paths work when served from
   nsite's URL shape (likely root-relative already works; verify, don't assume, since nsite serving
   differs from a plain static host). — `REAL`
6. **Geolocation permission UX pass** — iOS Safari's permission prompt and its PWA-backgrounding
   behavior for `watchPosition` differ from Android. At minimum: verify `watchMyPosition`'s existing
   `onError` path (`field.ts:70-81`) surfaces a clear message when iOS denies or throttles location,
   rather than silently going stale. No code structure change expected — this is a verification +
   copy pass. — `REAL`

## Live-upload photo capture (replaces native folder capture on iOS)

Zapa's direction: rather than patch around the missing native camera folder on iOS, use this as the
occasion to give Visitas a **live upload** path that FreeHub doesn't have today (the README notes
"FreeHub has no attachments yet, so they come to the PC with `pnpm sync`" — i.e. the current flow is
already upload-shaped, just batched and manual). This is a bigger design question than the rest of
this spec and should be split out:

- **This spec (iOS PWA) ships without in-app photo capture for v1**, same gap as any non-native
  browser has today — explicitly scoped out, not silently dropped.
- **A follow-up spec** should cover: `<input type="file" capture="environment">` for the live
  take-or-pick-photo UI (works in iOS Safari, no plugin needed), an upload target (most likely a
  Blossom server, Nostr's standard media-upload protocol — nothing like this exists in FreeHub or
  Visitas yet, confirmed by search), and how an uploaded media URL attaches to a visit record
  (new tag on the kind-1111 visit comment? a FreeHub-side schema change?). This touches FreeHub's
  data model, not just Visitas, so it needs sign-off from whoever owns FreeHub's event shapes before
  being specced in full.
- Flag to Zapa: worth a `/vibe-therapist` or direct scoping pass before `/vibe-spec` writes it, since
  "live upload" is a FreeHub-wide capability, not a Visitas-only tweak.

## What this does NOT cover

- **No native iOS Capacitor target / App Store build.** Explicitly ruled out in favor of a hosted
  PWA (no Mac/Apple Developer account required).
- **No in-app photo capture on iOS for v1** — see "Live-upload photo capture" above; follow-up spec.
- **No `freemadeira.org` subdomain / DNS work.** Hosting on nsite is the v1 target; moving it under
  `freemadeira.org` is the tech team's infra call and needs its own spec handed to them (per
  [[freemadeira-tech-decisions]] — Zapa owns Nostr calls, tech team owns stack/hosting).
- **No offline tile caching** for the heat-map's Leaflet view (already out of scope per
  `spec-visitas-heat-map.md`) — unaffected by this spec.
- **No change to the Android APK build or Amber signing path.**
- **No service-worker-based offline shell** beyond what's needed for installability — true offline
  support (queueing writes while offline) already exists at the app-data layer per the README
  ("signed events wait in an outbox until a relay accepts them") and is unchanged here.

## Open questions

### BLOCKING

1. ~~**nsite identity for Visitas's deploy.**~~ _Settled 2026-10-20:_ a fresh throwaway
   `.keys` nsec was generated for Visitas, separate from `merchant-guide/nsite`'s. Still
   subject to the same `.keys` endgame as any other project key — replace with a bunker
   connection and delete `.keys` before this is production infrastructure, not a dev
   deploy. **Carry this as a `.keys` blocker in `STATUS.md` for as long as the file
   exists**, per Homebase's `.keys` convention.
2. ~~**Icon source.**~~ _Settled 2026-10-20:_ reused the existing Android launcher icon
   (`android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`, 192×192, already a
   composited standalone icon) rather than sourcing a new one. Resized to 180/192/512 via
   Pillow into `public/icons/`. Upscaling 192→512 holds up fine given the icon's flat
   geometric style — re-check visually if that ever changes.

### DECIDE AT BUILD

- **Manifest `theme_color`/`background_color` exact values** — pull from `theme.css`'s existing dark
  palette rather than inventing new ones.
- ~~**Whether `vite.config.ts` needs an explicit `base`.**~~ _Settled 2026-10-20:_ no —
  root-relative paths work fine on nsite as built; `vite.config.ts` unchanged.

### LATER

- Live-upload photo capture + Blossom attachment design (separate spec, FreeHub-coupled).
- `freemadeira.org` subdomain hosting (tech team's spec, not this repo's).
- True install-prompt parity is impossible on iOS (platform limitation, not a gap to close).

## Done

- `public/manifest.webmanifest` — name/icons/`display: standalone`/dark theme colour
  (`#121212`, matching `theme.css`'s `--bg`).
- `index.html` — manifest link, `theme-color`, and iOS-specific meta tags
  (`apple-mobile-web-app-capable`, `-status-bar-style`, `-title`, `apple-touch-icon`).
- `public/icons/icon-{180,192,512}.png` — generated from the existing Android launcher
  icon via Pillow.
- `src/lib/installHint.ts` + `src/components/Login.tsx` — a dismissable "Add to Home
  Screen" hint shown only on iOS Safari, not yet installed (`navigator.standalone`
  false). No native install-prompt API exists on iOS, so this is manual-only by design.
- `scripts/deploy.mjs` + `pnpm deploy` — builds then runs `nsyte deploy dist --sec
  <nsec from .keys>`, keeping the key out of shell history and committed config.
- `.nsite/config.json` — Visitas's own nsite project config (title/relays/servers),
  mirroring `merchant-guide/nsite`'s shape.
- `.keys` — fresh throwaway nsec/npub for Visitas's nsite identity (see BLOCKING #1).
- `scripts/pub-nsite-meta.mjs` — works around a confirmed nsyte bug: `nsyte deploy`
  never actually publishes the kind 10002/10063 discovery metadata a gateway needs to
  find the site, regardless of its `--publish-*` flags, so the site 404s on
  `nsite.run` until this runs once after every deploy. Full root cause:
  `research-and-development/nsyte-deploy-discovery-metadata.md`; cross-project
  snippet: `snippets/nsyte-deploy-missing-relay-server-list-404.md`.
- `pnpm build` and `pnpm lint` green (no new warnings beyond pre-existing, unrelated
  ones in `scripts/backfill-visits.mjs`).
- **Deployed and verified live** 2026-10-20:
  `https://npub1t2rwwmevweyznvn8f4mjg5nvqamc2tkfqm255yn68zefcgqrh33s9rpn6g.nsite.run/`
  (prefer `.run` over `.lol` — see the snippet above). `nsyte debug` confirms kind
  10002/10063/0 and the site manifest are all present; both gateways return 200.

## TODO (not yet done)

- Device testing on a real iPhone (see Test plan below) — nothing in this spec has been
  opened on actual iOS hardware yet, only verified via `pnpm build`/`nsyte debug`/`curl`.
- `freemadeira/visits` is the external repo of record; these changes exist only in this
  `madfree/apps/visits` clone so far — not yet branched/pushed/PR'd there.

## Test plan

Build:

- `pnpm build` and `pnpm lint` green, unchanged from today.
- Manifest validates (installable checklist: name, icons, start_url, display all present).

Live check on a real iPhone (per [[device-testing-by-zapa]] — Zapa tests on-device, not a simulator):

- Open the nsite URL in Safari; "Add to Home Screen" via the Share sheet produces a Visitas icon and
  launches standalone (no Safari chrome).
- Log in via a NIP-46 signer app (`nostrconnect://` or pasted `bunker://`) — confirm the existing
  `Login.tsx` flow works unmodified on iOS.
- Grant location; confirm `currentPosition`/`watchMyPosition` report a fix and that denial produces
  a clear on-screen message, not a silent stall.
- Confirm the heat-map view (`spec-visitas-heat-map.md`) renders and pin taps open `VisitSheet`.
- Confirm backup export (`saveBackup`) triggers an iOS download into Files, since the native path
  doesn't apply.
- Kill network, reload: app opens from cache (same offline expectation as Android).

Shipping (external `freemadeira/visits` repo):

- Branch off `main`, commit identity `190519253+zapabug@users.noreply.github.com` (per
  [[freemadeira-commit-identity]]).
- Push to fork, open PR against `freemadeira/visits`.
- STATUS.md touched only with one new line per [[status-light-planning-carries-story]].

## References

- `apps/visits/src/lib/signer.ts` — existing NIP-07/NIP-46/NIP-55 signer paths; no changes needed.
- `apps/visits/src/components/Login.tsx` — login UI; already hides the Amber button when
  `hasAndroidSigner()` is false.
- `apps/visits/src/lib/field.ts` — camera/geolocation/navigation/export; already branches on
  `Capacitor.isNativePlatform()` with working non-native fallbacks except camera capture.
- `apps/visits/capacitor.config.json` — current Android-only Capacitor config, unaffected.
- `apps/visits/README.md` — FreeHub integration, "no attachments yet" note that motivates the
  live-upload follow-up.
- `merchant-support/merchant-guide/nsite/` — existing nsite deploy precedent (`pnpm deploy`, nsyte).
- `madfree/CLAUDE.md` — external repo editing rules, fork→PR, dark-theme default, no-mock rule.
- `Homebase/CLAUDE.md` — `.keys` policy, device-testing convention.
