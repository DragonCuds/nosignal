#!/usr/bin/env node
// Opt-in: replace the local TLS CA (TLS_MODE=auto) with a new name-constrained one.
//
//   node scripts/regenerate-ca.mjs --yes [--data-dir /path] [--hosts host1,1.2.3.4]
//
// Defaults come from DATA_DIR and TLS_HOSTS (same as the server). The old CA/cert are moved to
// <data-dir>/tls/backup-<timestamp>/ (mode 0700). Restart the service afterwards, and every phone/PC
// must install https://<server>/ca.crt again. Nothing happens without --yes.
import { resolve } from 'node:path';
import { regenerateLocalCa } from '../apps/server/dist/tls.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(opt('--data-dir') ?? process.env.DATA_DIR ?? resolve(import.meta.dirname, '../data'));
const hosts = (opt('--hosts') ?? process.env.TLS_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
if (!args.includes('--yes')) {
  console.error(`This replaces the local CA under ${dataDir}/tls. Every device must install /ca.crt again.\nRe-run with --yes to continue.`);
  process.exit(2);
}
if (!hosts.length) { console.error('No hosts: pass --hosts or set TLS_HOSTS (names/IPs clients use to reach this server).'); process.exit(2); }
const { backupDir } = regenerateLocalCa(dataDir, hosts);
console.log(`New name-constrained CA created for: ${hosts.join(', ')}`);
if (backupDir) console.log(`Old files kept in ${backupDir}`);
console.log('Restart the service, then reinstall /ca.crt on every phone and computer.');
