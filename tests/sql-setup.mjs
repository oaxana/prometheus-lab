import fs from 'node:fs';
import { ROOT } from './lib.mjs';

export const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export async function installSchema(db, rerun = true) {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    insert into auth.users(id) values ('${ALICE}'), ('${BOB}');
    grant usage on schema public, auth to anon, authenticated;
  `);
  const sql = fs.readFileSync(ROOT + '/supabase-setup.sql', 'utf8').replace('create extension if not exists pgcrypto;', '');
  await db.exec(sql);
  if (rerun) await db.exec(sql);
  return sql;
}

export async function asUser(db, id) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [id || '']);
  await db.exec(id ? 'set role authenticated' : 'set role anon');
}

export async function asOwner(db) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub','',false)`);
}
