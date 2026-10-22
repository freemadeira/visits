import { useState } from 'react';
import { capture, currentPosition, isNative, navigateTo } from '../lib/field.ts';
import {
  JOURNEY_EMOJI,
  ONBOARDING_LADDER,
  journeyLabel,
  validLocation,
  VIEW_ONLY,
  type JourneyChoice,
  type Merchant,
  type RecordChange,
} from '../lib/freehub.ts';
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
  /** This npub is a viewer in FreeHub: nothing can be saved. */
  readOnly: boolean;
}

// Notes are FreeHub's: the sheet shows when the last visit was, not what it said.
export default function VisitSheet({ merchant, lastVisit, onSave, onClose, canSaveLocation, readOnly }: Props) {
  const [note, setNote] = useState('');
  const [media, setMedia] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [journey, setJourney] = useState<JourneyChoice | undefined>();
  // The cycling onboarding button sits on its own position in the ladder; a tap advances
  // to the next stage. Once the user commits a stage (via "select" on the cycler, or by
  // tapping Accepting / Closed), `journey` holds the chosen value and overrides the local
  // cycle. The cycle starts at Lead each time the sheet opens — not persisted.
  const [onboardingIdx, setOnboardingIdx] = useState(0);
  const cycleJourney = ONBOARDING_LADDER[onboardingIdx];
  const onboardingSelected = journey !== undefined && (ONBOARDING_LADDER as JourneyChoice[]).includes(journey);
  // Starts at the merchant's current flag: untick to clear it, tick to set it.
  const [followUp, setFollowUp] = useState(merchant.needsFollowUp);
  // A position for a merchant that has none, from the phone's GPS. Never replaces one.
  const missingLocation = canSaveLocation && (merchant.lat === null || merchant.lon === null);
  const [position, setPosition] = useState<{ lat: number; lon: number; accuracy?: number } | null>(null);
  const [positionErr, setPositionErr] = useState('');
  // Where a Relocated business moved to: pinned now, or on a later visit to the new place.
  const relocating = journey === 'relocated' || (journey === undefined && merchant.status === journeyLabel('relocated'));
  const [newPosition, setNewPosition] = useState<{ lat: number; lon: number; accuracy?: number } | null>(null);
  const [newPositionErr, setNewPositionErr] = useState('');
  const dirty =
    note.trim() !== '' || media.length > 0 || !!journey || followUp !== merchant.needsFollowUp || !!position || !!newPosition;

  async function locate(
    set: (p: { lat: number; lon: number; accuracy?: number }) => void,
    setError: (message: string) => void,
  ) {
    setError('');
    setBusy(true);
    try {
      const p = await currentPosition();
      if (validLocation(p.lat, p.lon)) set(p);
      else setError("Couldn't get a real position, try again outside.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      await onSave(note.trim(), {
        journey,
        followUp,
        location: position ? { lat: position.lat, lon: position.lon } : undefined,
        newLocation: relocating && newPosition ? { lat: newPosition.lat, lon: newPosition.lon } : undefined,
      });
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
                <button disabled={busy} onClick={() => locate(setPosition, setPositionErr)}>📍 Use my position here</button>
              </>
            )}
            {positionErr && <p className="error">{positionErr}</p>}
          </div>
        )}

        <div className="row journey">
          <button
            className={onboardingSelected ? 'on' : ''}
            aria-pressed={onboardingSelected}
            onClick={() => {
              if (onboardingSelected) {
                // Already picked an onboarding status — one tap advances the cycle and
                // keeps it committed, so the newly-shown stage is what will be written.
                const next = (onboardingIdx + 1) % ONBOARDING_LADDER.length;
                setOnboardingIdx(next);
                setJourney(ONBOARDING_LADDER[next]);
                return;
              }
              // First tap: commit the current cycle position as the chosen stage.
              setJourney(cycleJourney);
            }}
            onContextMenu={(e) => {
              // Long-press / right-click clears the selection and advances the preview,
              // in case you tapped the wrong stage. KISS: no gesture docs, just works.
              e.preventDefault();
              setJourney(undefined);
              setOnboardingIdx((i) => (i + 1) % ONBOARDING_LADDER.length);
            }}
          >
            {JOURNEY_EMOJI[onboardingSelected ? (journey as JourneyChoice) : cycleJourney]}{' '}
            {journeyLabel(onboardingSelected ? (journey as JourneyChoice) : cycleJourney)}
          </button>
          <button
            className={journey === 'closed' ? 'on bad' : ''}
            aria-pressed={journey === 'closed'}
            onClick={() => {
              if (journey === 'closed') return setJourney(undefined);
              if (
                confirm(
                  'This removes the business from the map.\n\nA closed business no longer exists: its OpenStreetMap and BTC Map listing is deleted.',
                )
              ) {
                setJourney('closed');
              }
            }}
          >
            {JOURNEY_EMOJI.closed} Closed
          </button>
          <button
            className={journey === 'relocated' ? 'on' : ''}
            aria-pressed={journey === 'relocated'}
            onClick={() => setJourney((j) => (j === 'relocated' ? undefined : 'relocated'))}
          >
            {JOURNEY_EMOJI.relocated} Relocated
          </button>
        </div>
        {relocating && (
          <div className="location">
            {newPosition ? (
              <p className="position">
                <span>
                  {JOURNEY_EMOJI.relocated} New location {newPosition.lat.toFixed(5)}, {newPosition.lon.toFixed(5)}
                  {newPosition.accuracy !== undefined && ` (±${Math.round(newPosition.accuracy)} m)`}
                </span>
                <button className="ghost small" aria-label="Drop the new location" onClick={() => setNewPosition(null)}>✕</button>
              </p>
            ) : (
              <>
                <p className="muted small">{JOURNEY_EMOJI.relocated} Moved: pin the new location when you're there.</p>
                <button disabled={busy} onClick={() => locate(setNewPosition, setNewPositionErr)}>📍 Pin new location here</button>
              </>
            )}
            {newPositionErr && <p className="error">{newPositionErr}</p>}
          </div>
        )}
        <label className="followup">
          <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
          ⚠️ Needs follow-up
        </label>

        {merchant.fieldNotes && (
          <div className="prior-notes small muted" aria-label="Earlier notes">
            <strong>Earlier notes</strong>
            <pre>{merchant.fieldNotes}</pre>
          </div>
        )}

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

        {readOnly && <p className="small muted">👁 {VIEW_ONLY}</p>}
        <button className="primary" disabled={busy || readOnly} onClick={save}>
          Check in &amp; save ({today()})
        </button>
      </div>
    </div>
  );
}
