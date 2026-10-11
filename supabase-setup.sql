-- ============================================================================
-- Prometheus Lab — Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run. Run it BEFORE deploying frontend code that depends on it.
-- It never drops/truncates a table or rewrites existing rows; everything runs in ONE
-- transaction, so if any statement fails nothing at all is applied.
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

begin;

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
-- sources and contributors
--
-- A source is the thing supplied to the Lab. It is separate from both its
-- uploader (an Auth participant) and the people whose voices/authorship it
-- contains. `submissions` remains the derived per-voice/per-document analysis
-- record, preserving legacy rows and the existing public-summary surface.
-- ---------------------------------------------------------------------------
create table if not exists public.sources (
  id                      uuid primary key default gen_random_uuid(),
  source_type             text not null check (source_type in ('individual', 'transcript', 'document')),
  uploader_participant_id uuid references public.participants(id) on delete set null,
  title                   text not null check (char_length(title) between 1 and 255),
  raw_content             text not null check (char_length(raw_content) between 1 and 100000),
  source_created_at       timestamptz,
  imported_at             timestamptz not null default now(),
  original_audio_url      text check (original_audio_url is null or char_length(original_audio_url) <= 400),
  original_file_url       text check (original_file_url is null or char_length(original_file_url) <= 2000),
  original_file_name      text check (original_file_name is null or char_length(original_file_name) <= 255)
);
create index if not exists sources_uploader_idx on public.sources (uploader_participant_id, imported_at desc);

-- Global records exist only for an authenticated individual or for an author
-- explicitly supplied by the uploader. Transcript labels stay source-local
-- until a later confirmation flow deliberately links them to an identity.
create table if not exists public.contributors (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid references public.participants(id) on delete cascade,
  identity_key   text not null unique check (char_length(identity_key) between 3 and 220),
  display_name   text not null default '' check (char_length(display_name) <= 120),
  created_at     timestamptz not null default now()
);
create unique index if not exists contributors_participant_idx
  on public.contributors (participant_id) where participant_id is not null;

create table if not exists public.source_contributors (
  id                   uuid primary key default gen_random_uuid(),
  source_id            uuid not null references public.sources(id) on delete cascade,
  contributor_id       uuid references public.contributors(id) on delete set null,
  source_label         text not null check (char_length(source_label) between 1 and 120),
  contributor_role     text not null check (contributor_role in ('individual', 'speaker', 'author', 'unattributed')),
  detected_from_source boolean not null default false,
  identity_confirmed   boolean not null default false,
  position             integer not null default 0 check (position >= 0),
  created_at           timestamptz not null default now(),
  unique (source_id, contributor_role, source_label)
);
create index if not exists source_contributors_source_idx on public.source_contributors (source_id, position);
create index if not exists source_contributors_contributor_idx on public.source_contributors (contributor_id);

alter table public.sources enable row level security;
alter table public.contributors enable row level security;
alter table public.source_contributors enable row level security;
revoke all on public.sources, public.contributors, public.source_contributors from anon, authenticated;

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
alter table public.submissions add column if not exists source_id uuid;
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'submissions_source_id_fkey'
      and conrelid = 'public.submissions'::regclass
  ) then
    alter table public.submissions
      add constraint submissions_source_id_fkey
      foreign key (source_id) references public.sources(id) on delete set null;
  end if;
end $$;
create index if not exists submissions_source_idx on public.submissions (source_id);

-- A co-authored document has one derived submission but several contributors.
-- A transcript speaker has one submission and one contributor link. This avoids
-- duplicating raw source text for either case.
create table if not exists public.submission_contributors (
  submission_id         uuid not null references public.submissions(id) on delete cascade,
  source_contributor_id uuid not null references public.source_contributors(id) on delete cascade,
  primary key (submission_id, source_contributor_id)
);
create index if not exists submission_contributors_source_contributor_idx
  on public.submission_contributors (source_contributor_id);
