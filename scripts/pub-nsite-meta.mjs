// Publishes the nsite discovery metadata (kind 10002 relay list, 10063 Blossom server
// list, kind 0 profile) that `nsyte deploy --sec <nsec>` silently never sends — a
// confirmed nsyte bug through 0.28.1 (see
// research-and-development/nsyte-deploy-discovery-metadata.md). Without these, gateways
// like nsite.run can't discover which relays/servers hold this npub's site and return
// "this nsite doesn't exist yet" even though the site manifest deployed fine.
//
// Run once after any `pnpm deploy` (or whenever .nsite/config.json's relays/servers
// change) — values below must match that file.

// Aliased: oxlint's react-hooks rule mistakes useWebSocketImplementation for a React
// Hook purely from its "use" prefix — it's a plain nostr-tools config function.
import { useWebSocketImplementation as setWebSocketImplementation, SimplePool } from 'nostr-tools/pool';
import WebSocket from 'ws';
setWebSocketImplementation(WebSocket);
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = resolve(ROOT, '.keys');

if (!existsSync(KEYS)) {
  console.error('No .keys file. See Homebase/CLAUDE.md "App-specific keys" to generate one.');
  process.exit(1);
}
const match = readFileSync(KEYS, 'utf8').match(/^NSEC=(\S+)/m);
if (!match) {
  console.error('.keys has no NSEC= line.');
  process.exit(1);
}
const sk = nip19.decode(match[1]).data;
console.log('publishing as', nip19.npubEncode(getPublicKey(sk)));

// Must match .nsite/config.json's relays/servers.
const relays = ['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.primal.net'];
const servers = ['https://blossom.primal.net'];
const now = Math.floor(Date.now() / 1000);

const templates = [
  { kind: 10002, created_at: now, tags: relays.map((r) => ['r', r]), content: '' },
  { kind: 10063, created_at: now, tags: servers.map((s) => ['server', s]), content: '' },
  {
    kind: 0,
    created_at: now,
    tags: [],
    content: JSON.stringify({ name: 'Visitas', about: 'FREE Madeira merchant field-visit tracker.' }),
  },
];

// A relay that's slow/unreachable to connect can emit an 'error' on its underlying
// WebSocket after SimplePool's own timeout already gave up on it — unhandled, that
// crashes the process even though the other relays published fine. Swallow it.
process.on('uncaughtException', (e) => {
  if (!/WebSocket was closed before the connection was established/.test(String(e))) throw e;
});

const pool = new SimplePool();
for (const t of templates) {
  const ev = finalizeEvent(t, sk);
  const res = await Promise.allSettled(
    relays.map((r) => Promise.race([pool.publish([r], ev)[0], new Promise((_, rej) => setTimeout(() => rej('timeout'), 10_000))])),
  );
  console.log(`kind ${ev.kind}: ${res.filter((r) => r.status === 'fulfilled').length}/${relays.length} ok`);
}
await new Promise((r) => setTimeout(r, 2000));
pool.close(relays);
process.exit(0);
