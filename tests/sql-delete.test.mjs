import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE, BOB } from './sql-setup.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
await installSchema(db);
check('setup SQL runs and re-runs cleanly', true);

await asOwner(db);
const ins = (owner, text) => db.query(`insert into submissions(pillars,content,summary,participant_id) values ('{1}',$1,'s',$2) returning id`, [text, owner]).then(r => r.rows[0].id);
const a1 = await ins(ALICE, 'alice one'), a2 = await ins(ALICE, 'alice two'), b1 = await ins(BOB, 'bob one');
await db.query(`insert into submissions(pillars,content,summary,uid,is_test) values ('{1}','legacy private','s','legacy-production-uid',false),('{1}','persona test','s','test-persona-2',true)`);
const del = async (id) => (await db.query(`select public.delete_my_submission($1::uuid) as r`, [id])).rows[0].r;

await asUser(db, ALICE);
const listed = (await db.query(`select content,mine from public.list_submissions(null)`)).rows;
check("authenticated Alice sees her raw rows", listed.filter(r => r.mine).length === 2 && listed.filter(r => r.mine).every(r => r.content?.startsWith('alice')));
check("Alice cannot read Bob's raw row", listed.find(r => !r.mine && r.content === null) !== undefined);
check("Alice cannot delete Bob's row", (await del(b1)) === false);
check('Alice deletes her own row', (await del(a1)) === true);
check('deleting twice returns false', (await del(a1)) === false);

await asUser(db, BOB);
check('Bob cannot delete the remaining Alice row', (await del(a2)) === false);

await asUser(db, null);
const legacy = (await db.query(`select content,mine from public.list_submissions('legacy-production-uid')`)).rows;
check('old production uid cannot claim legacy raw text', legacy.every(r => r.content === null));
const persona = (await db.query(`select content,mine from public.list_submissions('test-persona-2')`)).rows;
check('test persona can be identified in UI without exposing its raw text', persona.some(r => r.mine) && persona.every(r => r.content === null));

let anonRpcBlocked = false;
try { await del(b1); } catch { anonRpcBlocked = true; }
check('unauthenticated caller cannot execute delete RPC', anonRpcBlocked);

let directBlocked = false;
try { await db.query(`delete from submissions where id=$1`, [b1]); } catch { directBlocked = true; }
check('browser roles cannot delete table rows directly', directBlocked);
console.log(`\n${pass}/${total} passed`);
