// FreeHub's CRM, read and written exactly the way FreeHub does it
// (github.com/freemadeira/freehub: src/lib/crm.ts, model.ts, project.ts, relays.ts).
// The app only touches one CRM table — the project's Merchants table — plus the
// "visit" activities on its records. Events are plain signed Nostr events on the team
// relays; the relays' whitelist + NIP-42 AUTH is the access control.

import { Relay } from 'applesauce-relay';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { lastValueFrom, toArray, timeout } from 'rxjs';
import { MERCHANTS_SLUG, TEAM_RELAYS } from '../config.ts';
import type { Signer } from './signer.ts';

export const PROJECT_KIND = 30304;
export const CRM_TABLE_KIND = 30305;
export const CRM_RECORD_KIND = 30306;
export const COMMENT_KIND = 1111;

// ---------------------------------------------------------------- parsing

const tagValue = (e: NostrEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const isPubkey = (s: string | undefined): s is string => !!s && /^[0-9a-f]{64}$/.test(s);
const isDeleted = (e: NostrEvent) => e.tags.some(([n]) => n === 'deleted');
const integer = (s: string | undefined) => {
  const n = Number(s);
  return s !== undefined && Number.isInteger(n) ? n : undefined;
};
export const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** FreeHub's tie-break: newer created_at wins; on a tie, the lower id. */
const newer = (a: NostrEvent, b: NostrEvent) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

/** Newest version per `d` tag across the given authors (FreeHub `latestVersions`). */
function latestVersions(events: NostrEvent[], kind: number, authors: Set<string>): Map<string, NostrEvent> {
  const latest = new Map<string, NostrEvent>();
  for (const e of events) {
    const d = tagValue(e, 'd');
    if (e.kind !== kind || !d || !authors.has(e.pubkey)) continue;
    const current = latest.get(d);
    if (!current || newer(e, current)) latest.set(d, e);
  }
  return latest;
}

export interface Project {
  address: string;
  title: string;
  /** Can write: their versions of tables and records count. */
  members: string[];
  /** Read-only (FreeHub's `["p", pubkey, "", "viewer"]`): they see everything, and FreeHub ignores what they publish. */
  viewers: string[];
}

const VIEWER = 'viewer';
export const VIEW_ONLY = 'View only: this npub can read this project but not write to it.';

function parseProject(e: NostrEvent): Project {
  const d = tagValue(e, 'd') ?? '';
  const members = new Set([e.pubkey]);
  const viewers = new Set<string>();
  for (const [name, pubkey, , role] of e.tags) {
    if (name === 'p' && isPubkey(pubkey)) (role === VIEWER ? viewers : members).add(pubkey);
  }
  return {
    address: `${PROJECT_KIND}:${e.pubkey}:${d}`,
    title: tagValue(e, 'title') ?? 'Untitled',
    members: [...members],
    viewers: [...viewers].filter((v) => !members.has(v)),
  };
}

export interface Option {
  id: string;
  label: string;
}
export interface Field {
  id: string;
  type: string;
  name: string;
  options: Option[];
}
export interface Table {
  id: string;
  address: string;
  project: string;
  slug: string;
  title: string;
  fields: Field[];
  updatedAt: number;
  /** The version this was read from: an upgrade republishes its tags, adding only what's missing. */
  event: NostrEvent;
}

function parseTable(e: NostrEvent): Table {
  const d = tagValue(e, 'd') ?? '';
  const creator = [tagValue(e, 'creator')].find(isPubkey) ?? e.pubkey;
  const fields: Field[] = [];
  for (const [name, id, type, label] of e.tags) {
    if (name === 'field' && id && type && !fields.some((f) => f.id === id)) {
      fields.push({ id, type, name: label?.trim() || 'Untitled', options: [] });
    }
  }
  for (const [name, fieldId, id, label] of e.tags) {
    const field = fields.find((f) => f.id === fieldId);
    if (name === 'option' && field && id && !field.options.some((o) => o.id === id)) {
      field.options.push({ id, label: label?.trim() || 'Untitled' });
    }
  }
  return {
    id: d,
    address: `${CRM_TABLE_KIND}:${creator}:${d}`,
    project: e.tags.find((t) => t[0] === 'a' && t[1]?.startsWith(`${PROJECT_KIND}:`))?.[1] ?? '',
    slug: tagValue(e, 'slug') ?? '',
    title: tagValue(e, 'title') ?? '',
    fields,
    updatedAt: e.created_at,
    event: e,
  };
}

export interface CrmRecord {
  id: string;
  /** Author of the winning version — activities point at this author's address. */
  author: string;
  title: string;
  rank: number;
  createdAt: number;
  creator?: string;
  values: Record<string, string[]>;
  moves: { stage: string; at: number; by?: string }[];
  /** created_at of the winning version (an edit must be newer). */
  updatedAt: number;
}

function parseRecord(e: NostrEvent): CrmRecord {
  const values: Record<string, string[]> = {};
  const moves: CrmRecord['moves'] = [];
  for (const [name, a, b, c] of e.tags) {
    if (name === 'val' && a && b) (values[a] ??= []).push(b);
    else if (name === 'moved' && a && integer(b) !== undefined) moves.push({ stage: a, at: integer(b)!, by: isPubkey(c) ? c : undefined });
  }
  return {
    id: tagValue(e, 'd') ?? '',
    author: e.pubkey,
    title: tagValue(e, 'title') ?? '',
    rank: Number(tagValue(e, 'rank')) || 0,
    createdAt: integer(tagValue(e, 'created')) ?? e.created_at,
    creator: [tagValue(e, 'creator')].find(isPubkey),
    values,
    moves: moves.sort((x, y) => x.at - y.at),
    updatedAt: e.created_at,
  };
}

const tableIdOf = (e: NostrEvent) =>
  e.tags.find((t) => t[0] === 'a' && t[1]?.startsWith(`${CRM_TABLE_KIND}:`))?.[1]?.split(':')[2];

// ---------------------------------------------------------------- merchants

/** A Merchants record as the app shows it. */
export interface Merchant {
  /** The record's `d` tag — stable across versions and members. */
  id: string;
  author: string;
  name: string;
  area: string;
  /** Journey stage label (e.g. "Accepting bitcoin"). */
  status: string;
  /** Journey stage option id. */
  journeyId: string;
  /** The "Needs follow-up" checkbox is ticked. */
  needsFollowUp: boolean;
  /** Journey is Closed (the business no longer exists) or Not interested: out of the day-to-day list (hidden by default). */
  closed: boolean;
  /** An FM24 business not in FreeHub yet (names only); checking in adds it. */
  unlisted?: boolean;
  osm: string;
  lat: number | null;
  lon: number | null;
  rank: number;
  /** Raw Field Notes longtext value (empty string if blank). Shown read-only in VisitSheet. */
  fieldNotes: string;
}

/** The Merchants table's fields the app reads/writes, found by name (ids are random per table). */
export interface MerchantFields {
  area?: Field;
  /** FreeHub's Location field (type `location`): the coordinates, and what its map pins. */
  location?: Field;
  /** Where a Relocated business moved to, pinned in the field; FreeHub's BTC Map sync moves the OSM listing there. */
  newLocation?: Field;
  osm?: Field;
  journey?: Field;
  owner?: Field;
  acceptingSince?: Field;
  followUp?: Field;
  /**
   * A free-form notes field on the record itself (longtext). The 2026-10-08 relay restore
   * dropped historical visit notes into this field prefixed with the visit date, e.g.
   * "2026-10-06: Had a coffee paid in bitcoin\n2026-09-20: Checked in". Read-only in
   * Visitas today; shown in VisitSheet so operators see earlier notes, and used by
   * `lastTouch` so a merchant with a note counts as touched.
   */
  fieldNotes?: Field;
}

export function merchantFields(table: Table): MerchantFields {
  const by = (name: string, type?: string) =>
    table.fields.find((f) => norm(f.name) === norm(name) && (!type || f.type === type));
  return {
    area: by('Area'),
    // By name first: "New location" is a location field too.
    location: by('Location', 'location') ?? table.fields.find((f) => f.type === 'location' && norm(f.name) !== norm(NEW_LOCATION)),
    newLocation: by(NEW_LOCATION, 'location'),
    osm: by('OSM link'),
    journey: table.fields.find((f) => f.type === 'stage'),
    owner: by('Owner', 'member'),
    acceptingSince: by('Accepting since', 'date'),
    followUp: by('Needs follow-up', 'checkbox'),
    fieldNotes: by('Field Notes', 'longtext'),
  };
}

/**
 * Pulls a touch-timestamp out of a Field Notes value. The restore wrote lines like
 * `2026-10-06: Had a coffee paid in bitcoin`; the latest date among the lines wins.
 * Returns null if the value is empty or has no parsable leading date on any line.
 */
export function fieldNotesTouchedAt(value: string | undefined): number | null {
  if (!value) return null;
  let best = 0;
  for (const line of parseFieldNotesLines(value)) {
    if (line.unix > best) best = line.unix;
  }
  return best || null;
}

export interface FieldNotesLine {
  /** Unix seconds at noon on the date. */
  unix: number;
  /** The YYYY-MM-DD date, as it appeared. */
  date: string;
  /** Whatever came after the date and separator, trimmed. May be empty. */
  content: string;
}

/** Parses `YYYY-MM-DD[: ...]` lines out of a Field Notes value. Order preserved. */
export function parseFieldNotesLines(value: string | undefined): FieldNotesLine[] {
  if (!value) return [];
  const lineRe = /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})(?:\s*[:\-–—]\s*(?<rest>.*))?$/;
  const out: FieldNotesLine[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const g = lineRe.exec(raw.trim())?.groups;
    if (!g) continue;
    out.push({
      unix: Date.UTC(Number(g.y), Number(g.m) - 1, Number(g.d), 12) / 1000,
      date: `${g.y}-${g.m}-${g.d}`,
      content: (g.rest ?? '').trim(),
    });
  }
  return out;
}

