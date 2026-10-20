#!/usr/bin/env node
// Lists the runtime (production) npm dependencies and their licenses, offline,
// by walking node_modules from the workspace package.json files.
// Usage: node scripts/licenses.mjs [--markdown]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const md = process.argv.includes('--markdown');
const seen = new Map();

function readPkg(dir) {
  const file = join(dir, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function find(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir || parent.length < root.length) return null;
    dir = parent;
  }
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (!l) return 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ');
  return l.type ?? 'UNKNOWN';
}

function walk(dir, optional) {
  const pkg = readPkg(dir);
  if (!pkg) return;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    const where = find(name, dir);
    if (!where) {
      if (!(pkg.optionalDependencies ?? {})[name]) console.error(`not installed: ${name}`);
      continue;
    }
    const p = readPkg(where);
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.set(key, { name: p.name, version: p.version, license: licenseOf(p), homepage: p.homepage ?? '' });
    walk(where);
  }
}

const rootPkg = readPkg(root);
for (const pattern of rootPkg.workspaces ?? []) {
  const base = pattern.replace(/\/\*$/, '');
  for (const entry of ['server', 'web', 'media-contract', 'stickers']) {
    const dir = join(root, base, entry);
    if (existsSync(join(dir, 'package.json'))) walk(dir);
  }
}

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
if (md) {
  console.log('| Package | Version | License |\n| --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.name} | ${r.version} | ${r.license} |`);
} else {
  for (const r of rows) console.log(`${r.name}@${r.version}\t${r.license}`);
}
console.error(`${rows.length} packages`);
