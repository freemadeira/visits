import type { Merchant } from './freehub.ts';

// A merchant is its FreeHub record id (the `d` tag): stable across versions, members
// and devices.
export const keyOf = (m: Merchant) => m.id;
