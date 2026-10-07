// Database rules behind the submission wizard: discovery inputs, file paths, ownership, private storage.
import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE, BOB } from './sql-setup.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
await installSchema(db);   // runs the whole setup file twice, so this also proves it is re-runnable
check('setup SQL (with wizard tables, columns and storage policies) runs twice cleanly', true);

const submit = (o = {}) => db.query(
  `select public.submit_submission($1::int[], $2, 'sum', false, $3, $4, $5, $6, $7, $8, $9, $10, $11) id`,
  [o.pillars ?? [1], o.content ?? 'text', o.test ?? false, o.anon ?? true, o.type ?? null, o.mode ?? 'text', o.choice ?? 'selected',
   o.audio ?? null, o.file ?? null, o.fileName ?? null, o.disc ?? null]).then((r) => r.rows[0].id);
const saveDisc = (o = {}) => db.query(`select public.save_discovery_input($1, $2, $3, $4, $5, $6, $7) id`,
  [o.id ?? null, o.text ?? 'what matters', o.type ?? 'text', o.audio ?? null, o.map ? JSON.stringify(o.map) : null, o.anon ?? true, o.test ?? false]).then((r) => r.rows[0].id);

// ---- discovery inputs are private
await asUser(db, ALICE);
const d1 = await saveDisc({ map: { matched: [1], newIdeas: ['x'] } });
check('participant saves a discovery input through the RPC', !!d1);
check('direct reads of discovery inputs are denied', await blocked(() => db.query('select * from pillar_discovery_inputs')));
check('direct inserts into discovery inputs are denied', await blocked(() => db.query(`insert into pillar_discovery_inputs(participant_id,input_text) values ('${ALICE}','x')`)));
await asUser(db, null);
check('anonymous visitors cannot call the discovery RPC', await blocked(() => saveDisc()));
await asUser(db, BOB);
check("another participant cannot update Alice's discovery input", await blocked(() => saveDisc({ id: d1 })));
await asUser(db, ALICE);
const d1b = await saveDisc({ id: d1, text: 'updated answer', map: null });
check('owner can update the same row (id stays, mapping replaced)', d1b === d1);
check('discovery audio must be in your own folder', await blocked(() => saveDisc({ audio: `${BOB}/run/d.webm` })));
await asOwner(db);
const dRow = (await db.query('select * from pillar_discovery_inputs where id=$1', [d1])).rows[0];
check('stored under the caller’s participant id with the new text', dRow.participant_id === ALICE && dRow.input_text === 'updated answer' && dRow.ai_mapping === null);
check('input_type is limited to text/voice', await blocked(() => db.query(`insert into pillar_discovery_inputs(participant_id,input_text,input_type) values ('${ALICE}','x','video')`)));

// ---- submit_submission: new fields + path rules
await asUser(db, ALICE);
const old6 = (await db.query(`select public.submit_submission('{2}','legacy call','s',false,false,true) id`)).rows[0].id;
check('the old six-argument call still works (defaults fill the rest)', !!old6);
const own = `${ALICE}/run1/submission-abc.webm`;
const sid = await submit({ pillars: [1, 3, 7], content: 'hello', type: '  Pilot idea  ', mode: 'voice', audio: own, disc: d1, test: true, anon: true });
check('own storage path accepted', !!sid);
check("someone else's storage path rejected for audio", await blocked(() => submit({ audio: `${BOB}/run/x.webm` })));
check("someone else's storage path rejected for files", await blocked(() => submit({ mode: 'upload', file: `${BOB}/run/x.pdf` })));
check('Google Docs link accepted as file_url', !!(await submit({ mode: 'upload', file: 'https://docs.google.com/document/d/abc/edit', fileName: 'Doc: Plan' })));
check('other https links rejected as file_url', await blocked(() => submit({ mode: 'upload', file: 'https://evil.example.com/x.pdf' })));
check('Google link is NOT allowed as a recording', await blocked(() => submit({ audio: 'https://docs.google.com/document/d/abc/edit' })));
check("cannot link someone else's discovery input", await blocked(async () => { await asUser(db, BOB); await submit({ disc: d1 }); }));
await asUser(db, ALICE);
check('input_mode and pillar_choice are validated', (await blocked(() => submit({ mode: 'hologram' }))) && (await blocked(() => submit({ choice: 'maybe' }))));
const somethingElse = await submit({ pillars: [], choice: 'something_else' });
await asOwner(db);
const row = (await db.query('select * from submissions where id=$1', [sid])).rows[0];
check('wizard fields stored; label trimmed; owner derived from auth', row.contribution_type === 'Pilot idea' && row.input_mode === 'voice' && row.audio_url === own && row.participant_id === ALICE && row.discovery_input_id === d1);
check('discovery input follows the submission’s test + anonymous flags', (await db.query('select is_test, is_anonymous from pillar_discovery_inputs where id=$1', [d1])).rows[0].is_test === true);
check('"something else" is stored with no pillars', (await db.query('select pillars, pillar_choice from submissions where id=$1', [somethingElse])).rows[0].pillar_choice === 'something_else');

