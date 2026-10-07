# CLAUDE.md: Prometheus Lab

Read this first, then `README.md` (full docs, decisions, status). This file holds the rules and the current to-do list.

**Current status and next steps:** see "Where we left off (2026-10-07, demo day)" below.

## What this is
Password-gated crew web app for the Burning Man AI Constitution. Plain HTML/CSS/JS in `public/`, Supabase (Postgres), Vercel serverless functions in `api/` calling Claude (`claude-sonnet-5-5`), password gate in `middleware.js`. Live: https://prometheus-lab-xi.vercel.app. Repo: github.com/oaxana/prometheus-lab (branch `main` auto-deploys to Vercel).

## Working rules (the owner's standing preferences)
- **Do not commit or push unless the owner says so** ("commit and push"). Before pushing: run the secret scan (`git diff --cached | grep -E "sk-ant-|sb_secret_|eyJ"` should only show the public anon key), then after pushing, wait ~50 s and curl-check the live site is still gated (every path returns 401 without the cookie).
- **Never print, commit or ask for secrets.** Server-only: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`, `SITE_PASSWORD` (`ADMIN_KEY` is retired). For local one-off scripts the owner pastes keys into the git-ignored `.env.local` themselves (Vercel "Secret" values cannot be pulled); never print them. Only the Supabase **anon** key is in the repo (`public/config.js`).
- **SQL changes** go in `supabase-setup.sql`, idempotent, and the owner must run them in the Supabase SQL Editor **before** the frontend that needs them is pushed. Say so explicitly.
- **After pushing, confirm Vercel really built it**: `npx --no-install vercel ls` (project is linked in `.vercel/`) should show a new `Ready` Production deployment a minute later. Once a push reached GitHub (after GitHub 500 errors) but Vercel never built it; an empty commit (`git commit --allow-empty` + push) re-triggered the build. A GitHub `Internal Server Error` on push is usually transient: retry after a minute.
- **Run `cd tests && npm test` after every change** and report results honestly (all suites currently pass). Extend a suite when behaviour changes. The tests use fakes, so they cannot judge real model output.
- Explain things for a **non-expert owner**: plain language, exact click paths, say what was and wasn't verified.
- Pillar names live in two places: `public/pillars.js` and `api/_shared.js`. Keep in sync.
- The project is called **Prometheus Lab** (formerly "The Fire Circle"; the old name survives only in `docs/`).
- Models: one `MODEL` constant in `api/_shared.js` (currently `claude-sonnet-5-5`) is used for both summaries (effort `low`) and synthesis (effort `medium`).

## Gotchas learned the hard way
- `render()` in `public/app.js` copies on-screen form values back into state before redrawing. When you change state that feeds a form field, clear/remove the DOM field first (this caused the persona-name and Google-link bugs).
- Vercel Routing Middleware needs `middleware.js` at the repo root and `next()` from `@vercel/functions`. A fresh deploy can briefly serve a stale cached `200` for `/`; re-check after a few seconds.
- The synthesis function's response shape is also what the frontend renders; change both together (and keep rendering of older saved shapes).
- `tests/` has its own `package.json` so Vercel never installs Playwright/PGlite.

## Identity architecture (deployed 2026-10-06)
- Real participants use Supabase passwordless email OTP. The SDK owns persistent/refreshing sessions; never manually store Auth tokens.
- `participants.id = auth.users.id`; its only user field is one non-unique `display_name`. Email remains only in Supabase Auth.
- Real submission creation, listing private text, deletion and test-flag changes go through security-definer RPCs that derive ownership from `auth.uid()`. Never accept a participant id or arbitrary per-row name from the browser.
- `submissions.uid` is nullable and retained only for historical/test rows. A legacy/test uid grants no raw-text access or mutation authority. Test personas were removed on 2026-10-07 (`api/test-persona-submit.js` deleted); `list_submissions(p_test_uid)` keeps its now-unused parameter so no SQL change was needed.
- Synthesis groups by stable id server-side, substitutes per-run Participant A/B labels before Claude, and maps labels to public saved names or distinct anonymous counts after the response. No email, UUID, uid, session data, or public display name is sent to Claude.
- `count` in `synthesis` is distinct participants; `submission_count` is contribution rows.
- Auth email delivery uses `supabase/functions/send-email`: a signed Send Email Hook that sends the OTP through Resend. Its three values (`RESEND_API_KEY`, `SEND_EMAIL_HOOK_SECRET`, `AUTH_EMAIL_FROM`) belong in Supabase Edge Function secrets, never Vercel or git.

## Submission wizard (deployed 2026-10-07, commit `a404dfa`)
- The Submit tab (after email verification) is an 8-step wizard in `public/wizard.js` (state `W`, loaded **before** `app.js`; `render()` in `app.js` calls `wzSyncFields()` first and `wzAfterRender()` last). Server side: `api/map-pillars.js` (step 3) plus `noTag`/`contributionType` on `api/summarize.js`.
- Reused existing columns instead of the brief's names: `pillars` = selected pillars, `content` = original text, `summary` = AI summary, `participant_id` = user id. New: `contribution_type`, `input_mode`, `pillar_choice`, `audio_url`, `file_url`, `file_name`, `discovery_input_id`, and the private table `pillar_discovery_inputs`. `audio_url`/`file_url` are storage **paths** (or a Google link) in the private bucket `submission-files`, owner-only.
- **Deploy status:** the owner had already run the new `supabase-setup.sql` (probed: new columns present, discovery table denies anon reads); `a404dfa` was pushed and every path still returned `401` without the crew cookie. Future SQL changes: owner runs them first, then push.
- Typing does not redraw; gated fields call `wzLiveGate()` to enable/disable Next. Never paste a stored path/URL into an `onclick` string; look it up by submission id (`wzOpenStored`).
- Voice transcription is the browser's `SpeechRecognition` (editable transcript); real transcription, real Storage and real model output for the new prompts are **unverified**: the tests use fakes.

## Landing page + tab locking (landing page pushed in `e690f9a`; Voices lock added after, uncommitted)
- Home (`renderHome` in `public/app.js`) is a landing page; counts come from `GET /api/metrics` (`api/metrics.js`, service-role key, three integers only, no SQL change). Cached in `S.metrics`, re-fetched only when the number of visible real submissions changes; if it fails the counts section is hidden. The third number is **Contributions** (the brief's "areas of consensus" would be 0/stale until the lead runs synthesis).
- Pillars, Voices and Synthesis lock via `isLocked()` / `hasContributed()`, derived from `S.submissions` (`mine && !isTest`), so no extra query and it unlocks right after a submit. Only a logged-in admin with the Admin page's "Unlock all tabs" switch on bypasses (`S.isAdmin && S.unlockTabs`). Locked tabs are `aria-disabled`, still clickable (toast); Playwright needs `{force:true}` to click them.
- Privacy copy deliberately says "Your email stays private", not the brief's "We store nothing / zero personal data" (the email is kept in Supabase Auth, optional display name and raw text are stored).

## Voices tab: counts, accordions, suggested pillars (deployed, commit `9452dc3`)
- Both Voices accordions (Submissions, Suggested Pillars) start **collapsed** (`S.acc` in `public/app.js`); chevrons are 19px. Tests call `openSubs(p)` from `tests/lib.mjs` before touching cards (a reload re-collapses them).
- Header and "Mine only" counts follow the filters: tests only count while "Show tests" is on; the header also follows "Mine only". "Show tests" uses the normal accent when on.
- Submissions and Suggested Pillars are accordions (`accordion()` / `toggleAcc()` in `public/app.js`, state `S.acc`). `toggleAcc` edits the DOM directly so the max-height animation isn't cancelled by `render()`.
- Suggested Pillars come from `GET /api/suggested-pillars` (service-role read, no SQL change): `ai_mapping.newIdeas` of discovery inputs that belong to a saved submission, grouped by case/punctuation-insensitive match, one entry per person, "Anonymous" unless they chose a name. Only idea text + display names leave the server. Different wordings of one theme do NOT merge (real model output is unverified).
- `api/map-pillars.js` now asks for new ideas as 2-5 word pillar-style names. "Mine only" does not filter suggestions (the server doesn't know who is asking).

## Synthesis page redesign (deployed 2026-10-07)
- `renderSynthesisResult()` and helpers in `public/app.js`: stats row + three collapsible levels (section → pillar → detail), all collapsed by default, open state in `S.acc` (keys like `syn-commons`, `syn-commons-10`). Reuses `toggleAcc()` (chevrons with class `rot` turn via CSS) and the `who-host` tap/hover tooltip (`toggleWho`).
- `api/synthesize.js` now also asks for and validates `consensus`, `themes`, `quotes`, `nuance` (commons), `spectrum` + per-position `value` (contested), `suggestions` (gaps), and computes `participants` per pillar server-side (names or "Anonymous", never ids). No SQL change: the columns are jsonb. Older saved shapes are normalised in `synCommons` / `synContested`.
- The old in-page "Project lead? Unlock" button is gone (replaced by the Admin page, see below).
- Synthesis chevrons sit on the LEFT of every head (same ▸/▾ look and 19px size as Voices, rotated by CSS via class `rot`); the participant `(N)` pill is absolutely positioned at the right of the pillar row.
- Fonts DM Sans + Space Mono (Google Fonts link in `index.html`) and the `--syn-*` colour tokens are scoped to `.syn`; the rest of the app keeps its own palette. Real model output for the new fields is unverified (tests use fakes).

## Admin page (deployed 2026-10-07, commit `91db6a4`)
- Muted "Admin" link in the Home footer (also `/#admin`) → `renderAdmin()` in `public/app.js`. Password goes to `POST /api/admin` (`api/admin.js`), checked against `ADMIN_PASSWORD` server-side; success sets HttpOnly, SameSite=Strict, session-only cookie `pl_admin` (HMAC, never the password). Helpers `isAdmin`/`requireAdmin` in `api/_shared.js`; `api/synthesize.js` uses `requireAdmin`. No `ADMIN_PASSWORD` → admin is off (503).
- Controls are the `ADMIN_CONTROLS` array in `app.js` (one card each). v1: "Unlock all tabs", stored as the plain session cookie `pl_unlock_tabs=1`, honoured only while `S.isAdmin`. Logging in alone does not unlock tabs. "Run synthesis" stays on the Synthesis tab for admins.
- `ADMIN_PASSWORD` is set in Vercel (the owner added it before the push). `ADMIN_KEY` is unused and can be deleted from Vercel.
- Phase 1 of demo prep is done: tag `pre-demo-snapshot-2026-10-07` (= `a4a555d`) pushed; all data backed up to `backups/2026-10-07.json` (git-ignored, has raw text + the owner's email) and wiped from the one Supabase project with `scripts/backup-and-wipe.mjs --wipe` (12 submissions, 2 discovery inputs, 1 synthesis, 1 participant, 1 auth user, 0 files → all 0). There is only ONE database: local scripts and the live site share it.

## Workshop seed + synthesis prompt (2026-10-07, demo prep)
- `seed/workshop-2026-10-01.json` = 14 anonymized per-speaker voices (Participant A–N, order of first substantive contribution; names, employers, orgs, camps, products and personal details paraphrased out). The raw transcript and any name→label mapping are deliberately NOT in the repo (repo is public); never add them. `scripts/seed-transcript.mjs` prints (no flag), `--insert`s or `--replace`s them as non-test rows with `uid seed-workshop-2026-10-01-<letter>`, `display_name` = label, `contribution_type` = "Workshop transcript, Oct 1 2026", created one second apart in label order so synthesis's run-local labels match the labels inside the texts.
- Seeded + synthesized against the one database on 2026-10-07. The owner's nine sanity themes (AI vs human-first; consent/recording/artists; experiences to protect; agent accountability; money in scope; future-proofing; phones/connectivity as culture, light touch; mischief and fun; messy and fast, brainstorm then merge) all surfaced in the saved run (7 commons, 2 contested, 3 gaps: Access, Education, Hard Constraints). Real model output varies run to run.
- The synthesis prompt in `api/synthesize.js` was changed (owner approved): a gap is a pillar NO author substantively addressed (passing remarks don't count, don't stretch); single-author points are reported; clearly opposed positions go to contested; voices only when the author's text supports it. The old "nobody (or almost nobody)" rule turned minority points into gap to-dos. Runs now take ~40–75 s, so `api/synthesize.js` maxDuration was raised from 60 to 300 in `vercel.json` (Vercel accepted it: `91db6a4` built Ready). Live run time on Vercel is not yet measured.

## Where we left off (2026-10-07, demo day) — READ THIS FIRST in a new session
The owner demoed the app on 2026-10-07 and will resume after the demo. Work was done in owner-approved phases (summarise, wait for "go").
- **Live now (commit `91db6a4`, Vercel Ready, gate verified 401 on every path):** Admin page, personas removed, new synthesis prompt, synthesize maxDuration 300.
- **Database (the ONLY one; local scripts hit production):** 14 seeded workshop voices + the reviewed synthesis (7 commons / 2 contested / 3 gaps, all nine themes). Plus 1 anonymous `is_test` submission made by the owner's live check at 19:01 UTC (excluded from synthesis; owner can delete it in Voices → Show tests). Anything newer was added during/after the demo.
- **Local backups (git-ignored, private, never share/commit):** `backups/2026-10-07.json` = all pre-demo data (raw text + owner's email); `backups/2026-10-07-demo-state.json` = the reviewed demo synthesis + seeded rows, in case a post-demo re-run comes out worse. There is no restore script by design (owner's choice); restoring the synthesis = upsert its `synthesis` object into `public.synthesis` id 1 with the service-role key, only if the owner asks.
- **Local secrets:** `.env.local` (git-ignored) holds `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (an `sb_secret_…` key) and `ANTHROPIC_API_KEY`, pasted by the owner; never print them. Check presence by length/prefix only. Run scripts with `node --env-file=.env.local …`.
- **Uncommitted:** only this CLAUDE.md update (deliberately not pushed on demo day to avoid a redeploy). Commit it with the next change when the owner says "commit and push".

**Next up after the demo, in order**
1. Ask how the demo went and whether people added submissions. If the owner re-ran synthesis on the live site, note how long it took on Vercel (never measured live; local runs 36–75 s) and re-check the result: nine themes still present, no real names/orgs (the transcript's names are NOT stored anywhere; scan for generic risks: capitalised proper nouns, emails, UUIDs), attribution sanity.
2. Housekeeping the owner may want: delete `ADMIN_KEY` in Vercel; delete the owner's 19:01 test row; blank/delete `.env.local` keys or revoke the Anthropic key if no more scripts are planned.
3. Owner wants **synthesis runnable by everyone** later ("we'll need to build that for everyone later, not right now"): design before building (cost/abuse: Anthropic spend, rate limit, who may trigger, concurrent runs, 1–2 min runtime). Discuss first.
4. Old list still valid: Account B privacy check must be redone with two fresh real emails (the wipe removed the old accounts and the "account A" test row); live-test the wizard (voice, uploads, Google Doc); gated read APIs for public summaries/synthesis; AI text limits; monitor Anthropic/Resend usage.
- Known quirks: synthesis attribution is mostly but not perfectly faithful (e.g. it once credited a participant with a view they didn't state); the "Include test submissions" toggle on Synthesis still has the old grey inline style.

## Earlier status (2026-10-06)
The verified-participant cutover is complete. The owner ran the full `supabase-setup.sql`; commit `adcfce8` was pushed to `main`; Vercel deployed it successfully; and the production alias is live. Post-deploy probes confirmed the crew gate returns `401` for the site, config, and every API without its cookie; the new submission RPC and synthesis column exist; and direct anonymous reads of private participant/submission tables are denied. Supabase Auth's project email quota was raised to 60/hour after the previous two-email/hour quota blocked testing; keep the per-user resend cooldown at 60 seconds.

The hosted Account A smoke test passed: six-digit OTP verification, an `is_test` submission, owner-only raw text and controls, and persistence after refresh. One test row containing `Production ownership test — account A` intentionally remains in production for the cross-account check. The owner stopped before Account B and wants to resume in a new session.

**Next up (as of 2026-10-06; superseded by the demo-day list above)**
0. Live-test the wizard (README → "Not yet verified": text, voice on phone + laptop, PDF/docx/pptx upload, Google Doc, edit, delete + Storage cleanup, real mapping/summary quality) and fix whatever turns up.
1. Complete Account B using a second real email and separate browser session. Confirm Account B can see Account A's public summary but not its raw text, `yours` badge, test toggle, or delete control. Create/delete B's own test, then return to A and delete A's test.
2. Run synthesis on multiple contributions from one real participant plus another anonymous participant; inspect the real model output and stored JSON for attribution/privacy.
3. Privacy defense in depth: public summaries/saved synthesis are still reachable with the public Supabase key outside the crew gate, although production inserts and private content are now Auth-protected. Consider gated read APIs.
4. Decide whether to raise AI text limits (8,000 summary / 6,000 synthesis characters per contribution).
5. Monitor Anthropic/Resend usage as the crew grows; the Anthropic limit, Vercel `/__login` firewall rule, Supabase Auth cooldown/expiry, and 60-email/hour project quota are confirmed configured.

Backlog ideas: parallel/durable synthesis orchestration as a separate future project (possibly Cloudflare Workers/Queues/Workflows; do not add it casually); trusted claiming of historical pre-Auth rows; "Clear saved synthesis"; separate models; `X-Frame-Options`/CSP; per-person crew access; export synthesis.
