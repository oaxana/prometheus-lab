import { PGlite } from '@electric-sql/pglite';
import { installSchema, asUser, asOwner, ALICE, BOB } from './sql-setup.mjs';

const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
await installSchema(db);

const saveName = async (name) => (await db.query(`select public.set_my_display_name($1) name`, [name])).rows[0].name;
const submit = async (anonymous, content = 'a position') => (await db.query(`select public.submit_submission('{1,12}',$1,'summary',false,false,$2) id`, [content, anonymous])).rows[0].id;

await asUser(db, null);
let unauthBlocked = false;
try { await submit(true); } catch { unauthBlocked = true; }
check('unauthenticated participant cannot create production submission', unauthBlocked);

await asUser(db, ALICE);
check('authenticated participant can save one display name', (await saveName('Alex')) === 'Alex');
const namedId = await submit(false, 'Alice named');
const anonId = await submit(true, 'Alice anonymous');
await asOwner(db);
const aliceRows = (await db.query('select id,participant_id,uid,display_name from submissions where participant_id=$1 order by display_name', [ALICE])).rows;
check('submission ownership is derived from auth.uid()', aliceRows.length === 2 && aliceRows.every(r => r.participant_id === ALICE && r.uid === null));
check('anonymous row stores no public name', aliceRows.some(r => r.id === anonId && r.display_name === ''));
check('named row uses saved name', aliceRows.some(r => r.id === namedId && r.display_name === 'Alex'));

await asUser(db, BOB);
await saveName('Alex');
const bobId = await submit(false, 'Bob named');
check('duplicate display names are allowed', !!bobId);
const bobView = (await db.query('select id,mine,content from public.list_submissions(null)')).rows;
check("participant B cannot read participant A's raw text", bobView.filter(r => r.id !== bobId).every(r => !r.mine && r.content === null));

await saveName('Bob New Name');
await asOwner(db);
check('editing saved name updates that participant named rows', (await db.query('select display_name from submissions where id=$1', [bobId])).rows[0].display_name === 'Bob New Name');
await asUser(db, null);
const publicRows = (await db.query('select id,display_name,mine,content from public.list_submissions(null)')).rows;
check('public listing exposes summary metadata but never participant identity/raw text', publicRows.every(r => !r.mine && r.content === null) && publicRows.find(r => r.id === anonId).display_name === '');

let directInsertBlocked = false;
await asUser(db, ALICE);
try { await db.query(`insert into submissions(pillars,content,summary,participant_id) values ('{1}','forged','s',$1)`, [BOB]); } catch { directInsertBlocked = true; }
check('authenticated browser cannot forge participant_id with direct insert', directInsertBlocked);
await asOwner(db);
const columns = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='participants'`)).rows.map(r => r.column_name);
check('participants table stores no email address', !columns.includes('email'));
console.log(`\n${pass}/${total} passed`);
