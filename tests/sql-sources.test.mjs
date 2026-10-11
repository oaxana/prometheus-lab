// Source/voice model: uploader, raw source and contributor identity stay distinct.
import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE, BOB } from './sql-setup.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
await installSchema(db); // Includes a second run: migration must be idempotent.

const source = async (o) => (await db.query(
  `select public.submit_source($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14) id`,
  [o.type, o.title, o.raw, null, o.audio ?? null, o.file ?? null, o.fileName ?? null, o.mode ?? 'text',
    JSON.stringify(o.people ?? []), JSON.stringify(o.rows ?? []), o.test ?? false, o.anonymous ?? true, o.discovery ?? null, o.label ?? null]
)).rows[0].id;

await asUser(db, ALICE);
const transcriptRaw = 'Participant A: Consent must be explicit.\nParticipant B: Make opt-out practical.\nParticipant A: And visible.';
const transcript = await source({
  type: 'transcript', title: 'Workshop transcript, Oct 1 2026', raw: transcriptRaw, mode: 'upload', label: 'Workshop transcript',
  people: [{ label: 'Participant A', detected: true }, { label: 'Participant B', detected: true }],
  rows: [
    { content: 'Consent must be explicit. And visible.', summary: 'A', pillars: [1], labels: ['Participant A'] },
    { content: 'Make opt-out practical.', summary: 'B', pillars: [1], labels: ['Participant B'] },
  ],
});
check('transcript source is created by its uploader', !!transcript);

await asOwner(db);
const src = (await db.query('select * from sources where id=$1', [transcript])).rows[0];
const speakers = (await db.query(`select source_label, contributor_id, detected_from_source, identity_confirmed from source_contributors where source_id=$1 order by position`, [transcript])).rows;
const tRows = (await db.query('select id, participant_id, content, source_id from submissions where source_id=$1 order by content', [transcript])).rows;
const links = (await db.query(`select sc.source_label from submission_contributors jc join source_contributors sc on sc.id=jc.source_contributor_id where sc.source_id=$1 order by sc.source_label`, [transcript])).rows;
check('raw transcript is retained unchanged on the source', src.raw_content === transcriptRaw && src.source_type === 'transcript' && src.title === 'Workshop transcript, Oct 1 2026');
check('uploader is recorded separately from its speakers', src.uploader_participant_id === ALICE && speakers.every((s) => s.contributor_id === null));
check('detected labels remain distinct, local and unconfirmed', speakers.map((s) => s.source_label).join('|') === 'Participant A|Participant B' && speakers.every((s) => s.detected_from_source && !s.identity_confirmed));
check('one derived row per transcript speaker links back to the same source', tRows.length === 2 && tRows.every((r) => r.source_id === transcript && r.participant_id === ALICE) && links.map((r) => r.source_label).join('|') === 'Participant A|Participant B');
await asUser(db, ALICE);
check('source tables cannot be read directly by a browser role', await blocked(() => db.query('select * from sources')));

const authored = async (title, raw) => source({
  type: 'document', title, raw, mode: 'upload', label: 'Paper', people: [{ label: "Aza O'Leary" }],
  rows: [{ content: raw, summary: 'paper summary', pillars: [3], labels: ["Aza O'Leary"] }],
});
const paper1 = await authored('Paper one', 'First paper source text.');
const paper2 = await authored('Paper two', 'Second paper source text.');
await asOwner(db);
const aza = (await db.query(`select id, display_name from contributors where identity_key='author:aza o''leary'`)).rows;
const azaLinks = (await db.query(`select sc.source_id, sc.contributor_id from source_contributors sc join sources src on src.id=sc.source_id where src.id in ($1,$2) and sc.contributor_role='author' order by sc.source_id`, [paper1, paper2])).rows;
check('two explicitly attributed documents reuse one author contributor', aza.length === 1 && aza[0].display_name === "Aza O'Leary" && azaLinks.length === 2 && azaLinks.every((r) => r.contributor_id === aza[0].id));

await asUser(db, ALICE);
const coauthored = await source({
  type: 'document', title: 'Co-authored note', raw: 'A joint source.', people: [{ label: "Aza O'Leary" }, { label: 'Rebecca Ray' }],
  rows: [{ content: 'A joint source.', summary: 'joint', pillars: [4], labels: ["Aza O'Leary", 'Rebecca Ray'] }],
});
await asOwner(db);
const coLinks = (await db.query(`select sc.source_label from submission_contributors jc join source_contributors sc on sc.id=jc.source_contributor_id join submissions s on s.id=jc.submission_id where s.source_id=$1 order by sc.source_label`, [coauthored])).rows;
check('one co-authored document has one derived row with both authors', coLinks.map((r) => r.source_label).join('|') === "Aza O'Leary|Rebecca Ray");

await asUser(db, ALICE);
const transcriptRow = tRows[0].id;
const edit = (await db.query(`select public.update_my_submission($1,'tampered','x','x') ok`, [transcriptRow])).rows[0].ok;
const remove = (await db.query('select public.delete_my_submission($1) ok', [transcriptRow])).rows[0].ok;
check('derived transcript rows cannot be edited or deleted independently', edit === false && remove === false);
check('unknown transcript contributor cannot be attached to a row', await blocked(() => source({
  type: 'transcript', title: 'Bad source', raw: 'A: x', people: [{ label: 'Participant A', detected: true }],
  rows: [{ content: 'x', summary: 'x', pillars: [1], labels: ['Participant B'] }],
})));

await asUser(db, BOB);
const publicRows = (await db.query(`select source_type, source_title, voice_labels, content from public.list_submissions(null) where source_title='Workshop transcript, Oct 1 2026'`)).rows;
check('public list exposes source metadata and labels but never raw content', publicRows.length === 2 && publicRows.every((r) => r.source_type === 'transcript' && r.voice_labels.length === 1 && r.content === null));

console.log(`\n${pass}/${total} passed`);
