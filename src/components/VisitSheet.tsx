import { useState } from 'react';
import { capture, currentPosition, isNative, navigateTo } from '../lib/field.ts';
import { validLocation, type JourneyChoice, type Merchant, type RecordChange } from '../lib/freehub.ts';
import { localDate, today } from '../lib/state.ts';

interface Props {
  merchant: Merchant;
  /** Unix time of the latest team visit, if any. */
  lastVisit?: number;
  /** Publishes the visit, then any Journey / follow-up / location change, to FreeHub. */
  onSave: (note: string, change: RecordChange) => Promise<void>;
  onClose: () => void;
  /** The Merchants table has a Location field to keep a position in. */
  canSaveLocation: boolean;
}

// Notes are FreeHub's: the sheet shows when the last visit was, not what it said.
export default function VisitSheet({ merchant, lastVisit, onSave, onClose, canSaveLocation }: Props) {
  const [note, setNote] = useState('');
  const [media, setMedia] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [journey, setJourney] = useState<JourneyChoice | undefined>();
  // Starts at the merchant's current flag: untick to clear it, tick to set it.
  const [followUp, setFollowUp] = useState(merchant.needsFollowUp);
  // A position for a merchant that has none, from the phone's GPS. Never replaces one.
  const missingLocation = canSaveLocation && (merchant.lat === null || merchant.lon === null);
  const [position, setPosition] = useState<{ lat: number; lon: number; accuracy?: number } | null>(null);
  const [positionErr, setPositionErr] = useState('');
  const dirty =
    note.trim() !== '' || media.length > 0 || !!journey || followUp !== merchant.needsFollowUp || !!position;

  async function locate() {
    setPositionErr('');
    setBusy(true);
    try {
      const p = await currentPosition();
      if (validLocation(p.lat, p.lon)) setPosition(p);
      else setPositionErr("Couldn't get a real position, try again outside.");
    } catch (e) {
      setPositionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function shoot(kind: 'photo' | 'video') {
    setErr('');
    setBusy(true);
    try {
      const path = await capture(kind, merchant, today());
      if (path) setMedia((m) => [...m, path]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setErr('');
    setBusy(true);
    try {
      await onSave(note.trim(), { journey, followUp, location: position ? { lat: position.lat, lon: position.lon } : undefined });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function close() {
    if (dirty && !confirm('Discard this visit? Photos and videos already taken stay in the FREE Madeira folder.')) return;
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2>{merchant.name}</h2>
            <p className="muted small">
              {merchant.area || 'no area'}
              {merchant.status && ` · ${merchant.status}`} · last visit {lastVisit ? localDate(lastVisit) : 'never'}
            </p>
          </div>
          <button className="ghost small" onClick={close}>Close</button>
        </header>

        <button onClick={() => navigateTo(merchant).catch((e) => setErr(String(e)))}>🧭 Navigate</button>

        {missingLocation && (
          <div className="location">
            {position ? (
              <p className="position">
                <span>
                  📍 {position.lat.toFixed(5)}, {position.lon.toFixed(5)}
                  {position.accuracy !== undefined && ` (±${Math.round(position.accuracy)} m)`}
                </span>
                <button className="ghost small" aria-label="Drop this position" onClick={() => setPosition(null)}>✕</button>
              </p>
            ) : (
              <>
                <p className="muted small">📍 No location yet</p>
                <button disabled={busy} onClick={locate}>📍 Use my position here</button>
              </>
            )}
            {positionErr && <p className="error">{positionErr}</p>}
          </div>
        )}

        <div className="row journey">
          <button
            className={journey === 'accepting' ? 'on ok' : ''}
            aria-pressed={journey === 'accepting'}
            onClick={() => setJourney((j) => (j === 'accepting' ? undefined : 'accepting'))}
          >
            ✅ Accepting bitcoin
          </button>
          <button
            className={journey === 'closed' ? 'on bad' : ''}
            aria-pressed={journey === 'closed'}
            onClick={() => setJourney((j) => (j === 'closed' ? undefined : 'closed'))}
          >
            ❌ Closed
          </button>
        </div>
        <label className="followup">
          <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
          ⚠️ Needs follow-up
        </label>

        <textarea
          className="note"
          placeholder="Notes — tap the keyboard mic to dictate"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={5}
        />

        {isNative() && (
          <div className="row">
            <button disabled={busy} onClick={() => shoot('photo')}>📷 Photo</button>
            <button disabled={busy} onClick={() => shoot('video')}>🎥 Video</button>
          </div>
        )}
        {media.length > 0 && (
          <ul className="media small">
            {media.map((p) => (
              <li key={p}>{p.split('/').pop()}</li>
            ))}
          </ul>
        )}
        {err && <p className="error">{err}</p>}

        <button className="primary" disabled={busy} onClick={save}>
          Check in &amp; save ({today()})
        </button>
      </div>
    </div>
  );
}