alter table public.submission_contributors enable row level security;
revoke all on public.submission_contributors from anon, authenticated;

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
-- submit_source: creates one raw source plus its derived contribution rows.
--
-- The caller is always the uploader. They are never added as a transcript
-- speaker or document author by this function. Transcript labels are retained
-- as source-local, unconfirmed voices; document authors are the only external
-- identities that are merged, and only by an explicit normalized name supplied
-- by the uploader. `p_contributions` contains derived summaries/segments, not
-- replacement source material: p_raw_content remains the source of truth.
-- ---------------------------------------------------------------------------
create or replace function public.submit_source(
  p_source_type text,
  p_source_title text,
  p_raw_content text,
  p_source_created_at timestamptz default null,
  p_audio_url text default null,
  p_file_url text default null,
  p_file_name text default null,
  p_input_mode text default 'text',
  p_contributors jsonb default '[]'::jsonb,
  p_contributions jsonb default '[]'::jsonb,
  p_is_test boolean default false,
  p_anonymous boolean default true,
  p_discovery_input_id uuid default null,
  p_contribution_type text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_type text := lower(trim(coalesce(p_source_type, '')));
  v_title text := trim(coalesce(p_source_title, ''));
  v_raw text := trim(coalesce(p_raw_content, ''));
  v_name text := '';
  v_source uuid;
  v_contributor uuid;
  v_source_contributor uuid;
  v_submission uuid;
  v_item jsonb;
  v_label text;
  v_identity_key text;
  v_role text;
  v_position integer := 0;
  v_pillars integer[];
  v_choice text;
  v_labels jsonb;
  v_link_label text;
  v_links integer;
  v_prefix text;
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if v_type not in ('individual', 'transcript', 'document') then
    raise exception 'Source type must be individual, transcript or document.' using errcode = '22023';
  end if;
  if char_length(v_raw) < 1 or char_length(v_raw) > 100000 then
    raise exception 'Source content must be 1 to 100,000 characters.' using errcode = '22023';
  end if;
  if v_title = '' then
    if v_type = 'individual' then v_title := 'Individual contribution';
    else raise exception 'A transcript or document needs a source title.' using errcode = '22023';
    end if;
  end if;
  if char_length(v_title) > 255 then
    raise exception 'Source title must be at most 255 characters.' using errcode = '22023';
  end if;
  if coalesce(p_input_mode, 'text') not in ('text', 'voice', 'upload') then
    raise exception 'Unknown input mode.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_contributors, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_contributions, '[]'::jsonb)) <> 'array' then
    raise exception 'Contributors and contributions must be arrays.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_contributions, '[]'::jsonb)) < 1 then
    raise exception 'A source needs at least one derived contribution.' using errcode = '22023';
  end if;
  if v_type in ('individual', 'document') and jsonb_array_length(p_contributions) <> 1 then
    raise exception 'An individual source or document has exactly one derived contribution.' using errcode = '22023';
  end if;

  v_prefix := v_user::text || '/';
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

  insert into public.participants (id) values (v_user)
  on conflict (id) do nothing;
  select display_name into v_name from public.participants where id = v_user;
  if v_type = 'individual' and not coalesce(p_anonymous, true) and trim(coalesce(v_name, '')) = '' then
    raise exception 'Set a display name before submitting by name.' using errcode = '22023';
  end if;

  insert into public.sources (
    source_type, uploader_participant_id, title, raw_content, source_created_at,
    original_audio_url, original_file_url, original_file_name
  ) values (
    v_type, v_user, v_title, v_raw, p_source_created_at,
    p_audio_url, p_file_url, p_file_name
  ) returning id into v_source;

  if v_type = 'individual' then
    v_identity_key := 'participant:' || v_user::text;
    insert into public.contributors (participant_id, identity_key, display_name)
    values (v_user, v_identity_key, case when coalesce(p_anonymous, true) then '' else trim(v_name) end)
    on conflict (identity_key) do update
      set display_name = case when excluded.display_name <> '' then excluded.display_name else public.contributors.display_name end
    returning id into v_contributor;
    insert into public.source_contributors (
      source_id, contributor_id, source_label, contributor_role, identity_confirmed, position
    ) values (
      v_source, v_contributor,
      case when coalesce(p_anonymous, true) then 'Anonymous contribution' else trim(v_name) end,
      'individual', true, 0
    );
  elsif v_type = 'transcript' then
    for v_item in select value from jsonb_array_elements(p_contributors) loop
      v_label := trim(coalesce(v_item->>'label', ''));
      if v_label = '' or char_length(v_label) > 120 then
        raise exception 'Each transcript speaker needs a label of 1 to 120 characters.' using errcode = '22023';
      end if;
      insert into public.source_contributors (
        source_id, source_label, contributor_role, detected_from_source, identity_confirmed, position
      ) values (
        v_source, v_label, 'speaker', coalesce((v_item->>'detected')::boolean, false), false, v_position
      );
      v_position := v_position + 1;
    end loop;
    if v_position = 0 then
      insert into public.source_contributors (source_id, source_label, contributor_role, position)
      values (v_source, 'Unlabeled transcript', 'speaker', 0);
    end if;
  else
    for v_item in select value from jsonb_array_elements(p_contributors) loop
      v_label := trim(coalesce(v_item->>'label', ''));
      if v_label = '' or char_length(v_label) > 120 then
        raise exception 'Each document author needs a name of 1 to 120 characters.' using errcode = '22023';
      end if;
      v_identity_key := 'author:' || lower(regexp_replace(v_label, '[[:space:]]+', ' ', 'g'));
      insert into public.contributors (identity_key, display_name)
      values (v_identity_key, v_label)
      on conflict (identity_key) do update set display_name = public.contributors.display_name
      returning id into v_contributor;
      insert into public.source_contributors (
        source_id, contributor_id, source_label, contributor_role, identity_confirmed, position
      ) values (v_source, v_contributor, v_label, 'author', true, v_position);
      v_position := v_position + 1;
    end loop;
    if v_position = 0 then
      insert into public.source_contributors (source_id, source_label, contributor_role, position)
      values (v_source, 'Unattributed document', 'unattributed', 0);
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_contributions) loop
    v_raw := trim(coalesce(v_item->>'content', ''));
    if v_raw = '' or char_length(v_raw) > 100000 then
      raise exception 'Each derived contribution needs 1 to 100,000 characters.' using errcode = '22023';
    end if;
    select coalesce(array_agg(value::integer), '{}'::integer[])
      into v_pillars
      from jsonb_array_elements_text(coalesce(v_item->'pillars', '[]'::jsonb));
    if not (v_pillars <@ array[1,2,3,4,5,6,7,8,9,10,11,12]) then
      raise exception 'Pillars must be ids 1 through 12.' using errcode = '22023';
    end if;
    v_choice := coalesce(nullif(trim(v_item->>'pillar_choice'), ''), 'selected');
    if v_choice not in ('selected', 'not_sure', 'something_else') then
      raise exception 'Unknown pillar choice.' using errcode = '22023';
    end if;
    insert into public.submissions (
      pillars, content, summary, auto_tagged, is_test, participant_id, uid, display_name,
      contribution_type, input_mode, pillar_choice, audio_url, file_url, file_name,
      discovery_input_id, source_id
    ) values (
      v_pillars, v_raw, left(coalesce(v_item->>'summary', ''), 2000),
      coalesce((v_item->>'auto_tagged')::boolean, false), coalesce(p_is_test, false),
      v_user, null,
      case when v_type = 'individual' and not coalesce(p_anonymous, true) then trim(v_name) else '' end,
      nullif(trim(coalesce(p_contribution_type, '')), ''), coalesce(p_input_mode, 'text'), v_choice,
      p_audio_url, p_file_url, p_file_name,
      case when v_type = 'individual' then p_discovery_input_id else null end, v_source
    ) returning id into v_submission;

    v_labels := coalesce(v_item->'labels', '[]'::jsonb);
    if jsonb_typeof(v_labels) <> 'array' then
      raise exception 'Contribution labels must be an array.' using errcode = '22023';
    end if;
    if v_type = 'individual' then
      select id into v_source_contributor from public.source_contributors
       where source_id = v_source and contributor_role = 'individual';
      insert into public.submission_contributors (submission_id, source_contributor_id)
      values (v_submission, v_source_contributor);
    elsif jsonb_array_length(v_labels) = 0 and v_type = 'document' then
      select id into v_source_contributor from public.source_contributors
       where source_id = v_source and contributor_role = 'unattributed';
      if v_source_contributor is null then
        raise exception 'Document contributions must list every supplied author.' using errcode = '22023';
      end if;
      insert into public.submission_contributors (submission_id, source_contributor_id)
      values (v_submission, v_source_contributor);
    else
      v_links := 0;
      for v_link_label in select trim(value) from jsonb_array_elements_text(v_labels) loop
        select id into v_source_contributor from public.source_contributors
         where source_id = v_source and source_label = v_link_label;
        if v_source_contributor is null then
          raise exception 'Contribution refers to an unknown source contributor.' using errcode = '22023';
        end if;
        insert into public.submission_contributors (submission_id, source_contributor_id)
        values (v_submission, v_source_contributor)
        on conflict do nothing;
        v_links := v_links + 1;
      end loop;
      if v_links = 0 then
        raise exception 'Each transcript contribution needs its detected speaker label.' using errcode = '22023';
      end if;
    end if;
  end loop;

  if v_type = 'transcript' and exists (
    select 1 from public.source_contributors sc
     where sc.source_id = v_source and sc.contributor_role = 'speaker'
       and not exists (select 1 from public.submission_contributors jc where jc.source_contributor_id = sc.id)
  ) then
    raise exception 'Every detected speaker needs exactly one derived contribution.' using errcode = '22023';
  end if;

  if v_type = 'individual' and p_discovery_input_id is not null then
    update public.pillar_discovery_inputs
       set is_anonymous = coalesce(p_anonymous, true),
           is_test = coalesce(p_is_test, false)
     where id = p_discovery_input_id and participant_id = v_user;
  end if;
  return v_source;
