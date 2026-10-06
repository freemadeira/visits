// The app's live connection to FreeHub: the last good copy opens instantly (offline
// too), a fresh load replaces it when a team relay answers, and everything the app
// signs waits in an outbox until a relay accepts it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { type Access, cache, DeniedError, outbox, resolve, TeamRelays } from './freehub.ts';
import type { Signer } from './signer.ts';

const RETRY_MS = 30_000;

export function useFreeHub(signer: Signer, pubkey: string) {
  const [events, setEvents] = useState<NostrEvent[]>(() => cache.get(pubkey)?.events ?? []);
  const [pending, setPending] = useState<NostrEvent[]>(() => outbox.list(pubkey));
  const [access, setAccess] = useState<Access>('connecting');
  const [loadedAt, setLoadedAt] = useState<number | undefined>(() => cache.get(pubkey)?.at);
  const [error, setError] = useState('');
  const relays = useRef<TeamRelays | null>(null);
  const loading = useRef(false);

  const flush = useCallback(async () => {
    const r = relays.current;
    if (!r) return;
    for (const e of outbox.list(pubkey)) {
      if (await r.publish(e).catch(() => false)) {
        outbox.remove(pubkey, e.id);
        setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
      }
    }
    setPending(outbox.list(pubkey));
  }, [pubkey]);

  const refresh = useCallback(async () => {
    const r = relays.current;
    if (!r || loading.current) return;
    loading.current = true;
    setAccess((a) => (a === 'online' ? a : 'connecting'));
    try {
      const fresh = await r.load(pubkey);
      setEvents(fresh);
      cache.set(pubkey, fresh);
      setLoadedAt(Date.now());
      setAccess('online');
      setError('');
      await flush();
    } catch (e) {
      setAccess(e instanceof DeniedError ? 'denied' : 'offline');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loading.current = false;
    }
  }, [pubkey, flush]);

  useEffect(() => {
    relays.current = new TeamRelays(signer, pubkey);
    refresh();
    // Retry anything still waiting: a reload also reconnects, re-AUTHs and flushes.
    const timer = setInterval(() => {
      if (outbox.list(pubkey).length) void refresh();
    }, RETRY_MS);
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      relays.current?.close();
      relays.current = null;
    };
  }, [signer, pubkey, refresh]); // one connection per login (refresh only changes with pubkey)

  /** Sign with the user's signer, queue, and try to send right away. */
  const publish = useCallback(
    async (template: EventTemplate) => {
      const signed = await signer.signEvent(template);
      outbox.add(pubkey, signed);
      setPending(outbox.list(pubkey));
      void flush();
      return signed;
    },
    [signer, pubkey, flush],
  );

  // What's shown: the relay's copy plus anything still in the outbox (optimistic).
  const resolution = useMemo(() => {
    const ids = new Set(events.map((e) => e.id));
    return resolve([...events, ...pending.filter((e) => !ids.has(e.id))], pubkey);
  }, [events, pending, pubkey]);

  return { resolution, access, error, pending: pending.length, loadedAt, refresh, publish, hasData: events.length > 0 };
}
