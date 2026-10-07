// One-off: back up every row/file the app has stored, and (only with --wipe) delete it all.
// The schema, config, pillars and prompts are untouched.
//
//   node --env-file=.env.local scripts/backup-and-wipe.mjs           # backup + row counts only
//   node --env-file=.env.local scripts/backup-and-wipe.mjs --wipe    # backup, then delete everything
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only; keep them in the git-ignored .env.local).
// The backup goes to backups/<date>.json (+ backups/<date>-files/), which is git-ignored and contains
// private data (raw text, emails). There is deliberately no restore script.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const WIPE = process.argv.includes('--wipe');
const BUCKET = 'submission-files';
const TABLES = ['submissions', 'pillar_discovery_inputs', 'synthesis', 'participants'];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || key.startsWith('PASTE')) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

async function allRows(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await db.from(table).select('*').range(from, from + 999), `read ${table}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function allUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { users: batch } = must(await db.auth.admin.listUsers({ page, perPage: 1000 }), 'list auth users');
    users.push(...batch);
    if (batch.length < 1000) return users;
  }
}

// Storage "folders" come back as entries without an id; walk them recursively.
async function allFiles(prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += 1000) {
    const entries = must(await db.storage.from(BUCKET).list(prefix, { limit: 1000, offset }), `list ${BUCKET}/${prefix}`);
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id) files.push({ path: p, size: e.metadata?.size ?? null, mimetype: e.metadata?.mimetype ?? null, created_at: e.created_at });
      else files.push(...(await allFiles(p)));
    }
    if (entries.length < 1000) return files;
  }
}

async function snapshot() {
  const out = { tables: {} };
  for (const t of TABLES) out.tables[t] = await allRows(t);
  out.authUsers = await allUsers();
  out.storage = { [BUCKET]: await allFiles() };
  return out;
}

function counts(s) {
  const c = Object.fromEntries(TABLES.map((t) => [t, s.tables[t].length]));
  c['auth users'] = s.authUsers.length;
  c[`storage files (${BUCKET})`] = s.storage[BUCKET].length;
  return c;
}

const date = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
// A second run the same day gets a time suffix, so the first backup is never overwritten.
const stamp = fs.existsSync(path.resolve(import.meta.dirname, '..', 'backups', `${date}.json`))
  ? `${date}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`
  : date;
const dir = path.resolve(import.meta.dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });

const before = await snapshot();
const jsonPath = path.join(dir, `${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify({ takenAt: new Date().toISOString(), supabaseUrl: url, ...before }, null, 2));

// Copy the stored files too, so the JSON's paths point at something.
const filesDir = path.join(dir, `${stamp}-files`);
for (const f of before.storage[BUCKET]) {
  const blob = must(await db.storage.from(BUCKET).download(f.path), `download ${f.path}`);
  const dest = path.join(filesDir, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await blob.arrayBuffer()));
}

console.log(`Backup written: backups/${stamp}.json (+ ${before.storage[BUCKET].length} file(s) in backups/${stamp}-files/)`);
console.log('BEFORE:');
console.table(counts(before));

if (!WIPE) {
  console.log('No --wipe flag: nothing was deleted.');
  process.exit(0);
}

const paths = before.storage[BUCKET].map((f) => f.path);
for (let i = 0; i < paths.length; i += 100) must(await db.storage.from(BUCKET).remove(paths.slice(i, i + 100)), 'delete files');
// Submissions first: they reference discovery inputs and participants.
must(await db.from('submissions').delete().not('id', 'is', null), 'delete submissions');
must(await db.from('pillar_discovery_inputs').delete().not('id', 'is', null), 'delete discovery inputs');
must(await db.from('synthesis').delete().not('id', 'is', null), 'delete synthesis');
// Deleting an Auth user also ends its sessions and cascades to its participants row.
for (const u of before.authUsers) must(await db.auth.admin.deleteUser(u.id), 'delete auth user');
must(await db.from('participants').delete().not('id', 'is', null), 'delete participants');

console.log('AFTER:');
console.table(counts(await snapshot()));
