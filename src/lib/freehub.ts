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
  members: string[];
}

function parseProject(e: NostrEvent): Project {
  const d = tagValue(e, 'd') ?? '';
  const members = [e.pubkey, ...e.tags.filter((t) => t[0] === 'p' && isPubkey(t[1])).map((t) => t[1])];
  return { address: `${PROJECT_KIND}:${e.pubkey}:${d}`, title: tagValue(e, 'title') ?? 'Untitled', members: [...new Set(members)] };
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
  /** Journey is "Closed": the place doesn't exist anymore (hidden by default). */
  closed: boolean;
  /** An FM24 business not in FreeHub yet (names only); checking in adds it. */
  unlisted?: boolean;
  osm: string;
  lat: number | null;
  lon: number | null;
  rank: number;
}

/** The Merchants table's fields the app reads/writes, found by name (ids are random per table). */
export interface MerchantFields {
  area?: Field;
  /** FreeHub's Location field (type `location`): the coordinates, and what its map pins. */
  location?: Field;
  osm?: Field;
  journey?: Field;
  owner?: Field;
  acceptingSince?: Field;
  followUp?: Field;
}

export function merchantFields(table: Table): MerchantFields {
  const by = (name: string, type?: string) =>
    table.fields.find((f) => norm(f.name) === norm(name) && (!type || f.type === type));
  return {
    area: by('Area'),
    location: table.fields.find((f) => f.type === 'location'),
    osm: by('OSM link'),
    journey: table.fields.find((f) => f.type === 'stage'),
    owner: by('Owner', 'member'),
    acceptingSince: by('Accepting since', 'date'),
    followUp: by('Needs follow-up', 'checkbox'),
  };
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
  table: Table;
  fields: MerchantFields;
  merchants: Merchant[];
  /** Merchant id → the full record, for republishing it whole. */
  records: Map<string, CrmRecord>;
  /** Merchant id → unix time of its latest visit by any project member. */
  lastVisit: Map<string, number>;
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
    if (!project.members.includes(me)) continue;
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
    closed: norm(optionLabel(fields.journey, r.values[fields.journey?.id ?? '']?.[0])) === 'closed',
    osm: r.values[fields.osm?.id ?? '']?.[0] ?? '',
    lat: coords(r)?.lat ?? null,
    lon: coords(r)?.lon ?? null,
    rank: r.rank,
  }));

  const ids = new Set(merchants.map((m) => m.id));
  const lastVisit = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== COMMENT_KIND || tagValue(e, 'activity') !== 'visit' || !authors.has(e.pubkey)) continue;
    const [kind, , id] = (tagValue(e, 'A') ?? '').split(':');
    if (kind !== String(CRM_RECORD_KIND) || !ids.has(id)) continue;
    lastVisit.set(id, Math.max(lastVisit.get(id) ?? 0, e.created_at));
  }

  return { ok: true, data: { project, table, fields, merchants, records: new Map(records.map((r) => [r.id, r])), lastVisit } };
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
  return { id: templateId(t), author: me, name, area: '', status: '', journeyId: '', needsFollowUp: false, closed: false, osm: '', lat: null, lon: null, rank: 0 };
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
    .map((name) => ({ id: `unlisted:${norm(name)}`, author: '', name, area: '', status: 'not in FreeHub', journeyId: '', needsFollowUp: false, closed: false, unlisted: true, osm: '', lat: null, lon: null, rank: 0 }));
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

export type JourneyChoice = 'accepting' | 'closed';
const JOURNEY_LABEL: Record<JourneyChoice, string> = { accepting: 'Accepting bitcoin', closed: 'Closed' };

export interface RecordChange {
  journey?: JourneyChoice;
  /** New value of the "Needs follow-up" checkbox (undefined = leave as is). */
  followUp?: boolean;
  /** A position for a merchant that has none (filled in during a visit). */
  location?: { lat: number; lon: number };
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
  if (!changed) return null;
  return { kind: CRM_RECORD_KIND, created_at: t, content: '', tags: recordTags(table, project, { ...record, values, moves }) };
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

  /** True once any team relay has the event. */
  async publish(event: NostrEvent): Promise<boolean> {
    const results = await Promise.allSettled(this.relays.map((r) => r.publish(event, { timeout: 15_000 })));
    return results.some((r) => r.status === 'fulfilled' && ACCEPTED(r.value.ok, r.value.message));
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
