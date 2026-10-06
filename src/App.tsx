// login → FreeHub (team relay, AUTH) → the Merchants list.

import { useEffect, useRef, useState } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import Login from './components/Login.tsx';
import Tracker from './components/Tracker.tsx';
import { clearSession, restoreSession, type Signer } from './lib/signer.ts';
import { useFreeHub } from './lib/useFreeHub.ts';

type View = { step: 'restoring' } | { step: 'login'; error?: string } | { step: 'ready'; signer: Signer; pubkey: string };

export default function App() {
  const [view, setView] = useState<View>({ step: 'restoring' });
  const restored = useRef(false);

  async function enter(signer: Signer) {
    try {
      setView({ step: 'ready', signer, pubkey: await signer.getPublicKey() });
    } catch (e) {
      setView({ step: 'login', error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function logout() {
    clearSession();
    if (view.step === 'ready') await view.signer.close().catch(() => {});
    setView({ step: 'login' });
  }

  useEffect(() => {
    if (restored.current) return; // StrictMode runs effects twice in dev — one reconnect only
    restored.current = true;
    restoreSession()
      .then((s) => (s ? enter(s) : setView({ step: 'login' })))
      .catch(() => {
        clearSession();
        setView({ step: 'login', error: 'Saved login no longer works — log in again.' });
      });
  }, []); // once, on load

  if (view.step === 'restoring') {
    return (
      <main className="center">
        <div className="card">
          <p className="muted">Reconnecting…</p>
          <button className="ghost" onClick={logout}>Cancel</button>
        </div>
      </main>
    );
  }
  if (view.step === 'login') return <Login onSigner={enter} error={view.error} />;
  return <Main signer={view.signer} pubkey={view.pubkey} onLogout={logout} />;
}

function Main({ signer, pubkey, onLogout }: { signer: Signer; pubkey: string; onLogout: () => void }) {
  const hub = useFreeHub(signer, pubkey);

  if (hub.resolution.ok) {
    return (
      <Tracker
        pubkey={pubkey}
        data={hub.resolution.data}
        access={hub.access}
        pending={hub.pending}
        loadedAt={hub.loadedAt}
        onRefresh={hub.refresh}
        publish={hub.publish}
        onLogout={onLogout}
      />
    );
  }

  const message =
    hub.access === 'denied' ? (
      <>
        <h1>Not on the list</h1>
        <p>The team relay doesn't let this npub in. Ask the admin to whitelist it:</p>
        <code className="npub">{npubEncode(pubkey)}</code>
      </>
    ) : hub.access === 'connecting' ? (
      <p className="muted">Loading merchants from FreeHub — approve the login in your signer if it asks…</p>
    ) : hub.access === 'offline' && !hub.hasData ? (
      <>
        <h1>Can't reach FreeHub</h1>
        <p className="muted">{hub.error || 'No connection to the team relay.'}</p>
      </>
    ) : (
      <>
        <h1>No Merchants table yet</h1>
        <p className="muted">
          Create it in FreeHub (New table → Merchant adoption), add the Area, Latitude, Longitude and OSM link fields,
          and import the merchants CSV. Then tap Retry.
        </p>
      </>
    );

  return (
    <main className="center">
      <div className="card">
        {message}
        <button onClick={hub.refresh}>Retry</button>
        <button className="ghost" onClick={onLogout}>Log out</button>
      </div>
    </main>
  );
}
