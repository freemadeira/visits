import { useState } from 'react';
import { currentPosition } from '../lib/field.ts';
import { validLocation, type NewMerchant, type Option } from '../lib/freehub.ts';

interface Props {
  /** The Merchants table's Area options (new areas are added in FreeHub). */
  areas: Option[];
  existingNames: Set<string>;
  onAdd: (m: NewMerchant) => Promise<void>;
  onClose: () => void;
}

export default function AddMerchantSheet({ areas, existingNames, onAdd, onClose }: Props) {
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function locate() {
    setErr('');
    setBusy(true);
    try {
      const p = await currentPosition();
      setLat(String(p.lat));
      setLon(String(p.lon));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const n = name.trim();
    if (!n) return setErr('Name is required.');
    if (existingNames.has(n.toLowerCase())) return setErr('A merchant with this name is already in FreeHub.');
    const la = lat.trim() === '' ? null : Number(lat);
    const lo = lon.trim() === '' ? null : Number(lon);
    if ((la !== null && !Number.isFinite(la)) || (lo !== null && !Number.isFinite(lo)) || (la === null) !== (lo === null)) {
      return setErr('Latitude and longitude must both be numbers (or both empty).');
    }
    if (la !== null && !validLocation(la, lo)) return setErr("That isn't a real position (check latitude and longitude).");
    setBusy(true);
    try {
      await onAdd({ name: n, areaOption: area || undefined, lat: la, lon: lo });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Add merchant</h2>
          <button className="ghost small" onClick={onClose}>Close</button>
        </header>
        <input placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Area…</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        <button disabled={busy} onClick={locate}>📍 Use my location</button>
        <div className="row">
          <input inputMode="decimal" placeholder="lat" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input inputMode="decimal" placeholder="lon" value={lon} onChange={(e) => setLon(e.target.value)} />
        </div>
        <p className="hint">Added to FreeHub's Merchants table as a Lead, owned by you.</p>
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy} onClick={save}>Add</button>
      </div>
    </div>
  );
}