const optionLabel = (field: Field | undefined, id: string | undefined) =>
  (field && id && field.options.find((o) => o.id === id)?.label) || '';

// FreeHub's Location field (freehub src/lib/location.ts): "lat,lng" in decimal degrees,
// 6 decimals. A value that doesn't parse, or isn't a real place, is no location.
const STORED_LOCATION = /^(?<lat>-?\d+(?:\.\d+)?),(?<lng>-?\d+(?:\.\d+)?)$/u;

/** FreeHub's `valid`: finite, |lat| ≤ 90, |lon| ≤ 180, not 0,0. */
export function validLocation(lat: number | null, lon: number | null): { lat: number; lon: number } | null {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

export function readLocation(value: string | undefined): { lat: number; lon: number } | null {
  const groups = STORED_LOCATION.exec(value ?? '')?.groups;
  return groups ? validLocation(Number(groups.lat), Number(groups.lng)) : null;
}

export function locationValue(lat: number, lon: number): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/**
 * Writes a position into a record's Location field, in FreeHub's format. Nothing for a
 * position that isn't real, or a table without a Location field. Returns whether it wrote.
 */
function writeLocation(fields: MerchantFields, values: Record<string, string[]>, lat: number | null, lon: number | null): boolean {
  const p = validLocation(lat, lon);
  if (!p || !fields.location) return false;
  values[fields.location.id] = [locationValue(p.lat, p.lon)];
  return true;
}

export interface FreeHubData {
  project: Project;
  /** This npub is a member of the project; a viewer only reads. */
  canWrite: boolean;
  table: Table;
  fields: MerchantFields;
  merchants: Merchant[];
  /** Merchant id → the full record, for republishing it whole. */
  records: Map<string, CrmRecord>;
  /** Merchant id → set of YYYY-MM-DD on which a visit event already exists. Used by the
   *  Field-Notes backfill to skip dates that are already covered. */
  visitDates: Map<string, Set<string>>;
  /** Merchant id → unix time of its latest visit by any project member. */
  lastVisit: Map<string, number>;
  /**
   * Merchant id → unix time of the latest ACTIVITY of any kind (visit OR note) by any
   * project member. Map-only bypass: a pre-wipe round logged visits as notes, and the
   * wipe left many merchants without a visit event even though they were visited. The
   * map colours by this so those merchants aren't shown as "never". The list keeps
   * reading `lastVisit`.
   */
  lastTouch: Map<string, number>;
}

export type Resolution = { ok: true; data: FreeHubData } | { ok: false; reason: 'no-table' };

/** Everything FreeHub would show for the Merchants table, from raw events. */
export function resolve(events: NostrEvent[], me: string): Resolution {
  // Projects are edited only by their creator: newest per address.
  const projects = new Map<string, { e: NostrEvent; p: Project }>();
  for (const e of events) {
    if (e.kind !== PROJECT_KIND || isDeleted(e)) continue;
    const p = parseProject(e);
    const cur = projects.get(p.address);
    if (!cur || newer(e, cur.e)) projects.set(p.address, { e, p });
  }

  // The Merchants table is recognised by its content, not its slug: FreeHub derives a
  // pack table's slug from the name typed at creation (+ "-2"… when taken), so a
  // recreated or renamed table gets a different one. Prefer a merchant-named table with a
  // Journey stage and a Location field (a stage + Location alone could be another CRM
  // table, e.g. Deals); else any slug starting with "merchant". Newest wins.
  const score = (t: Table) => {
    const f = merchantFields(t);
    const merchantNamed = norm(t.slug || t.title).startsWith(MERCHANTS_SLUG.replace(/s$/, ''));
    if (f.journey && f.location && merchantNamed) return 2;
    return merchantNamed ? 1 : 0;
  };
  let best: { project: Project; table: Table; score: number } | null = null;
  for (const { p: project } of projects.values()) {
    if (!project.members.includes(me) && !project.viewers.includes(me)) continue;
    const authors = new Set(project.members);
    const tables = latestVersions(
      events.filter((e) => e.kind === CRM_TABLE_KIND && e.tags.some((t) => t[0] === 'a' && t[1] === project.address)),
      CRM_TABLE_KIND,
      authors,
    );
    for (const e of tables.values()) {
      if (isDeleted(e)) continue;
      const table = parseTable(e);
      const sc = score(table);
      if (sc === 0) continue;
      if (!best || sc > best.score || (sc === best.score && table.updatedAt > best.table.updatedAt)) best = { project, table, score: sc };
    }
  }
  if (!best) return { ok: false, reason: 'no-table' };

  const { project, table } = best;
  const authors = new Set(project.members);
  const fields = merchantFields(table);
  const records = [...latestVersions(events.filter((e) => tableIdOf(e) === table.id), CRM_RECORD_KIND, authors).values()]
    .filter((e) => !isDeleted(e))
    .map(parseRecord)
    .sort((a, b) => a.rank - b.rank || a.createdAt - b.createdAt);

  const coords = (r: CrmRecord) => readLocation(r.values[fields.location?.id ?? '']?.[0]);
  const merchants = records.map((r): Merchant => ({
    id: r.id,
    author: r.author,
    name: r.title,
    area: optionLabel(fields.area, r.values[fields.area?.id ?? '']?.[0]) || r.values[fields.area?.id ?? '']?.[0] || '',
    status: optionLabel(fields.journey, r.values[fields.journey?.id ?? '']?.[0]),
    journeyId: r.values[fields.journey?.id ?? '']?.[0] ?? '',
    needsFollowUp: r.values[fields.followUp?.id ?? '']?.[0] === 'true',
    // Both dead ends leave the day-to-day list: Closed and Not interested.
    closed: [JOURNEY_LABEL.closed, JOURNEY_LABEL.notInterested].some(
      (label) => norm(optionLabel(fields.journey, r.values[fields.journey?.id ?? '']?.[0])) === norm(label),
    ),
    osm: r.values[fields.osm?.id ?? '']?.[0] ?? '',
    lat: coords(r)?.lat ?? null,
    lon: coords(r)?.lon ?? null,
    rank: r.rank,
    fieldNotes: r.values[fields.fieldNotes?.id ?? '']?.[0] ?? '',
  }));

  const ids = new Set(merchants.map((m) => m.id));
  const lastVisit = new Map<string, number>();
  const lastTouch = new Map<string, number>();
  const visitDates = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind !== COMMENT_KIND || !authors.has(e.pubkey)) continue;
    const activity = tagValue(e, 'activity');
    if (activity !== 'visit' && activity !== 'note') continue;
    const [kind, , id] = (tagValue(e, 'A') ?? '').split(':');
    if (kind !== String(CRM_RECORD_KIND) || !ids.has(id)) continue;
    if (activity === 'visit') {
      lastVisit.set(id, Math.max(lastVisit.get(id) ?? 0, e.created_at));
      const date = localIsoDate(e.created_at);
      let set = visitDates.get(id);
      if (!set) {
        set = new Set();
        visitDates.set(id, set);
      }
      set.add(date);
    }
    lastTouch.set(id, Math.max(lastTouch.get(id) ?? 0, e.created_at));
  }
  // Fold in Field Notes: a merchant with a dated note counts as touched on that date,
  // picking up the 2026-10-06 round the relay restore folded into the record field.
  for (const m of merchants) {
    const ts = fieldNotesTouchedAt(m.fieldNotes);
    if (ts !== null) lastTouch.set(m.id, Math.max(lastTouch.get(m.id) ?? 0, ts));
  }

  return { ok: true, data: { project, canWrite: project.members.includes(me), table, fields, merchants, records: new Map(records.map((r) => [r.id, r])), visitDates, lastVisit, lastTouch } };
}

