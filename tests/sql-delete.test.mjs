import { ROOT } from './lib.mjs';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const db = new PGlite();
let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
// Stand-ins for Supabase's built-in roles
await db.exec(`create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;`);
// pgcrypto isn't available in this test engine; gen_random_uuid() is built into Postgres 13+
const sql = fs.readFileSync(ROOT + '/supabase-setup.sql', 'utf8').replace('create extension if not exists pgcrypto;', '');
await db.exec(sql);
await db.exec(sql); // re-running must be safe
// Supabase grants these by default; row-level security is what actually blocks anon
await db.exec('grant all on all tables in schema public to anon, authenticated');
check('setup SQL runs, and re-runs cleanly', true);

const ins = (uid, text) => db.query(`insert into submissions(pillars,content,summary,uid) values ('{1}',$1,'s',$2) returning id`, [text, uid]).then(r => r.rows[0].id);
const alice = 'alice-uid-0001', bob = 'bob-uid-000002';
await db.exec('reset role');
const a1 = await ins(alice, 'alice one'), a2 = await ins(alice, 'alice two'), b1 = await ins(bob, 'bob one');
const del = async (id, uid) => (await db.query(`select public.delete_my_submission($1::uuid,$2) as r`, [id, uid])).rows[0].r;
const count = async () => { await db.exec('reset role'); const c = (await db.query('select count(*)::int c from submissions')).rows[0].c; await db.exec('set role anon'); return c; };

// run as the anon role, like the browser
await db.exec('set role anon');
check('anon can call delete_my_submission', true);
check("bob cannot delete alice's row", (await del(a1, bob)) === false && (await count()) === 3);
check('null uid cannot delete', (await del(a1, null)) === false && (await count()) === 3);
check('empty uid cannot delete', (await del(a1, '')) === false && (await count()) === 3);
check('random id returns false, no error', (await del('00000000-0000-0000-0000-000000000000', alice)) === false);
check('alice deletes her own row -> true', (await del(a1, alice)) === true && (await count()) === 2);
check('deleting twice -> false', (await del(a1, alice)) === false);
const left = (await db.query(`select content, mine from public.list_submissions($1) order by content`, [alice])).rows;
check("alice's other row and bob's row remain", left.length === 2 && left.some(r => r.content === 'alice two') && left.some(r => r.mine === false));
check("bob's row content hidden from alice", left.find(r => r.mine === false).content === null);

// direct table access still blocked for anon
let blocked = false; try { const r = await db.query(`delete from submissions where id=$1 returning id`, [a2]); blocked = r.rows.length === 0; } catch { blocked = true; }
check('anon cannot DELETE the table directly', blocked && (await count()) === 2);
let sel = (await db.query('select * from submissions')).rows.length === 0;
check('anon cannot SELECT the table directly', sel);
console.log(`\n${pass}/${total} passed`);