// ---- list_submissions: private fields are owner-only
const listOf = async (id) => (await db.query('select * from public.list_submissions(null) where id=$1', [id])).rows[0];
await asUser(db, ALICE);
const mine = await listOf(sid);
check('owner gets text, label, mode and private paths', mine.mine && mine.content === 'hello' && mine.contribution_type === 'Pilot idea' && mine.input_mode === 'voice' && mine.audio_url === own);
await asUser(db, BOB);
const theirs = await listOf(sid);
check('other participants get none of them (but the summary is public)', !theirs.mine && theirs.content === null && theirs.contribution_type === null && theirs.input_mode === null && theirs.audio_url === null && theirs.file_url === null && theirs.file_name === null && theirs.discovery_audio_url === null && theirs.summary === 'sum');
await asUser(db, null);
check('anonymous visitors get none of them either', (await listOf(sid)).audio_url === null);
check('the pillar choice is visible to everyone', (await listOf(somethingElse)).pillar_choice === 'something_else');

// ---- editing
await asUser(db, BOB);
const upd = (id, text = 'new text', type = 'Concern') => db.query(`select public.update_my_submission($1::uuid, $2, 'new summary', $3) r`, [id, text, type]).then((r) => r.rows[0].r);
check("another participant cannot edit Alice's submission", (await upd(sid)) === false);
await asUser(db, null);
check('anonymous visitors cannot call the edit RPC', await blocked(() => upd(sid)));
await asUser(db, ALICE);
check('owner can edit text, summary and label', (await upd(sid, 'edited', '   ')) === true);
const edited = await listOf(sid);
check('edit stored; blank label becomes null; pillars and audio untouched', edited.content === 'edited' && edited.summary === 'new summary' && edited.contribution_type === null && edited.pillars.join() === '1,3,7' && edited.audio_url === own);
check('browser roles still cannot update rows directly', await blocked(() => db.query(`update submissions set content='x'`)));

// ---- test flag + delete carry the discovery input
await asUser(db, ALICE);
await db.query(`select public.set_my_submission_test($1::uuid, false)`, [sid]);
await asOwner(db);
check('unmarking test also unmarks the discovery input', (await db.query('select is_test from pillar_discovery_inputs where id=$1', [d1])).rows[0].is_test === false);
await asUser(db, BOB);
check("another participant cannot delete Alice's submission or its discovery input", (await db.query(`select public.delete_my_submission($1::uuid) r`, [sid])).rows[0].r === false);
await asUser(db, ALICE);
check('owner deletes the submission', (await db.query(`select public.delete_my_submission($1::uuid) r`, [sid])).rows[0].r === true);
await asOwner(db);
check('…and its discovery input goes with it', (await db.query('select count(*)::int n from pillar_discovery_inputs where id=$1', [d1])).rows[0].n === 0);

// ---- storage bucket + policies
const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='submission-files'`)).rows[0];
check('bucket exists, is private, is size-limited and type-limited', bucket && bucket.public === false && Number(bucket.file_size_limit) === 26214400 && bucket.allowed_mime_types.includes('audio/webm') && bucket.allowed_mime_types.includes('application/pdf') && !bucket.allowed_mime_types.includes('text/html'));
await asOwner(db);
await db.query(`insert into storage.objects(bucket_id,name) values ('submission-files','${BOB}/run/bob.pdf')`);
await asUser(db, ALICE);
const put = (name, bucket_id = 'submission-files') => db.query(`insert into storage.objects(bucket_id,name) values ($1,$2)`, [bucket_id, name]);
check('participant can upload into their own folder', !(await blocked(() => put(`${ALICE}/run/a.webm`))));
check("participant cannot upload into someone else's folder", await blocked(() => put(`${BOB}/run/evil.webm`)));
check('participant cannot write files at the bucket root', await blocked(() => put('loose.webm')));
check('participant cannot use a different bucket through these rules', await blocked(() => put(`${ALICE}/run/a.webm`, 'other-bucket')));
const visible = (await db.query(`select name from storage.objects where bucket_id='submission-files'`)).rows.map((r) => r.name);
check("participant sees only their own files, never Bob's", visible.length === 1 && visible[0].startsWith(ALICE));
const del = await db.query(`delete from storage.objects where name=$1 returning 1`, [`${BOB}/run/bob.pdf`]);
check("participant cannot delete someone else's file", del.rows.length === 0);
check('participant can delete their own file', (await db.query(`delete from storage.objects where name=$1 returning 1`, [`${ALICE}/run/a.webm`])).rows.length === 1);
check('files cannot be overwritten (no update policy)', (await db.query(`update storage.objects set name=name where name like '${BOB}%' returning 1`).catch(() => ({ rows: [] }))).rows.length === 0);
await asUser(db, null);
check('anonymous visitors have no access to stored files', await blocked(() => db.query(`select * from storage.objects`)));

console.log(`\n${pass}/${total} passed`);