// ---------------------------------------------------------------- templates

const now = () => Math.floor(Date.now() / 1000);
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** FreeHub `activityTemplate(record, "visit", note)`. */
export function visitTemplate(m: Merchant, note: string, createdAt = now()): EventTemplate {
  const address = `${CRM_RECORD_KIND}:${m.author}:${m.id}`;
  return {
    kind: COMMENT_KIND,
    created_at: createdAt,
    content: note,
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
}

export interface BackfillRow {
  merchant: Merchant;
  date: string;
  template: EventTemplate;
}

/**
 * Builds visit-event templates for every dated line in every merchant's Field Notes that
 * doesn't already have a visit event on that date. Idempotent: dates already covered by
 * `data.visitDates` are skipped, so re-running after a partial run finishes the job.
 */
export function planFieldNotesBackfill(data: FreeHubData): BackfillRow[] {
  const rows: BackfillRow[] = [];
  for (const m of data.merchants) {
    if (m.unlisted) continue;
    const lines = parseFieldNotesLines(m.fieldNotes);
    const existing = data.visitDates.get(m.id) ?? new Set<string>();
    for (const line of lines) {
      if (existing.has(line.date)) continue;
      rows.push({
        merchant: m,
        date: line.date,
        template: visitTemplate(m, line.content || `(backfilled from Field Notes: ${line.date})`, line.unix),
      });
    }
  }
  return rows;
}

export interface NewMerchant {
  name: string;
  /** An existing Area option id, if any. */
  areaOption?: string;
  lat: number | null;
  lon: number | null;
  /** Start in this Journey stage instead of the first one (e.g. from a first check-in). */
  journey?: JourneyChoice;
  followUp?: boolean;
}

/** The `d` tag of a record template — the new merchant's id. */
export const templateId = (t: EventTemplate) => t.tags.find((x) => x[0] === 'd')?.[1] ?? '';

/** A merchant as it will exist once the new-record template is published. */
export function merchantFromTemplate(t: EventTemplate, me: string, name: string): Merchant {
  return { id: templateId(t), author: me, name, area: '', status: '', journeyId: '', needsFollowUp: false, closed: false, osm: '', lat: null, lon: null, rank: 0, fieldNotes: '' };
}

/** FM24 businesses not in FreeHub, shown greyed in the app (names only, bundled file). */
export async function loadUnlisted(): Promise<string[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}unlisted.json`, { cache: 'no-store' });
    if (!res.ok) return [];
    const names = (await res.json()) as unknown;
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function unlistedMerchants(names: string[], inFreeHub: Merchant[]): Merchant[] {
  const known = new Set(inFreeHub.map((m) => norm(m.name)));
  return names
    .filter((n) => !known.has(norm(n)))
    .map((name) => ({ id: `unlisted:${norm(name)}`, author: '', name, area: '', status: 'not in FreeHub', journeyId: '', needsFollowUp: false, closed: false, unlisted: true, osm: '', lat: null, lon: null, rank: 0, fieldNotes: '' }));
}

/** FreeHub `recordTemplate`: tags in FreeHub's order, values in table field order. */
function recordTags(table: Table, project: Project, r: Omit<CrmRecord, 'author' | 'updatedAt'>): string[][] {
  const tags: string[][] = [
    ['d', r.id],
    ['a', table.address],
    ['a', project.address],
    ['title', r.title],
    ['rank', String(r.rank)],
    ['created', String(r.createdAt)],
  ];
  if (r.creator) tags.push(['creator', r.creator]);
  // Values of fields this client doesn't know about are kept, after the known ones.
  const order = new Map(table.fields.map((f, i) => [f.id, i]));
  for (const [field, vals] of Object.entries(r.values).sort(([a], [b]) => (order.get(a) ?? order.size) - (order.get(b) ?? order.size))) {
    for (const v of vals) if (v !== '' && field !== 'title') tags.push(['val', field, v]);
  }
  for (const m of r.moves.slice(-100)) tags.push(m.by ? ['moved', m.stage, String(m.at), m.by] : ['moved', m.stage, String(m.at)]);
  tags.push(['alt', `CRM record: ${r.title}`]);
  return tags;
}

export type JourneyChoice =
  // "lead" is the raw queue: any merchant someone put on the list, whatever the origin
  // (bitcoiner tip, merchant reach-out, team target). Default stage for a new record.
  // The cycling Onboarding Status button in VisitSheet walks: lead → contacted →
  // accepting → notInterested → wraps. "closed" and "relocated" have their own buttons:
  // Closed means the business no longer exists (hidden from list/map; FreeHub's BTC Map
  // sync removes its OSM listing); Relocated means it moved, and stays visible so the new
  // spot can be pinned (the sync then moves the OSM listing).
  | 'lead'
  | 'contacted'
  | 'accepting'
  | 'notInterested'
  | 'closed'
  | 'relocated';
// Maps Visitas's internal ids to FreeHub Merchants-table stage labels.
const JOURNEY_LABEL: Record<JourneyChoice, string> = {
  lead: 'Lead',
  contacted: 'Contacted',
  accepting: 'Accepting bitcoin',
  notInterested: 'Not interested',
  closed: 'Closed',
  relocated: 'Relocated',
};
// Ordered Onboarding Status for the "cycle with press" button in VisitSheet.
// Closed and Relocated are NOT in the cycle — they have their own buttons.
export const ONBOARDING_LADDER: JourneyChoice[] = ['lead', 'contacted', 'accepting', 'notInterested'];
export const JOURNEY_EMOJI: Record<JourneyChoice, string> = {
  lead: '🌱',
  contacted: '📞',
  accepting: '✅',
  notInterested: '🚫',
  closed: '❌',
  relocated: '🚚',
};
export const journeyLabel = (j: JourneyChoice): string => JOURNEY_LABEL[j];

export interface RecordChange {
  journey?: JourneyChoice;
  /** New value of the "Needs follow-up" checkbox (undefined = leave as is). */
  followUp?: boolean;
  /** A position for a merchant that has none (filled in during a visit). */
  location?: { lat: number; lon: number };
  /** Where a Relocated business moved to. */
  newLocation?: { lat: number; lon: number };
}

/**
 * The record republished whole with the changes applied (FreeHub `updateRecord`): a stage
 * move is appended when Journey changes, and "Accepting bitcoin" also fills Accepting
 * since if empty. A position for a merchant that had none goes into Location. Returns null when nothing would change (or the table lacks the
 * field / option), so no event is written for a no-op.
 */
export function recordChangeTemplate(data: FreeHubData, me: string, m: Merchant, change: RecordChange): EventTemplate | null {
  const { fields, table, project } = data;
  const record = data.records.get(m.id);
  if (!record) return null;
  const t = Math.max(now(), record.updatedAt + 1);
  const values = { ...record.values };
  let moves = record.moves;
  let changed = false;

  if (change.journey && fields.journey) {
    const option = fields.journey.options.find((o) => norm(o.label) === norm(JOURNEY_LABEL[change.journey!]));
    if (option && values[fields.journey.id]?.[0] !== option.id) {
      values[fields.journey.id] = [option.id];
      moves = [...moves, { stage: option.id, at: t, by: me }];
      changed = true;
      if (change.journey === 'accepting' && fields.acceptingSince && !values[fields.acceptingSince.id]?.length) {
        values[fields.acceptingSince.id] = [localIsoDate(t)];
      }
    }
  }
  if (change.followUp !== undefined && fields.followUp) {
    const now_ = values[fields.followUp.id]?.[0] === 'true';
    if (now_ !== change.followUp) {
      // FreeHub stores a ticked checkbox as "true" and an unticked one as no value.
      if (change.followUp) values[fields.followUp.id] = ['true'];
      else delete values[fields.followUp.id];
      changed = true;
    }
  }
  if (change.location && writeLocation(fields, values, change.location.lat, change.location.lon)) changed = true;
  if (change.newLocation && fields.newLocation) {
    const p = validLocation(change.newLocation.lat, change.newLocation.lon);
    const value = p && locationValue(p.lat, p.lon);
    if (value && values[fields.newLocation.id]?.[0] !== value) {
      values[fields.newLocation.id] = [value];
      changed = true;
    }
  }
  if (!changed) return null;
  return { kind: CRM_RECORD_KIND, created_at: t, content: '', tags: recordTags(table, project, { ...record, values, moves }) };
}

// ---------------------------------------------------------------- table upgrade

export const NEW_LOCATION = 'New location';

/** What Visitas's Closed and Relocated buttons need on the Merchants table, as FreeHub's Merchants pack defines it. */
const REQUIRED_STAGES: { choice: JourneyChoice; color: string; kind: string }[] = [
  { choice: 'relocated', color: 'yellow', kind: 'open' },
  { choice: 'closed', color: 'gray', kind: 'lost' },
];

/** FreeHub's short field/option id: 8 hex characters. */
const shortId = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

const hasStage = (fields: MerchantFields, choice: JourneyChoice) =>
  !!fields.journey?.options.some((o) => norm(o.label) === norm(JOURNEY_LABEL[choice]));

/** The change asks for a stage or field the table doesn't have yet. */
export function needsTableUpgrade(fields: MerchantFields, change: RecordChange): boolean {
  const stage = change.journey === 'closed' || change.journey === 'relocated' ? change.journey : undefined;
  return (!!stage && !hasStage(fields, stage)) || (!!change.newLocation && !fields.newLocation);
}

/**
 * The Merchants table republished with everything the buttons need that it lacks: the Closed and
 * Relocated stages and the New location field. Every tag of the version it was read from is kept
 * as it is; only `option` and `field` tags are added. Throws instead of returning a version that
 * would lose or rename anything. Null when nothing is missing.
 */
export function tableUpgradeTemplate(table: Table, me: string): EventTemplate | null {
  if (!table.event.tags.some((t) => t[0] === 'creator') && table.event.pubkey !== me) {
    // Without a creator tag the table's address follows its author, so another member's version would move it.
    throw new Error("FreeHub's Merchants table has no creator tag; add Closed and Relocated in FreeHub instead.");
  }
  const fields = merchantFields(table);
  const tags = table.event.tags.map((t) => [...t]);
  const lastIndex = (match: (t: string[]) => boolean) => {
    for (let i = tags.length - 1; i >= 0; i--) if (match(tags[i])) return i;
    return -1;
  };
  let added = 0;
  const stage = fields.journey;
  if (stage) {
    const options = REQUIRED_STAGES.filter((s) => !hasStage(fields, s.choice)).map((s) => [
      'option', stage.id, shortId(), JOURNEY_LABEL[s.choice], s.color, s.kind,
    ]);
    if (options.length) {
      const last = lastIndex((t) => t[0] === 'option' && t[1] === stage.id);
      tags.splice(last >= 0 ? last + 1 : tags.length, 0, ...options);
      added += options.length;
    }
  }
  if (!fields.newLocation) {
    const last = lastIndex((t) => t[0] === 'field');
    tags.splice(last >= 0 ? last + 1 : tags.length, 0, ['field', shortId(), 'location', NEW_LOCATION]);
    added += 1;
  }
  if (added === 0) return null;

  // Read the new version back: everything that was there must still be there, unchanged.
  const after = parseTable({ ...table.event, tags });
  for (const field of table.fields) {
    const kept = after.fields.find((f) => f.id === field.id);
    const same =
      kept &&
      kept.type === field.type &&
      kept.name === field.name &&
      field.options.every((o) => kept.options.some((k) => k.id === o.id && k.label === o.label));
    if (!same) throw new Error(`Upgrading the Merchants table would change "${field.name}"; nothing was published.`);
  }
  const check = merchantFields(after);
  if (!check.newLocation || !hasStage(check, 'closed') || !hasStage(check, 'relocated') || check.location?.id !== fields.location?.id) {
    throw new Error('Upgrading the Merchants table did not come out as expected; nothing was published.');
  }
  return { kind: CRM_TABLE_KIND, created_at: Math.max(now(), table.updatedAt + 1), content: '', tags };
}

/** The data as it reads once the upgraded table is in. */
export function withTable(data: FreeHubData, upgrade: EventTemplate): FreeHubData {
  const table = parseTable({ ...data.table.event, created_at: upgrade.created_at, tags: upgrade.tags });
  return { ...data, table, fields: merchantFields(table) };
}

const localIsoDate = (unix: number) => {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** FreeHub `createRecord` + `recordTemplate`: first Journey stage, Owner = me, rank last + 1. */
export function newMerchantTemplate(data: FreeHubData, me: string, input: NewMerchant): EventTemplate {
  const { table, project, fields, merchants } = data;
  const t = now();
  const values: Record<string, string[]> = {};
  const chosen = input.journey && fields.journey?.options.find((o) => norm(o.label) === norm(JOURNEY_LABEL[input.journey!]));
  const firstStage = chosen || fields.journey?.options[0];
  if (fields.journey && firstStage) values[fields.journey.id] = [firstStage.id];
  if (input.journey === 'accepting' && fields.acceptingSince) values[fields.acceptingSince.id] = [localIsoDate(t)];
  if (input.followUp && fields.followUp) values[fields.followUp.id] = ['true'];
  if (fields.owner) values[fields.owner.id] = [me];
  if (fields.area && input.areaOption) values[fields.area.id] = [input.areaOption];
  writeLocation(fields, values, input.lat, input.lon);

  const lastRank = Math.max(0, ...merchants.map((m) => m.rank));
  const tags = recordTags(table, project, {
    id: newId(),
    title: input.name,
    rank: lastRank + 1,
    createdAt: t,
    creator: me,
    values,
    moves: fields.journey && firstStage ? [{ stage: firstStage.id, at: t, by: me }] : [],
  });
  return { kind: CRM_RECORD_KIND, created_at: t, content: '', tags };
}

// ---------------------------------------------------------------- relays

export type Access = 'connecting' | 'online' | 'offline' | 'denied';

const REFUSED = /^(?:restricted|blocked|invalid|pow):/;
const ACCEPTED = (ok: boolean, message?: string) => ok || (message ?? '').startsWith('duplicate:');

export class TeamRelays {
  readonly relays: Relay[];
  private denied = new Set<string>();
  private signer: Signer;
  private pubkey: string;

  constructor(signer: Signer, pubkey: string) {
    this.signer = signer;
    this.pubkey = pubkey;
    this.relays = TEAM_RELAYS.map((url) => new Relay(url));
    for (const relay of this.relays) {
      // NIP-42: answer every challenge with the user's key (signed by Amber on the phone).
      relay.challenge$.subscribe((challenge) => {
        if (!challenge || relay.authenticatedAs === this.pubkey) return;
        relay
          .authenticate(this.signer)
          .then((r) => {
            if (!r.ok && REFUSED.test(r.message ?? '')) this.denied.add(relay.url);
          })
          .catch(() => {});
      });
    }
  }

  isDenied() {
    return this.relays.every((r) => this.denied.has(r.url));
  }

  /** Every stored event matching the filter, paging back FreeHub-style. */
  private async fetchAll(relay: Relay, base: Record<string, unknown>): Promise<NostrEvent[]> {
    const out = new Map<string, NostrEvent>();
    let until: number | undefined;
    for (let page = 0; page < 200; page++) {
      const filter = { ...base, limit: 500, ...(until === undefined ? {} : { until }) };
      const events = await lastValueFrom(relay.request(filter).pipe(timeout(45_000), toArray()), { defaultValue: [] });
      if (events.length === 0) break;
      let fresh = 0;
      let oldest = Infinity;
      for (const e of events) {
        if (!out.has(e.id)) {
          out.set(e.id, e);
          fresh++;
        }
        oldest = Math.min(oldest, e.created_at);
      }
      if (fresh > 0) until = oldest; // same second again: more may share it
      else if (until === oldest - 1) break;
      else until = oldest - 1;
    }
    return [...out.values()];
  }

  /** Projects, CRM tables, then the Merchants table's records and all record activity. */
  async load(me: string): Promise<NostrEvent[]> {
    let lastError: unknown;
    for (const relay of this.relays) {
      if (this.denied.has(relay.url)) continue;
      try {
        const head = [
          ...(await this.fetchAll(relay, { kinds: [PROJECT_KIND] })),
          ...(await this.fetchAll(relay, { kinds: [CRM_TABLE_KIND] })),
        ];
        const r = resolve(head, me);
        if (!r.ok) return head;
        const records = await this.fetchAll(
          relay,
          r.data.table.address.length <= 100
            ? { kinds: [CRM_RECORD_KIND], '#a': [r.data.table.address] }
            : { kinds: [CRM_RECORD_KIND], authors: r.data.project.members },
        );
        const activity = await this.fetchAll(relay, { kinds: [COMMENT_KIND], '#K': [String(CRM_RECORD_KIND)] });
        return [...head, ...records, ...activity];
      } catch (e) {
        // Haven repeats auth-required after AUTH when the key isn't whitelisted.
        if (relay.authenticatedAs === this.pubkey && /auth-required|restricted|blocked/i.test(String(e))) {
          this.denied.add(relay.url);
        }
        lastError = e;
      }
    }
    if (this.isDenied()) throw new DeniedError();
    throw lastError ?? new Error('No team relay reachable.');
  }

  /** Projects and CRM tables, fresh from the first relay that answers: what a table upgrade is built from. */
  async head(): Promise<NostrEvent[]> {
    let lastError: unknown;
    for (const relay of this.relays) {
      if (this.denied.has(relay.url)) continue;
      try {
        return [
          ...(await this.fetchAll(relay, { kinds: [PROJECT_KIND] })),
          ...(await this.fetchAll(relay, { kinds: [CRM_TABLE_KIND] })),
        ];
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError ?? new Error('No team relay reachable.');
  }

  /** True once any team relay has the event. */
  async publish(event: NostrEvent): Promise<boolean> {
    const results = await Promise.allSettled(this.relays.map((r) => r.publish(event, { timeout: 15_000 })));
    const accepted = results.some((r) => r.status === 'fulfilled' && ACCEPTED(r.value.ok, r.value.message));
    if (!accepted) {
      // Kept in the outbox; say why, so a refusal can be read from the device log.
      const why = results.map((r, i) => `${this.relays[i].url}: ${r.status === 'fulfilled' ? r.value.message || 'refused' : String(r.reason)}`);
      console.warn(`Relay didn't take kind ${event.kind} (${event.id.slice(0, 8)}): ${why.join('; ')}`);
    }
    return accepted;
  }

  close() {
    for (const r of this.relays) r.close();
  }
}

