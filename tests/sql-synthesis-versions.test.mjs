// Synthesis history: the old single synthesis becomes v1, versions can't be changed, and
// browsers can read the published columns but never the provenance (internal ids/keys).
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE } from './sql-setup.mjs';
import { ROOT } from './lib.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
const blocked = async (fn) => { try { await fn(); return false; } catch { return true; } };
const sql = await installSchema(db, false);
const count = async () => (await db.query('select count(*)::int n from synthesis_versions')).rows[0].n;
check('fresh database: no synthesis, so no version is invented', (await count()) === 0);

// The production situation before this migration: seeded voices, one test row, one saved synthesis.
await asOwner(db);
const seeded = [];
for (const l of ['a', 'b', 'c']) {
  seeded.push((await db.query(`insert into submissions(pillars,content,summary,uid,display_name,created_at) values ('{1}','seed '||$1,'s','seed-workshop-2026-10-01-'||$1,'Participant '||upper($1), now() - interval '2 hours') returning id`, [l])).rows[0].id);
}
seeded.push((await db.query(`insert into submissions(pillars,content,summary,participant_id,created_at) values ('{2}','alice one','s',$1, now() - interval '2 hours') returning id`, [ALICE])).rows[0].id);
seeded.push((await db.query(`insert into submissions(pillars,content,summary,participant_id,created_at) values ('{3}','alice two','s',$1, now() - interval '2 hours') returning id`, [ALICE])).rows[0].id);
await db.query(`insert into submissions(pillars,content,summary,participant_id,is_test,created_at) values ('{1}','a test','s',$1,true, now() - interval '2 hours')`, [ALICE]);
await db.query(`insert into synthesis(id,commons,contested,gaps,count,submission_count,included_tests,created_at) values (1,'[{"pillarId":1}]','[]','[{"pillarId":5}]',4,5,false, now() - interval '1 hour')`);
const later = (await db.query(`insert into submissions(pillars,content,summary,participant_id) values ('{4}','after the synthesis','s',$1) returning id`, [ALICE])).rows[0].id;

await db.exec(sql); // the owner runs the updated supabase-setup.sql
const v1 = (await db.query('select * from synthesis_versions')).rows;
check('existing synthesis is preserved as version 1', v1.length === 1 && v1[0].version === 1 && JSON.stringify(v1[0].commons) === '[{"pillarId":1}]' && JSON.stringify(v1[0].gaps) === '[{"pillarId":5}]' && v1[0].voice_count === 4 && v1[0].contribution_count === 5);
check('v1 provenance is marked reconstructed', v1[0].provenance === 'reconstructed' && v1[0].included_tests === false);
check('v1 inputs = the non-test rows that existed when it was saved', [...v1[0].submission_ids].sort().join() === [...seeded].sort().join() && !v1[0].submission_ids.includes(later));
check('v1 voice keys match api/synthesize.js (seed uids + one account)', [...v1[0].voice_keys].sort().join() === ['auth:' + ALICE, 'legacy:seed-workshop-2026-10-01-a', 'legacy:seed-workshop-2026-10-01-b', 'legacy:seed-workshop-2026-10-01-c'].sort().join() && v1[0].source_count === 5);

await db.query(`insert into synthesis_versions(version,commons,voice_count,contribution_count,submission_ids,voice_keys) values (2,'[{"pillarId":7}]',5,6,$1,'{x}')`, [[...seeded, later]]);
await db.exec(sql);
check('re-running the setup adds or changes nothing', (await count()) === 2 && (await db.query('select provenance from synthesis_versions where version=1')).rows[0].provenance === 'reconstructed');
check('a version cannot be updated, even by the owner', await blocked(() => db.query(`update synthesis_versions set commons='[]' where version=1`)));
check('a duplicate version number is refused', await blocked(() => db.query(`insert into synthesis_versions(version) values (2)`)));

for (const who of [null, ALICE]) {
  await asUser(db, who);
  const label = who ? 'signed-in participant' : 'anonymous browser';
  const pub = (await db.query('select version, created_at, commons, contested, gaps, voice_count, contribution_count, source_count, included_tests, provenance from synthesis_versions order by version desc')).rows;
  check(`${label}: can read every version's published columns`, pub.length === 2 && pub[0].version === 2 && pub[1].version === 1);
  check(`${label}: cannot read submission_ids`, await blocked(() => db.query('select submission_ids from synthesis_versions')));
  check(`${label}: cannot read voice_keys or select *`, (await blocked(() => db.query('select voice_keys from synthesis_versions'))) && (await blocked(() => db.query('select * from synthesis_versions'))));
  check(`${label}: cannot insert or delete a version`, (await blocked(() => db.query(`insert into synthesis_versions(version) values (9)`))) && (await blocked(() => db.query('delete from synthesis_versions where version=1'))));
}
await asOwner(db);
check('versions intact after the browser attempts', (await count()) === 2);
check('setup file documents the version table', fs.readFileSync(ROOT + '/supabase-setup.sql', 'utf8').includes('synthesis_versions — immutable history'));

console.log(`\n${pass}/${total} passed`);
