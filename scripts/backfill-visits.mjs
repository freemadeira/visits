// Backfill pre-FreeHub visits (data/field-sync/visits.csv) as kind-1111 activity=visit
// events on the team relay. One-off: the 2026-10-06 field round was CSV-only and never
// turned into FreeHub visit events, so the Visitas "Last visit" column shows them as
// never visited.
//
// Usage:
//   node scripts/backfill-visits.mjs                      # dry-run: prints matches
//   NSEC=nsec1... node scripts/backfill-visits.mjs --go   # sign + publish
//
// Signs with the given nsec (your merchant-support key). Only publishes rows that match
// a live FreeHub merchant by normalized name. Idempotent-ish: if you re-run, it writes
// new events at the same created_at — the relay dedupes on event id, which is derived
// from (pubkey, created_at, kind, tags, content), so identical events are rejected as
// duplicates. If any field changes, you get a second event. Review the dry-run first.
//
// What it writes per row (matches src/lib/freehub.ts visitTemplate):
//   kind: 1111
//   content: the CSV note
//   tags: A/K/P/a/k/p + ["activity","visit"]
//   created_at: that CSV date at 12:00 local time (so sort order per-day is stable)

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { Relay } from 'applesauce-relay';
import { lastValueFrom, timeout, toArray } from 'rxjs';

const CRM_RECORD_KIND = 30306;
const COMMENT_KIND = 1111;
const TEAM_RELAY = 'wss://relay.freemadeira.org/private';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = resolve(ROOT, 'data/field-sync/visits.csv');
const BACKUP_PATH = resolve(ROOT, 'data/field-sync/backup-2026-10-08_1349/freehub-events-all.jsonl');

const go = process.argv.includes('--go');

// ---- parse backup events ----

const events = readFileSync(BACKUP_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1];

// Live merchants: latest version per d, not deleted
const merchantsByD = new Map();
for (const e of events) {
  if (e.kind !== CRM_RECORD_KIND) continue;
  if (e.tags.some((t) => t[0] === 'deleted')) continue;
  const d = tag(e, 'd');
  const title = tag(e, 'title');
  if (!d || !title) continue;
  const prev = merchantsByD.get(d);
  if (!prev || e.created_at > prev.created_at) {
    merchantsByD.set(d, { d, title, author: e.pubkey, created_at: e.created_at });
  }
}

// Latest "deleted" wins over an older live record
const deletedD = new Set();
for (const e of events) {
  if (e.kind !== CRM_RECORD_KIND) continue;
  const d = tag(e, 'd');
  if (!d) continue;
  if (e.tags.some((t) => t[0] === 'deleted')) {
    const live = merchantsByD.get(d);
    if (live && e.created_at > live.created_at) deletedD.add(d);
  }
}
for (const d of deletedD) merchantsByD.delete(d);

const byName = new Map();
for (const m of merchantsByD.values()) {
  const k = norm(m.title);
  if (!byName.has(k)) byName.set(k, m);
}

// Existing visit activity: skip rows already covered
const existingVisits = new Set(); // merchant d tag
for (const e of events) {
  if (e.kind !== COMMENT_KIND) continue;
  if (tag(e, 'activity') !== 'visit') continue;
  const A = tag(e, 'A');
  if (!A) continue;
  const parts = A.split(':');
  if (parts.length >= 3) existingVisits.add(parts[2]);
}

// ---- parse CSV ----

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const n = text.length;
  const field = () => {
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { s += '"'; i += 2; }
          else { i++; return s; }
        } else { s += text[i++]; }
      }
      return s;
    }
    let s = '';
    while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') s += text[i++];
    return s;
  };
  while (i < n) {
    const row = [];
    while (true) {
      row.push(field());
      if (text[i] === ',') { i++; continue; }
      break;
    }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    rows.push(row);
  }
  const [header, ...data] = rows;
  return data.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));

// ---- match + build templates ----

const todo = [];
const skipped = [];
for (const r of csvRows) {
  const key = norm(r.merchant);
  const m = byName.get(key);
  if (!m) { skipped.push({ row: r, reason: 'no-match' }); continue; }
  if (existingVisits.has(m.d)) { skipped.push({ row: r, reason: 'already-has-visit', merchant: m }); continue; }
  // Noon local on the CSV date — stable, uncollides with 00:00 edge cases.
  const date = new Date(`${r.date}T12:00:00`);
  const created_at = Math.floor(date.getTime() / 1000);
  const address = `${CRM_RECORD_KIND}:${m.author}:${m.d}`;
  const template = {
    kind: COMMENT_KIND,
    created_at,
    content: r.note,
    tags: [
      ['A', address],
      ['K', String(CRM_RECORD_KIND)],
      ['P', m.author],
      ['a', address],
      ['k', String(CRM_RECORD_KIND)],
      ['p', m.author],
      ['activity', 'visit'],
    ],
  };
  todo.push({ row: r, merchant: m, template });
}

// ---- report ----

console.log(`Backup events: ${events.length}`);
console.log(`Live merchants: ${merchantsByD.size}`);
console.log(`CSV rows: ${csvRows.length}`);
console.log(`Matched & missing visit: ${todo.length}`);
console.log(`Skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  skip (${s.reason}): ${s.row.date} ${s.row.merchant}`);
console.log();
for (const t of todo) {
  console.log(`  ${t.row.date} → ${t.merchant.title}`);
  console.log(`    note: ${t.row.note.slice(0, 80)}${t.row.note.length > 80 ? '…' : ''}`);
}

if (!go) {
  console.log('\nDry run. Re-run with NSEC=nsec1... node scripts/backfill-visits.mjs --go');
  process.exit(0);
}

// ---- sign + publish ----

const nsec = process.env.NSEC;
if (!nsec) { console.error('\nERROR: set NSEC env var with the signer nsec.'); process.exit(1); }
const { type, data: sk } = nip19.decode(nsec);
if (type !== 'nsec') { console.error('NSEC must be an nsec1...'); process.exit(1); }
const pubkey = getPublicKey(sk);
console.log(`\nSigning as ${pubkey.slice(0, 12)}…`);

const relay = new Relay(TEAM_RELAY);

// Answer NIP-42 AUTH challenges by signing with this key.
relay.challenge$.subscribe((challenge) => {
  if (!challenge || relay.authenticatedAs === pubkey) return;
  const authSigner = {
    getPublicKey: async () => pubkey,
    signEvent: async (t) => finalizeEvent(t, sk),
  };
  relay.authenticate(authSigner).catch((e) => console.error('auth error:', e));
});

let ok = 0, fail = 0;
for (const { merchant, template } of todo) {
  const signed = finalizeEvent(template, sk);
  try {
    const res = await relay.publish(signed, { timeout: 15_000 });
    if (res.ok || (res.message ?? '').startsWith('duplicate:')) {
      console.log(`  ✓ ${merchant.title} (${res.message || 'accepted'})`);
      ok++;
    } else {
      console.log(`  ✗ ${merchant.title}: ${res.message || 'rejected'}`);
      fail++;
    }
  } catch (e) {
    console.log(`  ✗ ${merchant.title}: ${e?.message ?? e}`);
    fail++;
  }
}

console.log(`\nPublished ${ok}, failed ${fail}`);
relay.close();