export class DeniedError extends Error {
  constructor() {
    super('This npub is not on the team relay whitelist.');
  }
}

// ---------------------------------------------------------------- outbox + cache (this device)

const outboxKey = (pk: string) => `visit-tracker.outbox.${pk}`;
const cacheKey = (pk: string) => `visit-tracker.cache.${pk}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / blocked: the outbox then lives in memory only */
  }
}

/** Signed events waiting for a team relay to accept them (survives restarts, offline). */
export const outbox = {
  list: (pk: string) => read<NostrEvent[]>(outboxKey(pk), []),
  add: (pk: string, e: NostrEvent) => write(outboxKey(pk), [...outbox.list(pk), e]),
  remove: (pk: string, id: string) => write(outboxKey(pk), outbox.list(pk).filter((e) => e.id !== id)),
};

/**
 * A load much smaller than the copy already on this phone: an emptied or broken relay.
 * It must not replace the phone's copy, which may be the only one left (2026-10-08).
 */
export function looksWiped(kept: NostrEvent[], fresh: NostrEvent[]): boolean {
  return kept.length >= 20 && fresh.length < kept.length / 2;
}

/** Last good load, so the list opens offline. */
export const cache = {
  get: (pk: string) => read<{ at: number; events: NostrEvent[] } | null>(cacheKey(pk), null),
  set: (pk: string, events: NostrEvent[]) => write(cacheKey(pk), { at: Date.now(), events }),
};
