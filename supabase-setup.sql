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
--   * Submission wizard: the blank-slate "what topics matter" answers live in
--     pillar_discovery_inputs (no browser read path at all). Recordings and uploaded
--     files live in the PRIVATE storage bucket "submission-files", one folder per
--     participant (folder name = auth.uid()); submissions only store the file PATH
--     in audio_url / file_url (or a Google Docs/Slides https link in file_url).
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

-- ---------------------------------------------------------------------------
-- pillar_discovery_inputs: each participant's unprompted "what matters most"
-- answer from wizard step 2, captured BEFORE they see the draft pillars so it can
-- be analysed independently of the submission. Private: only the security-definer
-- functions below (and the service-role key) can touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.pillar_discovery_inputs (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  input_text     text not null check (char_length(input_text) between 1 and 100000),
  input_type     text not null default 'text' check (input_type in ('text', 'voice')),
  audio_url      text check (audio_url is null or char_length(audio_url) <= 400),
  ai_mapping     jsonb,
  is_anonymous   boolean not null default true,
  is_test        boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists pillar_discovery_participant_idx on public.pillar_discovery_inputs (participant_id);
alter table public.pillar_discovery_inputs enable row level security;
revoke all on public.pillar_discovery_inputs from anon, authenticated;

-- New wizard columns on submissions. `pillars` (integer[]) already holds the multi-select,
-- `content` is the original text (typed, transcribed, or extracted) and `summary` is the AI summary.
-- audio_url / file_url hold a storage PATH ("<participant uuid>/<run>/<file>"), or for file_url
-- a Google Docs/Slides https link. They are returned only to the owner.
alter table public.submissions add column if not exists contribution_type text check (contribution_type is null or char_length(contribution_type) <= 120);
alter table public.submissions add column if not exists input_mode text not null default 'text' check (input_mode in ('text', 'voice', 'upload'));
alter table public.submissions add column if not exists pillar_choice text not null default 'selected' check (pillar_choice in ('selected', 'not_sure', 'something_else'));
alter table public.submissions add column if not exists audio_url text check (audio_url is null or char_length(audio_url) <= 400);
alter table public.submissions add column if not exists file_url text check (file_url is null or char_length(file_url) <= 2000);
alter table public.submissions add column if not exists file_name text check (file_name is null or char_length(file_name) <= 255);
alter table public.submissions add column if not exists discovery_input_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'submissions_discovery_input_id_fkey'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
      add constraint submissions_discovery_input_id_fkey
      foreign key (discovery_input_id) references public.pillar_discovery_inputs(id) on delete set null;
  end if;
end $$;

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
-- The wizard's extra fields are optional so older callers keep working. File paths
-- must live in the caller's own storage folder (or be a Google Docs/Slides link), and
-- a linked discovery input must belong to the caller.
-- ---------------------------------------------------------------------------
drop function if exists public.submit_submission(integer[], text, text, boolean, boolean, boolean);
create or replace function public.submit_submission(
  p_pillars integer[],
  p_content text,
  p_summary text,
  p_auto_tagged boolean,
  p_is_test boolean,
  p_anonymous boolean,
  p_contribution_type text default null,
  p_input_mode text default 'text',
  p_pillar_choice text default 'selected',
  p_audio_url text default null,
  p_file_url text default null,
  p_file_name text default null,
  p_discovery_input_id uuid default null
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
  v_prefix text;
  v_type text := nullif(trim(coalesce(p_contribution_type, '')), '');
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  v_prefix := v_user::text || '/';

  insert into public.participants (id) values (v_user)
  on conflict (id) do nothing;

  select display_name into v_name
    from public.participants
   where id = v_user;

  if not coalesce(p_anonymous, true) and trim(coalesce(v_name, '')) = '' then
    raise exception 'Set a display name before submitting by name.' using errcode = '22023';
  end if;

  if p_audio_url is not null and left(p_audio_url, length(v_prefix)) <> v_prefix then
    raise exception 'Recording must be in your own storage folder.' using errcode = '42501';
  end if;
  if p_file_url is not null
     and left(p_file_url, length(v_prefix)) <> v_prefix
     and p_file_url !~ '^https://docs\.google\.com/' then
    raise exception 'File must be in your own storage folder.' using errcode = '42501';
  end if;
  if p_discovery_input_id is not null and not exists (
    select 1 from public.pillar_discovery_inputs
     where id = p_discovery_input_id and participant_id = v_user
  ) then
    raise exception 'Unknown discovery input.' using errcode = '42501';
  end if;

  insert into public.submissions (
    pillars, content, summary, auto_tagged, is_test,
    participant_id, uid, display_name,
    contribution_type, input_mode, pillar_choice,
    audio_url, file_url, file_name, discovery_input_id
  ) values (
    coalesce(p_pillars, '{}'), p_content, coalesce(p_summary, ''),
    coalesce(p_auto_tagged, false), coalesce(p_is_test, false),
    v_user, null, case when coalesce(p_anonymous, true) then '' else v_name end,
    v_type, coalesce(p_input_mode, 'text'), coalesce(p_pillar_choice, 'selected'),
    p_audio_url, p_file_url, p_file_name, p_discovery_input_id
  )
  returning id into v_id;

  -- The discovery answer follows the submission's anonymity and test flags.
  if p_discovery_input_id is not null then
    update public.pillar_discovery_inputs
       set is_anonymous = coalesce(p_anonymous, true),
           is_test = coalesce(p_is_test, false)
     where id = p_discovery_input_id and participant_id = v_user;
  end if;

  return v_id;
end;
$$;

revoke all on function public.submit_submission(integer[], text, text, boolean, boolean, boolean, text, text, text, text, text, text, uuid) from public;
grant execute on function public.submit_submission(integer[], text, text, boolean, boolean, boolean, text, text, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- save_discovery_input: create (p_id null) or update the caller's own step-2 answer.
-- ---------------------------------------------------------------------------
create or replace function public.save_discovery_input(
  p_id uuid,
  p_input_text text,
  p_input_type text,
  p_audio_url text,
  p_ai_mapping jsonb,
  p_is_anonymous boolean,
  p_is_test boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if p_audio_url is not null and left(p_audio_url, length(v_user::text) + 1) <> v_user::text || '/' then
    raise exception 'Recording must be in your own storage folder.' using errcode = '42501';
  end if;

  insert into public.participants (id) values (v_user)
  on conflict (id) do nothing;

  if p_id is null then
    insert into public.pillar_discovery_inputs
      (participant_id, input_text, input_type, audio_url, ai_mapping, is_anonymous, is_test)
    values
      (v_user, p_input_text, coalesce(p_input_type, 'text'), p_audio_url, p_ai_mapping,
       coalesce(p_is_anonymous, true), coalesce(p_is_test, false))
    returning id into v_id;
  else
    update public.pillar_discovery_inputs
       set input_text = p_input_text,
           input_type = coalesce(p_input_type, 'text'),
           audio_url = p_audio_url,
           ai_mapping = p_ai_mapping,
           is_anonymous = coalesce(p_is_anonymous, true),
           is_test = coalesce(p_is_test, false)
     where id = p_id and participant_id = v_user
    returning id into v_id;
    if v_id is null then
      raise exception 'Unknown discovery input.' using errcode = '42501';
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function public.save_discovery_input(uuid, text, text, text, jsonb, boolean, boolean) from public;
grant execute on function public.save_discovery_input(uuid, text, text, text, jsonb, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- update_my_submission: the owner edits their text and label; the browser then
-- passes a freshly generated summary. Pillars, mode and files are not editable here.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_submission(
  p_id uuid,
  p_content text,
  p_summary text,
  p_contribution_type text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with updated as (
    update public.submissions
       set content = p_content,
           summary = coalesce(p_summary, ''),
           contribution_type = nullif(trim(coalesce(p_contribution_type, '')), '')
     where id = p_id
       and auth.uid() is not null
       and participant_id = auth.uid()
    returning 1
  )
  select exists (select 1 from updated);
$$;

revoke all on function public.update_my_submission(uuid, text, text, text) from public;
grant execute on function public.update_my_submission(uuid, text, text, text) to authenticated;

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
  content      text,
  contribution_type text,
  input_mode   text,
  pillar_choice text,
  audio_url    text,
  file_url     text,
  file_name    text,
  discovery_audio_url text
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
      then s.content else null end as content,
    -- Everything below is private to the owner (null for everyone else), except the
    -- pillar choice, which only says how the pillars were picked.
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.contribution_type else null end as contribution_type,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.input_mode else null end as input_mode,
    s.pillar_choice,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.audio_url else null end as audio_url,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.file_url else null end as file_url,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then s.file_name else null end as file_name,
    case when auth.uid() is not null and s.participant_id = auth.uid()
      then (select d.audio_url from public.pillar_discovery_inputs d
             where d.id = s.discovery_input_id and d.participant_id = auth.uid())
      else null end as discovery_audio_url
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
    returning id, discovery_input_id
  ),
  -- The participant's step-2 answer goes with the submission it belongs to.
  discovery_gone as (
    delete from public.pillar_discovery_inputs d
     using deleted
     where d.id = deleted.discovery_input_id
       and d.participant_id = auth.uid()
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
    returning id, discovery_input_id
  ),
  discovery_follows as (
    update public.pillar_discovery_inputs d
       set is_test = coalesce(p_is_test, false)
      from updated
     where d.id = updated.discovery_input_id
       and d.participant_id = auth.uid()
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

-- ---------------------------------------------------------------------------
-- Private storage for wizard recordings and uploaded files.
-- Bucket "submission-files" is NOT public. Each participant can read, upload and
-- delete only inside the folder named after their own auth uid. There is no update
-- policy, so files are never overwritten. Files never go to Claude from here; the
-- browser extracts text and sends only that.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'submission-files', 'submission-files', false, 26214400,
  array[
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png', 'image/jpeg', 'image/gif'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "participants read own submission files" on storage.objects;
create policy "participants read own submission files"
  on storage.objects for select to authenticated
  using (bucket_id = 'submission-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "participants upload own submission files" on storage.objects;
create policy "participants upload own submission files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'submission-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "participants delete own submission files" on storage.objects;
create policy "participants delete own submission files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'submission-files' and (storage.foldername(name))[1] = auth.uid()::text);
