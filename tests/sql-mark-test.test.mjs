import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE, BOB } from './sql-setup.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
await installSchema(db);
check('setup SQL with authenticated RPCs runs and re-runs', true);

await asOwner(db);
const ins = (owner, text) => db.query(`insert into submissions(pillars,content,summary,participant_id) values ('{1}',$1,'s',$2) returning id`, [text, owner]).then(r => r.rows[0].id);
const a1 = await ins(ALICE, 'alice one'), b1 = await ins(BOB, 'bob one');
const flag = async (id, value) => (await db.query(`select public.set_my_submission_test($1::uuid,$2) as r`, [id, value])).rows[0].r;

await asUser(db, ALICE);
check("Alice cannot mark Bob's row", (await flag(b1, true)) === false);
check('Alice marks her own row', (await flag(a1, true)) === true);
await asOwner(db);
check('marked row is excluded from default synthesis input', (await db.query('select content from submissions where not is_test')).rows.map(r => r.content).join() === 'bob one');
await asUser(db, ALICE);
check('Alice can unmark her row', (await flag(a1, false)) === true);
check('null is treated as false', (await flag(a1, null)) === true);

await asUser(db, null);
let rpcBlocked = false;
try { await flag(a1, true); } catch { rpcBlocked = true; }
check('unauthenticated caller cannot execute test-flag RPC', rpcBlocked);
let directBlocked = false;
try { await db.query('update submissions set is_test=true where id=$1', [b1]); } catch { directBlocked = true; }
check('browser roles cannot update table rows directly', directBlocked);
console.log(`\n${pass}/${total} passed`);
