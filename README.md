# Visit tracker

A sideloaded Android app (Capacitor) for merchant field visits, synced with **FreeHub**,
FREE Madeira's Nostr CRM. It reads the **Merchants** table from the team relay, shows
each business's **visit heat** (days since the team's last visit), and publishes visits
and new merchants as FreeHub events. 

## How it fits FreeHub

- **Relay:** `wss://relay.freemadeira.org/private` (Haven private relay, NIP-42 AUTH +
  whitelist). The whitelist is the access control: no merchant data ships in the app.
- **Reads:** the project's Merchants CRM table (kind 30305), its records (30306), and
  `activity: visit` comments (1111) for heat. The table is recognised by its content: a
  Journey stage plus Latitude/Longitude fields, or a Location field on a merchant-named
  table. A slug starting with `merchant` is only a fallback.
- **Writes:** a visit comment on **Check in & save**, plus the record republished whole
  when the visit changes its Journey, follow-up flag or location; and a new record on
  **Add merchant**. These are the same shapes FreeHub produces.
- **Locations and FreeHub's map:** coordinates are read from the **Location** field first
  (FreeHub's `lat,lng` format), with Latitude/Longitude as a fallback. New merchants and
  locations filled in during a visit (**📍 Use my position here**, shown only when a
  merchant has none) are written to both. FreeHub's map pins only records with a Location
  value, so the Merchants table needs a Location field.
- **Signing:** Amber on the phone (NIP-55), with no relays involved in signing. NIP-07 /
  NIP-46 work in a browser.
- **Offline:** the last list is cached, and signed events wait in an outbox until a relay
  accepts them.

## Commands

```sh
pnpm install
pnpm dev           # browser version (NIP-07 / NIP-46)
pnpm apk           # build the APK and install it on the phone (USB or wireless adb)
pnpm sync          # pull work photos/videos (Pictures/FREE Madeira/) to data/field-sync/media
pnpm freehub-csv   # one-time: data/merchant_map.csv (+ FM24 sheet) → data/field-sync/freehub-merchants.csv for FreeHub's import
```

## Media

Photos and videos taken from a visit go to `Pictures/FREE Madeira/<date>_<merchant>/` on
the phone, their own album separate from the camera roll. FreeHub has no attachments yet,
so they come to the PC with `pnpm sync`.

## Local data

Real merchant data is never in this repo. The scripts read it from `data/` (gitignored), a
folder or a link to one, holding `merchant_map.csv`, the FM24 spreadsheet and
`field-sync/`.
