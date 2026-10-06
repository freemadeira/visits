export const APP_NAME = 'Visitas';

// FreeHub's team relay: Haven's *private* relay (NIP-42 AUTH + whitelist). The relay
// root is Haven's public outbox relay — not the one FreeHub uses.
export const TEAM_RELAYS = ['wss://relay.freemadeira.org/private'];

// The FreeHub CRM table the app works on (the "Merchant adoption" pack's table).
export const MERCHANTS_SLUG = 'merchants';

// NIP-46 relays for Amber / bunker traffic when not using Amber on the phone (NIP-55).
// (Not relay.nsec.app: it needs NIP-42 auth and the connect sub silently gets nothing.)
export const NIP46_RELAYS = ['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.primal.net'];

// Default "nearby" radius for urgent-flag highlighting and nearby-first ordering.
export const DEFAULT_RADIUS_KM = 0.5;

// One colour per urgent flag, assigned least-used first; repeats after 6.
export const PALETTE = ['#f7931a', '#4fc3f7', '#ef5350', '#66bb6a', '#ba68c8', '#ffee58'];
export const PALETTE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Suggested trip size (Zapa picks 4–7). Shown, not enforced.
export const TRIP_MIN = 4;
export const TRIP_MAX = 7;

// Visit heat (merchants should be visited monthly): days since the latest team visit.
// Green ≤ 7, yellow ≤ 14, orange ≤ 30 (Zapa didn't name this band — confirm), red after
// that or never.
export const HEAT = [
  { maxDays: 7, color: '#66bb6a', label: 'this week' },
  { maxDays: 14, color: '#ffee58', label: '2 weeks' },
  { maxDays: 30, color: '#ffa726', label: 'this month' },
  { maxDays: Infinity, color: '#ef5350', label: 'over a month' },
] as const;
export const HEAT_NEVER = { color: '#ef5350', label: 'never' };
