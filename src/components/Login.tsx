import { useEffect, useRef, useState } from 'react';
import {
  hasAndroidSigner,
  hasExtension,
  loginAndroidSigner,
  loginBunker,
  loginExtension,
  startNostrConnect,
  type Signer,
} from '../lib/signer.ts';

interface Props {
  onSigner: (s: Signer) => void;
  error?: string;
}

export default function Login({ onSigner, error }: Props) {
  const [err, setErr] = useState(error ?? '');
  const [busy, setBusy] = useState(false);
  const [bunker, setBunker] = useState('');
  const [connectUri, setConnectUri] = useState('');
  const [androidSigner, setAndroidSigner] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    hasAndroidSigner().then(setAndroidSigner);
  }, []);

  async function run(fn: () => Promise<Signer>) {
    setErr('');
    setBusy(true);
    try {
      onSigner(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function signerApp() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { uri, signer } = startNostrConnect(controller.signal);
    setConnectUri(uri);
    window.location.href = uri; // opens Amber when it's on this device
    run(() => signer);
  }

  return (
    <main className="center">
      <div className="card">
        <h1>Visitas</h1>
        <p className="muted">Log in with a whitelisted npub.</p>

        {androidSigner && (
          <>
            <button className="primary" disabled={busy} onClick={() => run(loginAndroidSigner)}>
              Amber on this phone
            </button>
            <p className="hint">Signs on the phone itself — no internet needed.</p>
          </>
        )}

        {!androidSigner && (
          <>
            <button className="primary" disabled={busy || !hasExtension()} onClick={() => run(loginExtension)}>
              Browser extension
            </button>
            {!hasExtension() && <p className="hint">No NIP-07 extension found in this browser.</p>}
          </>
        )}

        <button className={androidSigner ? 'ghost' : 'primary'} disabled={busy && !connectUri} onClick={signerApp}>
          Signer app over relays (Amber / bunker)
        </button>
        {connectUri && (
          <div className="hint">
            Waiting for approval…{' '}
            <a href={connectUri}>open signer again</a>
            {' · '}
            <button className="link" onClick={() => navigator.clipboard?.writeText(connectUri)}>
              copy nostrconnect link
            </button>
          </div>
        )}

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => loginBunker(bunker));
          }}
        >
          <input
            value={bunker}
            onChange={(e) => setBunker(e.target.value)}
            placeholder="bunker://… or nbunksec…"
            autoComplete="off"
            spellCheck={false}
          />
          <button className="ghost" disabled={busy || !bunker.trim()}>Connect</button>
        </form>

        {err && <p className="error">{err}</p>}
      </div>
    </main>
  );
}
