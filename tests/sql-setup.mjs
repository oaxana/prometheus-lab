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
    -- Minimal stand-in for Supabase Storage so the bucket and its policies can be exercised.
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
    $$;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, delete on storage.objects to authenticated;
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
