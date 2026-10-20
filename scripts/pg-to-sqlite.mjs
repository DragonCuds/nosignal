#!/usr/bin/env node
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
if (flag('--help')) {
  process.stdout.write('Usage: DATABASE_URL=postgres://... node scripts/pg-to-sqlite.mjs [--output PATH] [--dry-run] [--include-sessions]\n');
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const output = resolve(option('--output') ?? resolve(process.env.DATA_DIR ?? resolve(root, 'data'), 'tel.db'));
const dryRun = flag('--dry-run');
const includeSessions = flag('--include-sessions');

const tables = [
  'users', 'sessions', 'chats', 'chat_members', 'encrypted_chat_media', 'messages',
  'sticker_packs', 'stickers', 'user_sticker_packs', 'recent_stickers', 'gifs', 'saved_gifs',
  'user_crypto_identities', 'chat_key_envelopes', 'user_security', 'mfa_enrollments',
  'recovery_codes', 'webauthn_credentials', 'webauthn_challenges', 'message_cipher_ids'
];
const sessionTables = new Set(['sessions', 'mfa_enrollments', 'webauthn_challenges']);
const jsonColumns = new Set(['payload', 'public_jwk', 'tags', 'transports']);
const blobColumns = new Set(['totp_secret_enc', 'secret_enc', 'public_key']);

const psql = (sql) => execFileSync('psql', [databaseUrl, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
  encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});
const sourceHas = (table) => psql(`SELECT to_regclass('public.${table}') IS NOT NULL`).trim() === 't';
const sourceRows = (table) => {
  const outputText = psql(`COPY (SELECT row_to_json(source_row)::text FROM (SELECT * FROM "${table}") source_row) TO STDOUT`);
  return outputText.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const encode = (column, value) => {
  if (value === null || value === undefined) return null;
  if (jsonColumns.has(column)) return JSON.stringify(value);
  if (blobColumns.has(column) && typeof value === 'string' && value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

const selected = tables.filter((table) => includeSessions || !sessionTables.has(table));
const snapshots = [];
for (const table of selected) {
  if (!sourceHas(table)) continue;
  const rows = sourceRows(table);
  snapshots.push({ table, rows });
  process.stdout.write(`source ${table}: ${rows.length}\n`);
}
if (dryRun) {
  process.stdout.write(`dry-run: ${snapshots.reduce((sum, item) => sum + item.rows.length, 0)} rows; no SQLite file written\n`);
  process.exit(0);
}
if (existsSync(output)) throw new Error(`Refusing to overwrite existing SQLite database: ${output}`);
mkdirSync(dirname(output), { recursive: true });
const sqlite = new Database(output);
try {
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(resolve(root, 'apps/server/migrations/001_init.sql'), 'utf8'));
  const triggers = sqlite.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'messages_%'").all();
  for (const trigger of triggers) sqlite.exec(`DROP TRIGGER "${trigger.name}"`);
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const { table, rows } of snapshots) {
      if (table === 'message_cipher_ids') continue;
      const targetColumns = new Set(sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => targetColumns.has(column));
        if (!columns.length) continue;
        const names = columns.map((column) => `"${column}"`).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        sqlite.prepare(`INSERT INTO "${table}" (${names}) VALUES (${placeholders})`)
          .run(...columns.map((column) => encode(column, row[column])));
      }
    }
    const registry = snapshots.find(({ table }) => table === 'message_cipher_ids');
    if (registry) {
      const insert = sqlite.prepare('INSERT OR IGNORE INTO message_cipher_ids (cipher_id, message_id, first_seen_at) VALUES (?, ?, ?)');
      for (const row of registry.rows) insert.run(row.cipher_id, row.message_id, row.first_seen_at);
    } else {
      sqlite.exec(`INSERT OR IGNORE INTO message_cipher_ids (cipher_id, message_id)
                   SELECT cipher_id, id FROM messages WHERE encryption_version = 2 AND cipher_id IS NOT NULL`);
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  for (const trigger of triggers) sqlite.exec(trigger.sql);
  const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`Foreign-key validation failed (${violations.length} violations)`);
  for (const { table, rows } of snapshots) {
    const count = Number(sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count);
    process.stdout.write(`sqlite ${table}: ${count} (source ${rows.length})${count === rows.length ? '' : ' MISMATCH'}\n`);
    if (count !== rows.length) throw new Error(`Row-count mismatch for ${table}`);
  }
  sqlite.pragma('journal_mode = WAL');
  process.stdout.write(`wrote ${output}\n`);
} finally {
  sqlite.close();
}
