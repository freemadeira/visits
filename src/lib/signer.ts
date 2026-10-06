// Nostr login: NIP-55 (Amber on this phone, in the sideloaded APK — no relays, works
// offline), NIP-07 extension, or NIP-46 remote signer (Amber / bunker over relays).
// NIP-07/46 follow apps/raffle — applesauce-signers, explicit pool bindings.
//
// The app asks a signer for its pubkey and to sign three kinds: NIP-42 AUTH (22242)
// for the team relay, FreeHub visits (1111) and Merchants records (30306).

import { Capacitor, registerPlugin } from '@capacitor/core';
import { RelayPool } from 'applesauce-relay';
import { ExtensionSigner, NostrConnectSigner, PrivateKeySigner } from 'applesauce-signers';
import * as nip19 from 'nostr-tools/nip19';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { APP_NAME, NIP46_RELAYS } from '../config.ts';

export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  close(): Promise<void>;
}

/** Kinds the app signs — asked for up front so Amber can remember them. */
export const SIGN_KINDS = [22242, 1111, 30306];

const pool = new RelayPool();
// The explicit method bindings are what actually works in applesauce v6 —
// setting `NostrConnectSigner.pool` alone does not (found in apps/raffle).
NostrConnectSigner.subscriptionMethod = pool.subscription.bind(pool);
NostrConnectSigner.publishMethod = pool.publish.bind(pool);

const PERMISSIONS = ['get_public_key', ...NostrConnectSigner.buildSigningPermissions(SIGN_KINDS)];

// Persisted login, this device only. For NIP-46 it holds the nbunksec — a
// session credential (client key + bunker secret), not the user's nsec.
// Logout clears it.
const LS_SESSION = 'visit-tracker.session';
type Session =
  | { type: 'extension' }
  | { type: 'nip46'; nbunksec: string }
  | { type: 'nip55'; pubkey: string; package: string };

function saveSession(s: Session) {
  try {
    localStorage.setItem(LS_SESSION, JSON.stringify(s));
  } catch {
    /* storage blocked — login just won't survive a reload */
  }
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(LS_SESSION);
  } catch {
    /* nothing to clear */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// --- NIP-07 ----------------------------------------------------------------

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && 'nostr' in window;
}

function wrapExtension(ext: ExtensionSigner): Signer {
  return {
    getPublicKey: () => ext.getPublicKey(),
    signEvent: (t) => ext.signEvent(t),
    close: async () => {},
  };
}

export async function loginExtension(): Promise<Signer> {
  const signer = wrapExtension(new ExtensionSigner());
  await signer.getPublicKey();
  saveSession({ type: 'extension' });
  return signer;
}

// --- NIP-46 ----------------------------------------------------------------

function wrapRemote(remote: NostrConnectSigner): Signer {
  return {
    getPublicKey: () => remote.getPublicKey(),
    // A reply can get lost while this app is in the background (e.g. while you're in
    // Amber) — don't wait forever.
    signEvent: (t) =>
      withTimeout(remote.signEvent(t), 90_000, 'Signer').catch((e) => {
        throw new Error(`${e instanceof Error ? e.message : e} — open your signer, approve the request, then try again.`);
      }),
    close: async () => {
      try {
        await withTimeout(remote.logout(), 3000, 'logout');
      } catch {
        await remote.close();
      }
    },
  };
}

/**
 * Re-handshake a stored session. Amber answers a repeat `connect` with
 * "already connected" and applesauce rethrows it (and closes) — that reply
 * means the session is fine, so reopen and carry on.
 */
async function reconnect(remote: NostrConnectSigner): Promise<void> {
  try {
    await withTimeout(remote.connect(undefined, PERMISSIONS), 20_000, 'Signer connect');
  } catch (e) {
    if (!/already connected/i.test(String(e))) throw e;
    remote.isConnected = true;
    await remote.open();
  }
}

