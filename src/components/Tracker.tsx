import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { HEAT, HEAT_NEVER, PALETTE, PALETTE_LABELS } from '../config.ts';
import { navigateTo, saveBackup } from '../lib/field.ts';
import {
  type Access,
  type FreeHubData,
  loadUnlisted,
  merchantFromTemplate,
  newMerchantTemplate,
  planFieldNotesBackfill,
  needsTableUpgrade,
  recordChangeTemplate,
  tableUpgradeTemplate,
  withTable,
  unlistedMerchants,
  VIEW_ONLY,
  visitTemplate,
} from '../lib/freehub.ts';
import { distanceKm, highlights } from '../lib/geo.ts';
import { keyOf } from '../lib/keys.ts';
import { localDate, today, toggleUrgent, useTrackerState } from '../lib/state.ts';
import AddMerchantSheet from './AddMerchantSheet.tsx';
import MapView from './MapView.tsx';
import VisitSheet from './VisitSheet.tsx';

interface Props {
  pubkey: string;
  data: FreeHubData;
  access: Access;
  pending: number;
  loadedAt?: number;
  onRefresh: () => void;
  publish: (t: EventTemplate) => Promise<NostrEvent>;
  /** The data with the Merchants table re-read from the relay. */
  freshData: () => Promise<FreeHubData>;
  /** The relay answered with far less than this phone has; the phone's copy is kept. */
  suspect: { fresh: number; cached: number } | null;
  onTrustRelay: () => void;
  backupJson: () => string;
  onLogout: () => void;
}

// 'followup' = the Follow-ups view: flagged first, then reddest (never / longest ago).
type Col = 'name' | 'area' | 'status' | 'visit' | 'followup';

const INACTIVE = new Set(['not interested']);
const formatKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

function heat(ts: number | undefined) {
  if (!ts) return HEAT_NEVER;
  const days = (Date.now() / 1000 - ts) / 86400;
  return HEAT.find((h) => days <= h.maxDays) ?? HEAT_NEVER;
}

