-- OLD WORKSHOP TRANSCRIPT: PREVIEW + SAFE, EXPLICIT REMOVAL
--
-- Do not run this automatically. It targets only the checked-in legacy seed
-- contract used by scripts/seed-transcript.mjs:
--   source title: Workshop transcript, Oct 1 2026
--   14 labels: Participant A through Participant N
--   uid prefix: seed-workshop-2026-10-01-
--   no authenticated participant owner; not a test row
--
-- It cannot target separate app submissions because those rows do not carry all
-- of these markers. Run the PREVIEW first. If it does not return exactly 14
-- rows, stop: do not use the deletion section.

-- PREVIEW (read-only): expected count = 14
select
  count(*) as candidate_count,
  min(created_at) as first_imported_at,
  max(created_at) as last_imported_at,
  min(contribution_type) as source_title
from public.submissions
where uid in (
  'seed-workshop-2026-10-01-a', 'seed-workshop-2026-10-01-b',
  'seed-workshop-2026-10-01-c', 'seed-workshop-2026-10-01-d',
  'seed-workshop-2026-10-01-e', 'seed-workshop-2026-10-01-f',
  'seed-workshop-2026-10-01-g', 'seed-workshop-2026-10-01-h',
  'seed-workshop-2026-10-01-i', 'seed-workshop-2026-10-01-j',
  'seed-workshop-2026-10-01-k', 'seed-workshop-2026-10-01-l',
  'seed-workshop-2026-10-01-m', 'seed-workshop-2026-10-01-n'
)
  and contribution_type = 'Workshop transcript, Oct 1 2026'
  and display_name in (
    'Participant A', 'Participant B', 'Participant C', 'Participant D',
    'Participant E', 'Participant F', 'Participant G', 'Participant H',
    'Participant I', 'Participant J', 'Participant K', 'Participant L',
    'Participant M', 'Participant N'
  )
  and participant_id is null
  and is_test = false;

-- Inspect the exact candidates (metadata only; deliberately no raw content).
select id, uid, display_name, contribution_type, participant_id, is_test, created_at
from public.submissions
where uid in (
  'seed-workshop-2026-10-01-a', 'seed-workshop-2026-10-01-b',
  'seed-workshop-2026-10-01-c', 'seed-workshop-2026-10-01-d',
  'seed-workshop-2026-10-01-e', 'seed-workshop-2026-10-01-f',
  'seed-workshop-2026-10-01-g', 'seed-workshop-2026-10-01-h',
  'seed-workshop-2026-10-01-i', 'seed-workshop-2026-10-01-j',
  'seed-workshop-2026-10-01-k', 'seed-workshop-2026-10-01-l',
  'seed-workshop-2026-10-01-m', 'seed-workshop-2026-10-01-n'
)
  and contribution_type = 'Workshop transcript, Oct 1 2026'
  and display_name in (
    'Participant A', 'Participant B', 'Participant C', 'Participant D',
    'Participant E', 'Participant F', 'Participant G', 'Participant H',
    'Participant I', 'Participant J', 'Participant K', 'Participant L',
    'Participant M', 'Participant N'
  )
  and participant_id is null
  and is_test = false
order by uid;

-- AFTER approval only: run this section as one transaction. It refuses to
-- delete anything unless the guarded candidate set contains exactly 14 rows.
-- Leave ROLLBACK in place for a rehearsal; replace only that final line with
-- COMMIT after reviewing the 14 returned metadata rows.
begin;
with candidates as (
  select id
  from public.submissions
  where uid in (
    'seed-workshop-2026-10-01-a', 'seed-workshop-2026-10-01-b',
    'seed-workshop-2026-10-01-c', 'seed-workshop-2026-10-01-d',
    'seed-workshop-2026-10-01-e', 'seed-workshop-2026-10-01-f',
    'seed-workshop-2026-10-01-g', 'seed-workshop-2026-10-01-h',
    'seed-workshop-2026-10-01-i', 'seed-workshop-2026-10-01-j',
    'seed-workshop-2026-10-01-k', 'seed-workshop-2026-10-01-l',
    'seed-workshop-2026-10-01-m', 'seed-workshop-2026-10-01-n'
  )
    and contribution_type = 'Workshop transcript, Oct 1 2026'
    and display_name in (
      'Participant A', 'Participant B', 'Participant C', 'Participant D',
      'Participant E', 'Participant F', 'Participant G', 'Participant H',
      'Participant I', 'Participant J', 'Participant K', 'Participant L',
      'Participant M', 'Participant N'
    )
    and participant_id is null
    and is_test = false
), guarded_delete as (
  delete from public.submissions
  where id in (select id from candidates)
    and (select count(*) from candidates) = 14
  returning id, uid, display_name, contribution_type, created_at
)
select * from guarded_delete order by uid;
rollback; -- Replace with COMMIT only after explicit approval and review.
