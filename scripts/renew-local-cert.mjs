#!/usr/bin/env node
// Run during a maintenance window, with ca.key temporarily restored by the
// operator. This replaces only the server certificate; never the trusted CA.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureLocalCertificate } from '../apps/server/dist/tls.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(opt('--data-dir') ?? process.env.DATA_DIR ?? resolve(import.meta.dirname, '../data'));
const hosts = (opt('--hosts') ?? process.env.TLS_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
if (!hosts.length) {
  console.error('No hosts: pass --hosts or set TLS_HOSTS (names/IPs clients use to reach this server).');
  process.exit(2);
}
if (!existsSync(resolve(dataDir, 'tls/ca.crt'))) {
  console.error('Existing CA certificate missing; leaf renewal cannot initialize or replace a CA.');
  process.exit(2);
}
const result = ensureLocalCertificate(dataDir, hosts, { force: true });
if (result.newCa) throw new Error('Unexpected CA replacement during leaf renewal');
console.log('Server certificate renewed under the existing CA. Restart the service to load it.');
