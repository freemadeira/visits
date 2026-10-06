// Home sync for media: phone → PC over adb (USB or wireless debugging).
//   pnpm sync
// Visits and merchants live in FreeHub now; only the work photos and videos
// (Pictures/FREE Madeira/) still come off the phone this way, into
// data/field-sync/media/ (data/ is gitignored — real data), until FreeHub has attachments.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, adb, requirePhone } from './android.mjs';

const PHONE_MEDIA = '/sdcard/Pictures/FREE Madeira';
const DEST = resolve(ROOT, 'data/field-sync/media');

requirePhone();
mkdirSync(DEST, { recursive: true });
try {
  adb(['pull', PHONE_MEDIA, DEST], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('pulled work media → data/field-sync/media/FREE Madeira/');
} catch {
  console.log('no work media on the phone yet');
}
