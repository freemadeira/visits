"""One-time: build the CSV for FreeHub's own import (Merchants table → Import CSV).

merchant_map.csv gives the list, areas, coordinates, OSM links and Journey; the FM24
spreadsheet (the master with contacts) adds contact person, email, phone, website,
address, payment setup and the rest, joined by business name (exact, then close match).
FreeHub matches columns to fields by name and creates missing select options itself.

Mapping (settled with Zapa 2026-10-06):
  name → Business · area → Area · lat/lon → Location ("lat,lon", 6 decimals) · osm_link → OSM link
  status → Journey: dropped / not-accepting → Not interested; field-added → Lead;
           anything else → Accepting bitcoin
  On BTC Map: btcmap-only / fm24+btcmap, or FM24 "BTCmaps" = Yes
  FM24: Contact Name → Contact person · Contact Email (else Business Email) → Email
        Contact Phone (else Business Phone) → Phone · Website · Address → Address
        PoS → Payment setup · plus extra columns with no FreeHub field yet (Hours, …)
  data/field-sync/visits.csv (visits logged before FreeHub sync) → Field Notes, one
  "YYYY-MM-DD: note" line per visit, matched by OSM link or name

Output: data/field-sync/freehub-merchants.csv (gitignored — real personal data), and
public/unlisted.json: the FM24 businesses that aren't in merchant_map.csv, by name only
(no contacts), which the app shows as "not in FreeHub" (gitignored, bundled into the APK).
Prints counts only, never contact details.
  pnpm freehub-csv
"""