export default function Tracker({ pubkey, data, access, pending, onRefresh, publish, freshData, onLogout, suspect, onTrustRelay, backupJson }: Props) {
  // A viewer in FreeHub reads everything here and saves nothing: FreeHub ignores what viewers publish.
  const readOnly = !data.canWrite;
  const write = (template: EventTemplate) =>
    readOnly ? Promise.reject(new Error(VIEW_ONLY)) : publish(template);
  const { lastVisit } = data;
  const [showClosed, setShowClosed] = useState(false);
  // Closed places (they don't exist anymore) drop out of the list unless asked for.
  const closedCount = data.merchants.filter((m) => m.closed).length;
  const [unlisted, setUnlisted] = useState<string[]>([]);
  useEffect(() => {
    loadUnlisted().then(setUnlisted);
  }, []);
  const merchants = useMemo(() => {
    const live = showClosed ? data.merchants : data.merchants.filter((m) => !m.closed);
    return [...live, ...unlistedMerchants(unlisted, data.merchants)];
  }, [data.merchants, showClosed, unlisted]);
  const { state, update, saveFailed } = useTrackerState(pubkey);
  const [sort, setSort] = useState<{ col: Col; asc: boolean }>({ col: 'area', asc: true });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Nearby-first ordering: on when you select or flag a business, off when you pick a
  // column sort (or tap the chip) — so the order is always the one you last asked for.
  const [nearbyFirst, setNearbyFirst] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');

  const t = today();
  const visitDate = (i: number) => {
    const ts = lastVisit.get(merchants[i].id);
    return ts ? localDate(ts) : undefined;
  };

  const hl = useMemo(
    () => highlights(merchants, keyOf, state.urgent, state.radiusKm),
    [merchants, state.urgent, state.radiusKm],
  );

  // Businesses the list pulls neighbours to the top for: selected ones and urgent ones.
  const anchors = useMemo(
    () => merchants.map((_, i) => i).filter((i) => selected.has(i) || keyOf(merchants[i]) in state.urgent),
    [merchants, selected, state.urgent],
  );

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const idx = merchants.map((_, i) => i).filter((i) => !q || merchants[i].name.toLowerCase().includes(q));
    const val = (i: number): string => {
      const seen = String(lastVisit.get(merchants[i].id) ?? 0).padStart(12, '0');
      if (sort.col === 'visit') return seen;
      if (sort.col === 'followup') return (merchants[i].needsFollowUp ? '0' : '1') + seen;
      return merchants[i][sort.col];
    };
    const byColumn = (a: number, b: number) => {
      const va = val(a);
      const vb = val(b);
      // Blank area/status always last; "never visited" sorts as oldest.
      if (sort.col !== 'visit' && sort.col !== 'followup' && (va === '') !== (vb === '')) return va === '' ? 1 : -1;
      const c = va.localeCompare(vb) || merchants[a].name.localeCompare(merchants[b].name);
      return sort.asc ? c : -c;
    };
    const near = new Map<number, number>();
    for (const i of nearbyFirst ? idx : []) {
      const km = Math.min(Infinity, ...anchors.map((a) => (a === i ? 0 : distanceKm(merchants[i], merchants[a]))));
      if (km <= state.radiusKm) near.set(i, km);
    }
    const top = idx.filter((i) => near.has(i)).sort((a, b) => near.get(a)! - near.get(b)! || byColumn(a, b));
    const rest = idx.filter((i) => !near.has(i)).sort(byColumn);
    return { order: [...top, ...rest], near };
  }, [merchants, lastVisit, filter, sort, state.radiusKm, anchors, nearbyFirst]);

  function header(col: Col, label: string) {
    const active = sort.col === col;
    return (
      <th>
        <button
          className="sort"
          onClick={() => {
            setSort({ col, asc: active ? !sort.asc : true });
            setNearbyFirst(false);
          }}
        >
          {label}
          <span className="arrow">{active ? (sort.asc ? '▲' : '▼') : ''}</span>
        </button>
      </th>
    );
  }

  function toggleSelect(i: number) {
    setNearbyFirst(true);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  }

  function followUps() {
    // Flagged "Needs follow-up" first, then reddest: never visited, then longest ago.
    setSort({ col: 'followup', asc: true });
    setNearbyFirst(false);
    setFilter('');
  }

  async function navigate(m: typeof merchants[number]) {
    setMsg('');
    await navigateTo(m).catch((e) => setMsg(String(e)));
  }

  const status =
    access === 'online'
      ? pending
        ? `${pending} waiting to send`
        : 'Synced with FreeHub'
      : access === 'connecting'
        ? 'Connecting to FreeHub…'
        : access === 'denied'
          ? 'Not on the team relay whitelist'
          : `Offline${pending ? ` · ${pending} waiting to send` : ''}`;
  const urgentCount = Object.keys(state.urgent).length;

  const [backupNote, setBackupNote] = useState('');
  async function backup() {
    try {
      setBackupNote(`Saved to ${await saveBackup(backupJson())}`);
    } catch (e) {
      setBackupNote(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const [backfilling, setBackfilling] = useState(false);
  async function backfillNotes() {
    const rows = planFieldNotesBackfill(data);
    if (rows.length === 0) {
      setBackupNote('Nothing to backfill: every dated Field Notes line already has a visit.');
      return;
    }
    const merchantsTouched = new Set(rows.map((r) => r.merchant.id)).size;
    if (!confirm(`Publish ${rows.length} visit events from ${merchantsTouched} merchants' Field Notes?\n\nIdempotent — safe to re-run if interrupted.`)) return;
    setBackfilling(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const row of rows) {
        try {
          await write(row.template);
          ok++;
        } catch {
          fail++;
        }
      }
      setBackupNote(`Backfill: ${ok} queued, ${fail} failed. They'll flush when the relay accepts them.`);
    } finally {
      setBackfilling(false);
    }
  }



  return (
    <main className="tracker">
      <header className="top">
        <h1>Visitas</h1>
        <div className="who">
          <span className="muted" title={npubEncode(pubkey)}>{npubEncode(pubkey).slice(0, 12)}…</span>
          <button className="ghost small" onClick={onLogout}>Log out</button>
        </div>
      </header>

      <div className={`sync tight ${pending || access !== 'online' ? 'pending' : ''}`}>
        <span className="small dot-status" title={status}>
          <span
            className="status-dot"
            style={{
              background:
                access === 'online' && !pending
                  ? '#66bb6a'
                  : access === 'online' || access === 'connecting'
                  ? '#ffee58'
                  : '#ef5350',
            }}
          />
          {pending ? `${pending} pending` : access === 'online' ? 'synced' : access === 'connecting' ? '…' : access === 'denied' ? 'denied' : 'offline'}
        </span>
        <button className="icon" aria-label="Backup" title="Backup" onClick={backup}>💾</button>
        {!readOnly && (
          <button className="icon" aria-label="Backfill from Field Notes" title="Backfill from Field Notes" disabled={backfilling} onClick={backfillNotes}>
            {backfilling ? '…' : '📜'}
          </button>
        )}
        <button className="icon" aria-label="Refresh" title="Refresh" onClick={onRefresh}>🔄</button>
      </div>
      {readOnly && <p className="small muted">👁 {VIEW_ONLY}</p>}
      {backupNote && (
        <p className="small muted" onClick={() => setBackupNote('')}>
          {backupNote}
        </p>
      )}

      {suspect && (
        <div className="sync pending">
          <span className="small">
            ⚠️ The relay sent only {suspect.fresh} of the {suspect.cached} items this phone has. Keeping the phone's copy:
            it may be the only one. Tap 💾 Backup, then check the relay.
          </span>
          <button
            className="small"
            onClick={() => {
              if (confirm(`Replace this phone's ${suspect.cached} items with the relay's ${suspect.fresh}? Back up first.`)) onTrustRelay();
            }}
          >
            Use relay's data
          </button>
        </div>
      )}

      <div className="controls">
        <input type="search" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="radius">
          Nearby within
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={state.radiusKm}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) update((s) => ({ ...s, radiusKm: v }));
            }}
          />
          km
        </label>
        <button className="small" onClick={followUps}>🔥 Follow-ups</button>
        {!readOnly && <button className="small" onClick={() => setAdding(true)}>+ Add merchant</button>}
        {closedCount > 0 && (
          <label className="small muted">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => {
                setSelected(new Set()); // ticks are list positions; the list is about to change
                setShowClosed(e.target.checked);
              }}
            />{' '}
            show closed ({closedCount})
          </label>
        )}
        <span className="muted small">
          {merchants.length} businesses · {urgentCount} urgent ·{' '}
          <button
            type="button"
            className="view-flip icon"
            aria-label={state.view === 'list' ? 'Switch to Map view' : 'Switch to List view'}
            title={state.view === 'list' ? 'Switch to Map' : 'Switch to List'}
            onClick={() => update((s) => ({ ...s, view: s.view === 'list' ? 'map' : 'list' }))}
          >
            {state.view === 'list' ? '🗺️' : '☰'}
          </button>
        </span>
      </div>
      {state.view === 'map' ? (
        <MapView
          merchants={merchants}
          lastTouch={data.lastTouch}
          selectedIds={new Set([...selected].map((i) => merchants[i].id))}
          urgentById={new Map(Object.entries(state.urgent))}
        />
      ) : (
        <>
      <div className="legend small">
        {[...HEAT, HEAT_NEVER].filter((h, i, a) => a.findIndex((x) => x.label === h.label) === i).map((h) => (
          <span key={h.label}>
            <span className="dot" style={{ background: h.color }} /> {h.label}
          </span>
        ))}
      </div>
      {nearbyFirst && anchors.length > 0 && (
        <button className="chip small" onClick={() => setNearbyFirst(false)}>Nearby first ✕</button>
      )}
      {saveFailed && <p className="error">This browser is blocking local storage — urgent flags won't be kept.</p>}
      {msg && <p className="small muted">{msg}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="Select" />
              {header('name', 'Name')}
              {header('area', 'Area')}
              {header('status', 'Journey')}
              {header('visit', 'Last visit')}
              <th>Urgent</th>
              <th>Check in</th>
            </tr>
          </thead>
          <tbody>
            {rows.order.map((i) => {
              const m = merchants[i];
              const k = keyOf(m);
              const h = hl.get(i);
              const visit = visitDate(i);
              const temp = heat(lastVisit.get(m.id));
              const color = h ? PALETTE[h.color] : undefined;
              const style = color
                ? ({ '--hl': color, '--hl-bg': h!.urgent ? `${color}38` : `${color}1a` } as CSSProperties)
                : undefined;
              return (
                <tr
                  key={m.id}
                  className={[h ? 'hl' : '', h?.urgent ? 'is-urgent' : '', INACTIVE.has(m.status.toLowerCase()) || m.unlisted ? 'inactive' : '']
                    .filter(Boolean)
                    .join(' ')}
                  style={style}
                  title={h?.near ? `${h.near.km.toFixed(2)} km from ${h.near.name}` : undefined}
                >
                  <td>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggleSelect(i)} aria-label={`Select ${m.name}`} />
                  </td>
                  <td className="name">
                    {h && <span className="tag">{PALETTE_LABELS[h.color]}</span>}
                    <button className="link name-btn" onClick={() => setOpen(i)}>{m.name}</button>
                    {m.needsFollowUp && <span className="flagged" title="Needs follow-up">⚠️</span>}
                    {m.unlisted && <span className="muted small"> · not in FreeHub</span>}
                    {rows.near.has(i) && rows.near.get(i)! > 0 && <span className="dist small"> · {formatKm(rows.near.get(i)!)}</span>}
                  </td>
                  <td>{m.area || <span className="muted">—</span>}</td>
                  <td className="status">{m.status}</td>
                  <td className="visit">
                    <span className="dot" style={{ background: temp.color }} title={temp.label} /> {visit ?? <span className="muted">never</span>}
                  </td>
                  <td>
                    <button
                      className={`flag ${h?.urgent ? 'on' : ''}`}
                      onClick={() => {
                        setNearbyFirst(true);
                        update((s) => toggleUrgent(s, k, PALETTE.length));
                      }}
                      aria-pressed={!!h?.urgent}
                      title={h?.urgent ? 'Unflag urgent' : 'Flag urgent'}
                    >
                      {h?.urgent ? PALETTE_LABELS[h.color] : '!'}
                    </button>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="icon nav-row"
                        aria-label={`Navigate to ${m.name}`}
                        title="Navigate here"
                        onClick={() => navigate(m)}
                      >
                        🧭
                      </button>
                      <button
                        className={`checkin ${visit === t ? 'done' : ''}`}
                        onClick={() => setOpen(i)}
                        title="Open the visit: saving it is the check-in"
                      >
                        {visit === t ? '✓ today' : 'Check in'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

        </>
      )}

      {open !== null && merchants[open] && (
        <VisitSheet
          merchant={merchants[open]}
          lastVisit={lastVisit.get(merchants[open].id)}
          onSave={async (note, change) => {
            const m = merchants[open];
            let d = data;
            if (needsTableUpgrade(d.fields, change)) {
              // Closed, Relocated and New location are added to the table once, by the first phone that needs them,
              // from a fresh copy so no one's edit in FreeHub is undone.
              try {
                d = await freshData();
              } catch {
                throw new Error("Go online once: FreeHub's Merchants table needs the Closed and Relocated stages, and this phone adds them.");
              }
              const upgrade = tableUpgradeTemplate(d.table, pubkey);
              if (upgrade) {
                await write(upgrade);
                d = withTable(d, upgrade);
              }
            }
            if (m.unlisted) {
              // First check-in at an FM24 business: add it to FreeHub, with the choices made.
              const create = newMerchantTemplate(d, pubkey, {
                name: m.name,
                lat: change.location?.lat ?? null,
                lon: change.location?.lon ?? null,
                journey: change.journey,
                followUp: change.followUp,
              });
              await write(create);
              await write(visitTemplate(merchantFromTemplate(create, pubkey, m.name), note));
              setOpen(null);
              return;
            }
            await write(visitTemplate(m, note));
            const update = recordChangeTemplate(d, pubkey, m, change);
            if (update) await write(update);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
          canSaveLocation={!!data.fields.location}
          readOnly={readOnly}
        />
      )}
      {adding && (
        <AddMerchantSheet
          areas={data.fields.area?.options ?? []}
          existingNames={new Set(merchants.map((m) => m.name.toLowerCase()))}
          onAdd={async (m) => {
            await write(newMerchantTemplate(data, pubkey, m));
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </main>
  );
}