end;
$$;

revoke all on function public.submit_source(text, text, text, timestamptz, text, text, text, text, jsonb, jsonb, boolean, boolean, uuid, text) from public;
grant execute on function public.submit_source(text, text, text, timestamptz, text, text, text, text, jsonb, jsonb, boolean, boolean, uuid, text) to authenticated;

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
-- update_my_submission: legacy and individual-source rows can be edited. A
-- transcript/document is source-derived, so it must be corrected by revising
-- its source/re-extraction flow rather than silently changing one derived row.
-- For an individual source, raw_content changes in lockstep with its one row.
-- ---------------------------------------------------------------------------
create or replace function public.update_my_submission(
  p_id uuid,
  p_content text,
  p_summary text,
  p_contribution_type text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source uuid;
  v_type text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  select s.source_id, src.source_type into v_source, v_type
    from public.submissions s left join public.sources src on src.id = s.source_id
   where s.id = p_id and s.participant_id = auth.uid();
  if not found or (v_source is not null and v_type <> 'individual') then return false; end if;
  update public.submissions
     set content = p_content,
         summary = coalesce(p_summary, ''),
         contribution_type = nullif(trim(coalesce(p_contribution_type, '')), '')
   where id = p_id and participant_id = auth.uid();
  if v_source is not null then
    update public.sources set raw_content = p_content
     where id = v_source and uploader_participant_id = auth.uid() and source_type = 'individual';
  end if;
  return true;
end;
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
  discovery_audio_url text,
  source_type text,
  source_title text,
  voice_labels text[]
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
      else null end as discovery_audio_url,
    coalesce(src.source_type, 'individual') as source_type,
    src.title as source_title,
    coalesce((
      select array_agg(sc.source_label order by sc.position, sc.source_label)
      from public.submission_contributors jc
      join public.source_contributors sc on sc.id = jc.source_contributor_id
      where jc.submission_id = s.id
    ), '{}'::text[]) as voice_labels
  from public.submissions s
  left join public.sources src on src.id = s.source_id
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
      -- A transcript/document is one source with multiple derived rows. It is
      -- never safe to erase only one speaker/author through the old row action.
      and not exists (
        select 1 from public.sources src
         where src.id = public.submissions.source_id and src.source_type <> 'individual'
      )
    returning id, discovery_input_id, source_id
  ),
  -- The participant's step-2 answer goes with the submission it belongs to.
  discovery_gone as (
    delete from public.pillar_discovery_inputs d
     using deleted
     where d.id = deleted.discovery_input_id
       and d.participant_id = auth.uid()
    returning 1
  ),
  -- Deleting a new individual contribution also removes its one raw source.
  -- Legacy rows have source_id null and keep their existing behavior.
  source_gone as (
    delete from public.sources src
     using deleted
     where src.id = deleted.source_id
       and src.source_type = 'individual'
       and src.uploader_participant_id = auth.uid()
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
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source uuid;
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  select source_id into v_source from public.submissions
   where id = p_id and participant_id = auth.uid();
  if not found then return false; end if;
  update public.submissions
     set is_test = coalesce(p_is_test, false)
   where participant_id = auth.uid()
     and (id = p_id or (v_source is not null and source_id = v_source));
  get diagnostics v_updated = row_count;
  update public.pillar_discovery_inputs d
     set is_test = coalesce(p_is_test, false)
   where d.participant_id = auth.uid()
     and d.id in (
       select discovery_input_id from public.submissions
        where participant_id = auth.uid()
          and (id = p_id or (v_source is not null and source_id = v_source))
          and discovery_input_id is not null
     );
  return v_updated > 0;
end;
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
-- Since versioning (below) this row is only a mirror of the latest version, kept so an
-- older deployed frontend keeps working while the new one rolls out.

-- ---------------------------------------------------------------------------
-- synthesis_versions — immutable history. Every "Create New Synthesis" adds one row;
-- earlier rows are never changed (trigger below). Only the server's service-role key
-- inserts. Browsers may read the public columns only: submission_ids and voice_keys
-- are the exact provenance (which eligible contributions and which internal voice
-- keys were included) and contain internal ids, so they are not granted.
-- provenance = 'exact' for versions created by the server, 'reconstructed' for the
-- pre-versioning synthesis backfilled as version 1 (its inputs were inferred from
-- submission timestamps, because the old table never recorded them).
-- ---------------------------------------------------------------------------
create table if not exists public.synthesis_versions (
  version            integer primary key check (version >= 1),
  created_at         timestamptz not null default now(),
  commons            jsonb   not null default '[]'::jsonb,
  contested          jsonb   not null default '[]'::jsonb,
  gaps               jsonb   not null default '[]'::jsonb,
  voice_count        integer not null default 0,
  contribution_count integer not null default 0,
  source_count       integer not null default 0,
  included_tests     boolean not null default false,
  provenance         text    not null default 'exact' check (provenance in ('exact', 'reconstructed')),
  submission_ids     uuid[]  not null default '{}'::uuid[],
  voice_keys         text[]  not null default '{}'::text[]
);

create or replace function public.synthesis_versions_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Synthesis versions are immutable; create a new version instead.' using errcode = '42501';
end;
$$;
drop trigger if exists synthesis_versions_no_update on public.synthesis_versions;
create trigger synthesis_versions_no_update
  before update on public.synthesis_versions
  for each row execute function public.synthesis_versions_immutable();

alter table public.synthesis_versions enable row level security;
drop policy if exists "synthesis versions are public" on public.synthesis_versions;
create policy "synthesis versions are public"
  on public.synthesis_versions
  for select
  to anon, authenticated
  using (true);
revoke all on public.synthesis_versions from anon, authenticated;
grant select (version, created_at, commons, contested, gaps, voice_count, contribution_count,
              source_count, included_tests, provenance)
  on public.synthesis_versions to anon, authenticated;

-- One-time backfill: the existing single synthesis becomes version 1. Runs only while the
-- history is empty, so re-running this file never adds or changes a version. Its inputs
-- are reconstructed as the rows that existed when it was saved, using the same voice keys
-- as api/synthesize.js for pre-source rows (the source tables are new in this file).
insert into public.synthesis_versions (
  version, created_at, commons, contested, gaps, voice_count, contribution_count, source_count,
  included_tests, provenance, submission_ids, voice_keys
)
select 1, s.created_at, s.commons, s.contested, s.gaps, s.count, s.submission_count,
       coalesce(r.source_count, 0), s.included_tests, 'reconstructed',
       coalesce(r.ids, '{}'::uuid[]), coalesce(r.keys, '{}'::text[])
  from public.synthesis s
  cross join lateral (
    select array_agg(x.id order by x.created_at) as ids,
           array_agg(distinct case when x.participant_id is not null then 'auth:' || x.participant_id::text
                                   when x.uid is not null then 'legacy:' || x.uid
                                   else 'row:' || x.id::text end) as keys,
           count(distinct coalesce(x.source_id::text, x.id::text))::integer as source_count
      from public.submissions x
     where x.created_at <= s.created_at
       and (s.included_tests or not x.is_test)
  ) r
 where s.id = 1
   and not exists (select 1 from public.synthesis_versions);

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

commit;