/** Paste path: a `bunker://` URI or an `nbunksec` session. */
export async function loginBunker(credential: string): Promise<Signer> {
  const cred = credential.trim();
  let remote: NostrConnectSigner;
  if (cred.startsWith('nbunksec')) {
    const p = NostrConnectSigner.parseNbunksec(cred);
    remote = new NostrConnectSigner({
      relays: p.relays.length ? p.relays : NIP46_RELAYS,
      remote: p.remote,
      signer: new PrivateKeySigner(hexToBytes(p.clientKey)),
      bunkerSecret: p.bunkerSecret,
    });
  } else if (cred.startsWith('bunker://')) {
    const p = NostrConnectSigner.parseBunkerURI(cred);
    remote = new NostrConnectSigner({
      relays: p.relays.length ? p.relays : NIP46_RELAYS,
      remote: p.remote,
      bunkerSecret: p.bunkerSecret,
    });
  } else {
    throw new Error('Paste a bunker:// URI or an nbunksec.');
  }
  await reconnect(remote);
  await remote.getPublicKey();
  saveSession({ type: 'nip46', nbunksec: remote.getNbunksec() });
  return wrapRemote(remote);
}

/**
 * Client-initiated path (nostrconnect://) — the phone case: the link opens
 * Amber on the same device. Returns the URI right away (to show / reopen)
 * and a promise that resolves once the signer approves.
 */
export function startNostrConnect(abort: AbortSignal): { uri: string; signer: Promise<Signer> } {
  const remote = new NostrConnectSigner({ relays: NIP46_RELAYS });
  const uri = remote.getNostrConnectURI({ name: APP_NAME, permissions: PERMISSIONS });
  const signer = (async () => {
    await remote.waitForSigner(abort);
    await remote.getPublicKey();
    saveSession({ type: 'nip46', nbunksec: remote.getNbunksec() });
    return wrapRemote(remote);
  })();
  return { uri, signer };
}

// --- NIP-55 (sideloaded APK only) -------------------------------------------

interface AmberSignerPlugin {
  isInstalled(): Promise<{ installed: boolean }>;
  getPublicKey(o: { permissions?: string }): Promise<{ pubkey: string; package: string }>;
  signEvent(o: { event: string; currentUser: string; package: string }): Promise<{ event: string }>;
}
const AmberSigner = registerPlugin<AmberSignerPlugin>('AmberSigner');

/** True in the APK when Amber (or another NIP-55 signer) is installed on the phone. */
export async function hasAndroidSigner(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await AmberSigner.isInstalled()).installed;
  } catch {
    return false;
  }
}

function wrapNip55(pubkey: string, pkg: string): Signer {
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (t) => {
      const unsigned = { ...t, pubkey };
      const r = await AmberSigner.signEvent({ event: JSON.stringify(unsigned), currentUser: pubkey, package: pkg });
      return JSON.parse(r.event) as NostrEvent;
    },
    close: async () => {},
  };
}

export async function loginAndroidSigner(): Promise<Signer> {
  const r = await AmberSigner.getPublicKey({
    permissions: JSON.stringify(SIGN_KINDS.map((kind) => ({ type: 'sign_event', kind }))),
  });
  // NIP-55 says hex; some signer versions return an npub.
  const pubkey = r.pubkey.startsWith('npub') ? (nip19.decode(r.pubkey).data as string) : r.pubkey;
  saveSession({ type: 'nip55', pubkey, package: r.package });
  return wrapNip55(pubkey, r.package);
}

// --- restore ---------------------------------------------------------------

/** Resume the stored login, if any. Throws if it no longer works. */
export async function restoreSession(): Promise<Signer | null> {
  const s = loadSession();
  if (!s) return null;
  if (s.type === 'extension') {
    if (!hasExtension()) return null;
    return wrapExtension(new ExtensionSigner());
  }
  // NIP-55: stored pubkey + package, so no signer round-trip until a decrypt.
  if (s.type === 'nip55') return wrapNip55(s.pubkey, s.package);
  return loginBunker(s.nbunksec);
}
