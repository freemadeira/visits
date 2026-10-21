// Deploy dist/ to nsite. Reads the throwaway dev nsec from .keys (gitignored) and passes
// it via --sec so it never touches shell history or a committed config. Builds first.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = resolve(ROOT, '.keys');

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function readNsec() {
  if (!existsSync(KEYS)) fail('No .keys file. See Homebase/CLAUDE.md "App-specific keys" to generate one.');
  const match = readFileSync(KEYS, 'utf8').match(/^NSEC=(\S+)/m);
  if (!match) fail('.keys has no NSEC= line.');
  return match[1];
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

run('pnpm', ['build']);
run('nsyte', ['deploy', 'dist', '--sec', readNsec()]);
