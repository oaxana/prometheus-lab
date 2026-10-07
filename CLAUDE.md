# CLAUDE.md: Prometheus Lab

Read this first, then `README.md` (full docs, decisions, status). This file holds the rules and the current to-do list.

## What this is
Password-gated crew web app for the Burning Man AI Constitution. Plain HTML/CSS/JS in `public/`, Supabase (Postgres), Vercel serverless functions in `api/` calling Claude (`claude-sonnet-5-5`), password gate in `middleware.js`. Live: https://prometheus-lab-xi.vercel.app. Repo: github.com/oaxana/prometheus-lab (branch `main` auto-deploys to Vercel).

## Working rules (the owner's standing preferences)
- **Do not commit or push unless the owner says so** ("commit and push"). Before pushing: run the secret scan (`git diff --cached | grep -E "sk-ant-|sb_secret_|eyJ"` should only show the public anon key), then after pushing, wait ~50 s and curl-check the live site is still gated (every path returns 401 without the cookie).
- **Never print, commit or ask for secrets.** Server-only: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_KEY`, `SITE_PASSWORD`. Only the Supabase **anon** key is in the repo (`public/config.js`).
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
- `submissions.uid` is nullable and retained only for historical/test rows. A legacy/test uid grants no raw-text access or mutation authority. Admin personas are service-role-managed, forced-test rows with `participant_id = null`; create/delete goes through the admin-key-checked Vercel endpoint.
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
- Pillars, Voices and Synthesis lock via `isLocked()` / `hasContributed()`, derived from `S.submissions` (`mine && !isTest`), so no extra query and it unlocks right after a submit. `S.isOwner` (project lead) bypasses. Locked tabs are `aria-disabled`, still clickable (toast); Playwright needs `{force:true}` to click them.
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
- The in-page "Lock project-lead controls" link was removed: with no real submission of their own the lead was locked out of the Synthesis tab (the only place the unlock button lives) and couldn't get back in. `lockAdmin()` still runs when the server rejects a wrong key. To re-enter lead mode after a lock: submit one real voice, then Synthesis → "Project lead? Unlock" (or set the `prometheus-lab-admin` sessionStorage key from the browser console).
- Synthesis chevrons sit on the LEFT of every head (same ▸/▾ look and 19px size as Voices, rotated by CSS via class `rot`); the participant `(N)` pill is absolutely positioned at the right of the pillar row.
- Fonts DM Sans + Space Mono (Google Fonts link in `index.html`) and the `--syn-*` colour tokens are scoped to `.syn`; the rest of the app keeps its own palette. Real model output for the new fields is unverified (tests use fakes).

## Where we left off (2026-10-07, end of session)
Pushed this session: Voices tab changes (`9452dc3`), the Synthesis redesign + removal of the lock link (`6d5351e`, deployed via empty commit `ce1ae6e`), and a final tweak (bigger chevrons, Voices sections start collapsed, Synthesis chevrons on the left). The project lead who locked their own lead mode must submit one real voice before the Synthesis tab (and its "Project lead? Unlock") is reachable again. The theme is not a setting: light/dark follows the visitor's device (`prefers-color-scheme`); there is no toggle. The tab lock is per signed-in account (a real, non-test submission), never per IP. Still unverified live: real model output for the new synthesis fields and the suggested-pillar names. Synthesis toggle "Include test submissions" still has the old grey inline style.

## Earlier status (2026-10-06)
The verified-participant cutover is complete. The owner ran the full `supabase-setup.sql`; commit `adcfce8` was pushed to `main`; Vercel deployed it successfully; and the production alias is live. Post-deploy probes confirmed the crew gate returns `401` for the site, config, and every API without its cookie; the new submission RPC and synthesis column exist; and direct anonymous reads of private participant/submission tables are denied. Supabase Auth's project email quota was raised to 60/hour after the previous two-email/hour quota blocked testing; keep the per-user resend cooldown at 60 seconds.

The hosted Account A smoke test passed: six-digit OTP verification, an `is_test` submission, owner-only raw text and controls, and persistence after refresh. One test row containing `Production ownership test — account A` intentionally remains in production for the cross-account check. The owner stopped before Account B and wants to resume in a new session.

**Next up, in order**
0. Live-test the wizard (README → "Not yet verified": text, voice on phone + laptop, PDF/docx/pptx upload, Google Doc, edit, delete + Storage cleanup, real mapping/summary quality) and fix whatever turns up.
1. Complete Account B using a second real email and separate browser session. Confirm Account B can see Account A's public summary but not its raw text, `yours` badge, test toggle, or delete control. Create/delete B's own test, then return to A and delete A's test.
2. Run synthesis on multiple contributions from one real participant plus another anonymous participant; inspect the real model output and stored JSON for attribution/privacy.
3. Privacy defense in depth: public summaries/saved synthesis are still reachable with the public Supabase key outside the crew gate, although production inserts and private content are now Auth-protected. Consider gated read APIs.
4. Decide whether to raise AI text limits (8,000 summary / 6,000 synthesis characters per contribution).
5. Monitor Anthropic/Resend usage as the crew grows; the Anthropic limit, Vercel `/__login` firewall rule, Supabase Auth cooldown/expiry, and 60-email/hour project quota are confirmed configured.

Backlog ideas: parallel/durable synthesis orchestration as a separate future project (possibly Cloudflare Workers/Queues/Workflows; do not add it casually); trusted claiming of historical pre-Auth rows; "Clear saved synthesis"; separate models; `X-Frame-Options`/CSP; per-person crew access; export synthesis.
