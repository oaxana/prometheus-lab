-- ============================================================================
-- Prometheus Lab — Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run.
-- ============================================================================
--
-- Privacy model
--   * The browser uses the public "anon" key, so anything the anon role can
--     read is public. Raw submission text (`content`) and the owner's `uid`
--     must NOT be readable that way.
--   * So: the `submissions` table has RLS on and NO select policy. The browser
--     can INSERT, but can only read through the `list_submissions` function,
--     which returns the public fields for everyone and `content` only for rows
--     whose uid matches the caller's own anonymous ID. `uid` is never returned.
--   * The Vercel `api/synthesize` function uses the service-role key, which
--     bypasses RLS, so it can read every row's content and write the synthesis.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
create table if not exists public.submissions (
  id           uuid primary key default gen_random_uuid(),
  pillars      integer[] not null default '{}',
  content      text      not null check (char_length(content) between 1 and 100000),
  summary      text      not null default '' check (char_length(summary) <= 2000),
  auto_tagged  boolean   not null default false,
  is_test      boolean   not null default false,
  uid          text      not null check (char_length(uid) between 8 and 64),
  display_name text      not null default '' check (char_length(display_name) <= 80),
  created_at   timestamptz not null default now(),
  -- pillar ids must be 1..12
  constraint submissions_pillars_valid
    check (pillars <@ array[1,2,3,4,5,6,7,8,9,10,11,12])
);

create index if not exists submissions_created_at_idx on public.submissions (created_at desc);
create index if not exists submissions_uid_idx        on public.submissions (uid);

alter table public.submissions enable row level security;

drop policy if exists "anyone can submit" on public.submissions;
create policy "anyone can submit"
  on public.submissions
  for insert
  to anon, authenticated
  with check (true);   -- field validation is done by the CHECK constraints above

-- Deliberately NO select / update / delete policies for anon:
-- RLS denies them by default, so `content` and `uid` cannot be read or edited
-- through the REST API.

-- ---------------------------------------------------------------------------
-- list_submissions(p_uid): the only way the browser reads submissions
-- ---------------------------------------------------------------------------
create or replace function public.list_submissions(p_uid text default null)
returns table (
  id           uuid,
  pillars      integer[],
  summary      text,
  auto_tagged  boolean,
  is_test      boolean,
  display_name text,
  "timestamp"  bigint,
  mine         boolean,
  content      text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.pillars,
    s.summary,
    s.auto_tagged,
    s.is_test,
    s.display_name,
    (extract(epoch from s.created_at) * 1000)::bigint as "timestamp",
    (p_uid is not null and s.uid = p_uid)              as mine,
    case when p_uid is not null and s.uid = p_uid then s.content else null end as content
  from public.submissions s
  order by s.created_at desc
  limit 500;
$$;

revoke all on function public.list_submissions(text) from public;
grant execute on function public.list_submissions(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- synthesis (single row, id = 1) — the latest AI synthesis, public to read
-- ---------------------------------------------------------------------------
create table if not exists public.synthesis (
  id              integer primary key default 1 check (id = 1),
  commons         jsonb   not null default '[]'::jsonb,
  contested       jsonb   not null default '[]'::jsonb,
  gaps            jsonb   not null default '[]'::jsonb,
  count           integer not null default 0,
  included_tests  boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table public.synthesis enable row level security;

drop policy if exists "synthesis is public" on public.synthesis;
create policy "synthesis is public"
  on public.synthesis
  for select
  to anon, authenticated
  using (true);

-- No insert / update / delete policies: only the service-role key (used by the
-- api/synthesize function) can write it.
