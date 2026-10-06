// Build the sideloaded APK and install it on the phone over USB.
// Uses Android Studio's bundled JDK and the SDK in ~/Android/Sdk (same as translator/).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.ANDROID_HOME || resolve(homedir(), 'Android/Sdk');
const JAVA_HOME = process.env.JAVA_HOME || resolve(homedir(), 'android-studio/jbr');
export const ADB = resolve(SDK, 'platform-tools/adb');
const APK = resolve(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk');

export function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

let serial = null;

export function adb(args, opts = {}) {
  return execFileSync(ADB, serial ? ['-s', serial, ...args] : args, { encoding: 'utf8', ...opts });
}

/**
 * One phone connected and authorised, or fail with what to do. Wireless debugging lists
 * the same phone twice (IP:port and an mDNS name); those count as one, and the IP entry
 * is used for every later adb call.
 */
export function requirePhone() {
  if (!existsSync(ADB)) fail(`adb not found at ${ADB}`);
  serial = null;
  const rows = adb(['devices', '-l']).split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  if (rows.some((l) => /\sunauthorized\b/.test(l))) fail('Phone connected but not authorised: accept the USB debugging prompt on the phone.');
  const ready = rows.filter((l) => /\sdevice\b/.test(l)).map((l) => ({
    id: l.split(/\s+/)[0],
    model: (l.match(/model:(\S+)/) || [])[1] ?? '',
    device: (l.match(/device:(\S+)/) || [])[1] ?? '',
  }));
  if (ready.length === 0) fail('No phone found. Plug it in with USB debugging on, or pair over Wi-Fi (Developer options → Wireless debugging).');
  const phones = new Set(ready.map((r) => `${r.model}/${r.device}`));
  if (phones.size > 1) fail('More than one phone connected — disconnect the others.');
  serial = (ready.find((r) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(r.id)) ?? ready[0]).id;
}

export function buildApk() {
  const run = (cmd, args, cwd = ROOT, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
  run('pnpm', ['build']);
  run('npx', ['cap', 'sync', 'android']);
  run('./gradlew', ['assembleDebug', '-q'], resolve(ROOT, 'android'), { ...process.env, JAVA_HOME, ANDROID_HOME: SDK });
  if (!existsSync(APK)) fail('Build finished but no APK found.');
  return APK;
}

export function installApk() {
  requirePhone();
  // -r: replace, keeping the app's data (visits, flags, login).
  console.log(adb(['install', '-r', APK]).trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildApk();
  installApk();
}
