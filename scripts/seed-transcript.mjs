// Seeds the anonymized workshop voices (seed/workshop-2026-10-01.json) as ONE submission per speaker,
// so the normal synthesis treats them as separate participants.
//
//   node scripts/seed-transcript.mjs                                     # print the seed content only (no database)
//   node --env-file=.env.local scripts/seed-transcript.mjs --insert      # insert (refuses if already seeded)
//   node --env-file=.env.local scripts/seed-transcript.mjs --replace     # delete earlier seeded rows, then insert
//
// Rows are ordinary, non-test submissions with no Auth participant: uid "seed-workshop-2026-10-01-<letter>" groups
// and counts each voice, display_name is its "Participant X" label, and contribution_type records the source
// (there is no source column). created_at follows label order, so synthesis's own run-local labels
// (A, B, C… by date) match the labels used inside the texts.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const FILE = path.resolve(import.meta.dirname, '..', 'seed', 'workshop-2026-10-01.json');
const UID_PREFIX = 'seed-workshop-2026-10-01-';
const mode = process.argv.includes('--replace') ? 'replace' : process.argv.includes('--insert') ? 'insert' : 'print';

const seed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const rows = seed.voices.map((v, i) => {
  const letter = v.label.match(/^Participant ([A-Z])$/)?.[1];
  if (!letter || letter !== String.fromCharCode(65 + i)) throw new Error(`Voice ${i + 1} must be labelled Participant ${String.fromCharCode(65 + i)}.`);
  if (!v.content?.trim() || v.content.length > 6000) throw new Error(`${v.label}: content must be 1 to 6,000 characters (the synthesis limit).`);
  if (!v.summary?.trim() || v.summary.length > 2000) throw new Error(`${v.label}: summary must be 1 to 2,000 characters.`);
  if (!v.pillars?.length || !v.pillars.every((n) => Number.isInteger(n) && n >= 1 && n <= 12)) throw new Error(`${v.label}: pillars must be ids 1-12.`);
  return {
    pillars: [...new Set(v.pillars)].sort((a, b) => a - b),
    content: v.content.trim(),
    summary: v.summary.trim(),
    auto_tagged: false,
    is_test: false,
    participant_id: null,
    uid: UID_PREFIX + letter.toLowerCase(),
    display_name: v.label,
    contribution_type: seed.source,
    input_mode: 'text',
    pillar_choice: 'selected',
  };
});

for (const r of rows) {
  console.log(`\n=== ${r.display_name}  ·  pillars ${r.pillars.join(', ')}  ·  ${r.content.length} chars`);
  console.log(`SUMMARY: ${r.summary}\n`);
  console.log(r.content);
}
console.log(`\n${rows.length} voices · source "${seed.source}"`);
if (mode === 'print') process.exit(0);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || key.startsWith('PASTE')) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: existing, error: readError } = await db.from('submissions').select('id').like('uid', UID_PREFIX + '%');
if (readError) throw new Error('Could not read submissions: ' + readError.message);
if (existing.length && mode !== 'replace') {
  console.error(`\n${existing.length} seeded row(s) already exist. Nothing inserted. Use --replace to re-seed.`);
  process.exit(1);
}
if (existing.length) {
  const { error } = await db.from('submissions').delete().like('uid', UID_PREFIX + '%');
  if (error) throw new Error('Could not delete earlier seeded rows: ' + error.message);
  console.log(`\nDeleted ${existing.length} earlier seeded row(s).`);
}

// One second apart, in label order, ending now.
const start = Date.now() - rows.length * 1000;
const { error } = await db.from('submissions').insert(rows.map((r, i) => ({ ...r, created_at: new Date(start + i * 1000).toISOString() })));
if (error) throw new Error('Insert failed: ' + error.message);
const { count } = await db.from('submissions').select('id', { count: 'exact', head: true }).like('uid', UID_PREFIX + '%');
console.log(`\nInserted ${rows.length} voices. Seeded rows now in the database: ${count}.`);
