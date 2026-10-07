-- ============================================================================
-- Prometheus Lab — Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Run it BEFORE deploying frontend code that depends on it.
-- ============================================================================
--
-- Identity and privacy model
--   * Supabase Auth owns the private email identity. This schema never copies or
--     exposes email addresses.
--   * public.participants.id is the authenticated user's stable auth.users UUID.
--   * Browsers never supply a participant UUID when creating, reading, changing,
--     or deleting a real submission. Security-definer functions use auth.uid().
--   * Raw submission text and participant ids have no direct browser read path.
--     list_submissions() returns public summaries for everyone and raw text only
--     when participant_id = auth.uid().
--   * uid remains only for preserved historical rows and admin test personas.
--     It does not grant access to a real production submission.
--   * api/synthesize uses the service-role key to read private fields. It replaces
--     ids with ephemeral labels before anything is sent to Claude.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- participants: one lightweight profile per Supabase Auth user
-- ---------------------------------------------------------------------------
create table if not exists public.participants (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.participants enable row level security;

drop policy if exists "participants can read themselves" on public.participants;
create policy "participants can read themselves"
  on public.participants
  for select
  to authenticated
  using (id = auth.uid());

-- Creation and updates happen through the trigger/RPC below, not direct writes.
revoke all on public.participants from anon;
revoke insert, update, delete on public.participants from authenticated;
grant select on public.participants to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.participants (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Also covers Auth users that existed before this schema version was installed.
insert into public.participants (id)
select id from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
create table if not exists public.submissions (
  id             uuid primary key default gen_random_uuid(),
  pillars        integer[] not null default '{}',
  content        text      not null check (char_length(content) between 1 and 100000),
  summary        text      not null default '' check (char_length(summary) <= 2000),
  auto_tagged    boolean   not null default false,
  is_test        boolean   not null default false,
  participant_id uuid references public.participants(id) on delete set null,
  uid            text check (uid is null or char_length(uid) between 8 and 64),
  display_name   text      not null default '' check (char_length(display_name) <= 80),
  created_at     timestamptz not null default now(),
  constraint submissions_pillars_valid
    check (pillars <@ array[1,2,3,4,5,6,7,8,9,10,11,12])
);

-- Idempotent migration from the original browser-uid schema.
alter table public.submissions add column if not exists participant_id uuid;
alter table public.submissions alter column uid drop not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'submissions_participant_id_fkey'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
      add constraint submissions_participant_id_fkey
      foreign key (participant_id) references public.participants(id) on delete set null;
  end if;
end $$;

create index if not exists submissions_created_at_idx  on public.submissions (created_at desc);
create index if not exists submissions_uid_idx         on public.submissions (uid);
create index if not exists submissions_participant_idx on public.submissions (participant_id);

alter table public.submissions enable row level security;

-- Remove the old policy that let any holder of the public anon key insert rows.
drop policy if exists "anyone can submit" on public.submissions;
revoke all on public.submissions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- set_my_display_name: save one name/handle for the authenticated participant
-- Existing named submissions follow edits; anonymous rows stay anonymous.
-- ---------------------------------------------------------------------------
create or replace function public.set_my_display_name(p_display_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text := trim(coalesce(p_display_name, ''));
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'Display name must be 1 to 80 characters.' using errcode = '22023';
  end if;

  insert into public.participants (id, display_name, updated_at)
  values (v_user, v_name, now())
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = excluded.updated_at;

  update public.submissions
     set display_name = v_name
   where participant_id = v_user
     and display_name <> '';

  return v_name;
end;
$$;

revoke all on function public.set_my_display_name(text) from public;
grant execute on function public.set_my_display_name(text) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_submission: the only browser path for real submissions
-- participant_id is always auth.uid(); a named row always uses the saved name.
-- ---------------------------------------------------------------------------
create or replace function public.submit_submission(
  p_pillars integer[],
  p_content text,
  p_summary text,
  p_auto_tagged boolean,
  p_is_test boolean,
  p_anonymous boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  insert into public.participants (id) values (v_user)
  on conflict (id) do nothing;

  select display_name into v_name
    from public.participants
   where id = v_user;

  if not coalesce(p_anonymous, true) and trim(coalesce(v_name, '')) = '' then
    raise exception 'Set a display name before submitting by name.' using errcode = '22023';
  end if;

  insert into public.submissions (
    pillars, content, summary, auto_tagged, is_test,
    participant_id, uid, display_name
  ) values (
    coalesce(p_pillars, '{}'), p_content, coalesce(p_summary, ''),
    coalesce(p_auto_tagged, false), coalesce(p_is_test, false),
    v_user, null, case when coalesce(p_anonymous, true) then '' else v_name end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_submission(integer[], text, text, boolean, boolean, boolean) from public;
grant execute on function public.submit_submission(integer[], text, text, boolean, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- list_submissions: public summaries + private text for the authenticated owner
-- p_test_uid can mark a participant-less, test-only persona row as "mine" in
-- the UI, but never returns its raw text and grants no mutation authority.
-- ---------------------------------------------------------------------------
drop function if exists public.list_submissions(text);
create function public.list_submissions(p_test_uid text default null)
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
    (
      (auth.uid() is not null and s.participant_id = auth.uid())
      or
      (s.participant_id is null and s.is_test and p_test_uid is not null and s.uid = p_test_uid)
    ) as mine,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.content else null end as content
  from public.submissions s
  order by s.created_at desc
  limit 500;
$$;

revoke all on function public.list_submissions(text) from public;
grant execute on function public.list_submissions(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- delete_my_submission: authenticated ownership for real rows. Test persona
-- deletion goes through the admin-key-protected Vercel endpoint instead.
-- ---------------------------------------------------------------------------
drop function if exists public.delete_my_submission(uuid, text);
drop function if exists public.delete_my_submission(uuid);
create function public.delete_my_submission(p_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.submissions
    where id = p_id
      and auth.uid() is not null
      and participant_id = auth.uid()
    returning 1
  )
  select exists (select 1 from deleted);
$$;

revoke all on function public.delete_my_submission(uuid) from public;
grant execute on function public.delete_my_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- set_my_submission_test: only authenticated owners can change the test flag.
-- Admin test personas are permanently test-only by design.
-- ---------------------------------------------------------------------------
drop function if exists public.set_my_submission_test(uuid, text, boolean);
drop function if exists public.set_my_submission_test(uuid, boolean);
create function public.set_my_submission_test(p_id uuid, p_is_test boolean)
returns boolean
language sql
security definer
set search_path = public
as $$
  with updated as (
    update public.submissions
       set is_test = coalesce(p_is_test, false)
     where id = p_id
       and auth.uid() is not null
       and participant_id = auth.uid()
    returning 1
  )
  select exists (select 1 from updated);
$$;

revoke all on function public.set_my_submission_test(uuid, boolean) from public;
grant execute on function public.set_my_submission_test(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- synthesis (single row, id = 1) — latest AI synthesis, public to read
-- count is distinct participants; submission_count is distinct contribution rows.
-- ---------------------------------------------------------------------------
create table if not exists public.synthesis (
  id               integer primary key default 1 check (id = 1),
  commons          jsonb   not null default '[]'::jsonb,
  contested        jsonb   not null default '[]'::jsonb,
  gaps             jsonb   not null default '[]'::jsonb,
  count            integer not null default 0,
  submission_count integer not null default 0,
  included_tests   boolean not null default false,
  created_at       timestamptz not null default now()
);

alter table public.synthesis add column if not exists submission_count integer not null default 0;
alter table public.synthesis enable row level security;

drop policy if exists "synthesis is public" on public.synthesis;
create policy "synthesis is public"
  on public.synthesis
  for select
  to anon, authenticated
  using (true);

revoke all on public.synthesis from anon, authenticated;
grant select on public.synthesis to anon, authenticated;

-- No insert/update/delete policy: only the server's service-role key writes it.
