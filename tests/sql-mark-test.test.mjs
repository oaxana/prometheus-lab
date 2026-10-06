import { ROOT } from './lib.mjs';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const db = new PGlite(); let pass = 0, total = 0;
const check = (n, ok, x = '') => { total++; if (ok) pass++; console.log(ok ? 'PASS' : 'FAIL', n, x); };
await db.exec(`create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;`);
const sql = fs.readFileSync(ROOT + '/supabase-setup.sql', 'utf8').replace('create extension if not exists pgcrypto;', '');
await db.exec(sql); await db.exec(sql);
await db.exec('grant all on all tables in schema public to anon, authenticated');
check('setup SQL (with both new functions) runs and re-runs', true);
const alice = 'alice-uid-0001', bob = 'bob-uid-000002';
const ins = (uid, t) => db.query(`insert into submissions(pillars,content,summary,uid) values ('{1}',$1,'s',$2) returning id`, [t, uid]).then(r => r.rows[0].id);
const a1 = await ins(alice, 'alice one'), b1 = await ins(bob, 'bob one');
const flag = async (id, uid, v) => { await db.exec('set role anon'); const r = (await db.query(`select public.set_my_submission_test($1::uuid,$2,$3) as r`, [id, uid, v])).rows[0].r; await db.exec('reset role'); return r; };
const isTest = async (id) => (await db.query('select is_test from submissions where id=$1', [id])).rows[0].is_test;
// what api/synthesize.js would pick up: rows where !is_test
const forSynthesis = async () => (await db.query('select content from submissions where not is_test order by content')).rows.map(r => r.content);

check('starts with both in synthesis', (await forSynthesis()).length === 2);
check("bob cannot mark alice's row", (await flag(a1, bob, true)) === false && (await isTest(a1)) === false);
check('null uid cannot mark', (await flag(a1, null, true)) === false && (await isTest(a1)) === false);
check('alice marks her row as test -> true', (await flag(a1, alice, true)) === true && (await isTest(a1)) === true);
check('marked row drops out of synthesis input', JSON.stringify(await forSynthesis()) === '["bob one"]');
check("bob's row untouched", (await isTest(b1)) === false);
check('alice unmarks -> back in synthesis', (await flag(a1, alice, false)) === true && (await forSynthesis()).length === 2);
check('null flag treated as false (no null in NOT NULL column)', (await flag(a1, alice, null)) === true && (await isTest(a1)) === false);
check('unknown id -> false', (await flag('00000000-0000-0000-0000-000000000000', alice, true)) === false);
await db.exec('set role anon');
let blocked = false; try { const r = await db.query('update submissions set is_test=true where id=$1 returning id', [b1]); blocked = r.rows.length === 0; } catch { blocked = true; }
await db.exec('reset role');
check('anon cannot UPDATE the table directly', blocked && (await isTest(b1)) === false);
const shown = (await (async () => { await db.exec('set role anon'); const r = await db.query('select id, is_test, mine from public.list_submissions($1)', [alice]); await db.exec('reset role'); return r.rows; })());
check('list_submissions reflects flag', shown.length === 2 && shown.every(r => r.is_test === false));
console.log(`\n${pass}/${total} passed`);