import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
# Real merchant data never lives in this repo: `data/` is a gitignored folder (or a link to
# one) holding merchant_map.csv, the FM24 spreadsheet and field-sync/.
DATA = ROOT / "data"
MAP = DATA / "merchant_map.csv"
FM24 = DATA / "FM24 _ Merchants List.xlsx"
OUT = DATA / "field-sync" / "freehub-merchants.csv"
VISITS = DATA / "field-sync" / "visits.csv"  # notes from the pre-FreeHub app (pnpm sync)


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def words(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    stop = {"the", "de", "da", "do", "a", "o", "e", "and", "madeira", "funchal"}
    return {w for w in re.split(r"[^a-z0-9]+", s) if len(w) > 2 and w not in stop}


def cell(v):
    return "" if v is None else str(v).strip()


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


for p in (MAP, FM24):
    if not p.exists():
        fail(f"missing {p}")

merchants = list(csv.DictReader(MAP.open(encoding="utf-8-sig")))
ws = openpyxl.load_workbook(FM24, read_only=True, data_only=True).worksheets[0]
rows = list(ws.iter_rows(values_only=True))
header = [cell(h) for h in rows[0]]
col = {h: i for i, h in enumerate(header) if h}
need = ["Company / Business", "Contact Name", "Contact Email", "Contact Phone", "Address", "Website", "PoS"]
missing = [h for h in need if h not in col]
if missing:
    fail(f"FM24 sheet is missing column(s): {', '.join(missing)}")
fm24 = [r for r in rows[1:] if any(c not in (None, "") for c in r)]


def get(r, name):
    i = col.get(name)
    return cell(r[i]) if i is not None and i < len(r) else ""


by_name = {}
for r in fm24:
    by_name.setdefault(norm(get(r, "Company / Business")), r)


GENERIC = {norm(w) for w in ("restaurante", "restaurant", "cafe", "bar", "loja", "shop", "farmacia", "pharmacy", "hotel")}


def match(name):
    """Exact (normalised) name, else one name containing the other, else word overlap."""
    n = norm(name)
    if n in by_name:
        return by_name[n], "exact"
    for key, r in by_name.items():
        if key in GENERIC or n in GENERIC:
            continue  # a bare "Restaurante" must not match "<Some name> Restaurante"
        if len(key) >= 5 and len(n) >= 5 and (key in n or n in key):
            return r, "close"
    w = words(name)
    best, score = None, 0.0
    for r in fm24:
        o = words(get(r, "Company / Business"))
        if w and o:
            j = len(w & o) / len(w | o)
            if j > score:
                best, score = r, j
    return (best, "close") if score >= 0.6 else (None, "")


def journey(status):
    return {"dropped": "Not interested", "not-accepting": "Not interested", "field-added": "Lead"}.get(status, "Accepting bitcoin")


EXTRA = [  # FM24 columns with no FreeHub field yet: add a field with this name to keep one
    ("Hours", "Horario"),
    ("Business email", "Business Email"),
    ("Business phone", "Business Phone"),
    ("Onchain", "Onchain"),
    ("Lightning", "Lightning"),
    ("NFC", "NFC"),
    ("Settles in", "BTC / EUR"),
    ("Welcome email", "Welcome Email"),
    ("App updated", "App Updated"),
    ("Active (FM24)", "Active"),
]
# Corrections from Zapa's own field visits, newer than both source files. Kept outside the
# code (field-sync/ is gitignored — they're field notes about real businesses):
#   {"<Business name>": {"<column>": "<value>", …}, …}
OVERRIDES_FILE = DATA / "field-sync" / "overrides.json"
OVERRIDES = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8")) if OVERRIDES_FILE.exists() else {}

def location(lat, lon):
    """FreeHub's Location value: "lat,lon" to 6 decimals, or empty if either is missing."""
    try:
        return f"{float(lat):.6f},{float(lon):.6f}"
    except ValueError:
        return ""


COLUMNS = ["Business", "Area", "Location", "OSM link", "Journey", "On BTC Map",
           "Contact person", "Email", "Phone", "Website", "Address", "Payment setup", "Field Notes", "Needs follow-up"] + [n for n, _ in EXTRA]

# Field notes from the pre-FreeHub app, keyed the way that app keyed visits (OSM link, else name).
notes = {}
if VISITS.exists():
    for v in csv.DictReader(VISITS.open(encoding="utf-8")):
        if v.get("note", "").strip():
            notes.setdefault(v["key"], []).append(f"{v['date']}: {v['note'].strip()}")

out, used, counts = [], set(), {"exact": 0, "close": 0, "": 0}
for m in merchants:
    status = m["status"].strip()
    r, how = match(m["name"])
    counts[how] += 1
    if r is not None:
        used.add(id(r))
    f = (lambda name: get(r, name)) if r is not None else (lambda name: "")
    pos = f("PoS")
    row = {
        "Business": m["name"].strip(),
        "Area": m["area"].strip(),
        "Location": location(m["lat"], m["lon"]),
        "OSM link": m["osm_link"].strip(),
        "Journey": journey(status),
        "On BTC Map": "yes" if status in ("btcmap-only", "fm24+btcmap") or f("BTCmaps").lower() == "yes" else "",
        "Contact person": f("Contact Name"),
        "Email": f("Contact Email") or f("Business Email"),
        "Phone": f("Contact Phone") or f("Business Phone"),
        "Website": f("Website"),
        "Address": f("Address"),
        "Payment setup": "" if pos.lower() in ("", "dropped", "n/a") else pos,
        "Needs follow-up": "",
        "Field Notes": "\n".join(notes.pop(m["osm_link"].strip() or m["name"].strip(), [])),
    }
    for name, src in EXTRA:
        v = f(src)
        row[name] = "" if v.upper() == "N/A" else v
    row.update(OVERRIDES.get(row["Business"], {}))
    out.append(row)

unmatched = [r for r in fm24 if id(r) not in used]
OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=COLUMNS)
    w.writeheader()
    w.writerows(out)

UNLISTED = ROOT / "public" / "unlisted.json"
names = sorted({get(r, "Company / Business") for r in unmatched if norm(get(r, "Company / Business")) not in GENERIC})
UNLISTED.parent.mkdir(parents=True, exist_ok=True)
UNLISTED.write_text(json.dumps(names, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

print(f"{len(out)} merchants → field-sync/freehub-merchants.csv")
print(f"{len(names)} unlisted names → public/unlisted.json (shown in the app, not imported)")
print(f"  FM24 details joined: {counts['exact']} exact name, {counts['close']} close name, {counts['']} none")
print(f"  field notes attached: {sum(1 for r in out if r['Field Notes'])} merchants; unmatched notes: {sum(len(v) for v in notes.values())}")
print(f"  FM24 rows not in merchant_map (left out): {len(unmatched)}")
for r in unmatched:
    print(f"    - {get(r, 'Company / Business')}  [Active: {get(r, 'Active') or '—'}]")
