# CLAUDE.md: Prometheus Lab

Read this first, then `README.md` (full docs, decisions, status). This file holds the rules and the current to-do list.

## What this is
Password-gated crew web app for the Burning Man AI Constitution. Plain HTML/CSS/JS in `public/`, Supabase (Postgres), Vercel serverless functions in `api/` calling Claude (`claude-sonnet-5-5`), password gate in `middleware.js`. Live: https://prometheus-lab-xi.vercel.app. Repo: github.com/oaxana/prometheus-lab (branch `main` auto-deploys to Vercel).

## Working rules (the owner's standing preferences)
- **Do not commit or push unless the owner says so** ("commit and push"). Before pushing: run the secret scan (`git diff --cached | grep -E "sk-ant-|sb_secret_|eyJ"` should only show the public anon key), then after pushing, wait ~50 s and curl-check the live site is still gated (every path returns 401 without the cookie).
- **Never print, commit or ask for secrets.** Server-only: `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_KEY`, `SITE_PASSWORD`. Only the Supabase **anon** key is in the repo (`public/config.js`).
- **SQL changes** go in `supabase-setup.sql`, idempotent, and the owner must run them in the Supabase SQL Editor **before** the frontend that needs them is pushed. Say so explicitly.
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

## Where we left off (2026-10-05)
Everything in README "Features" is built, deployed and passing local tests. Not yet verified with the real services: the new synthesis output from the real model (attribution, bullet layouts, "N anonymous"), a live Google **Doc** link, a real .pptx/.docx upload.

**Next up, in order**
1. Have the owner run synthesis on the seed data (`seed-test-voices.sql`) and review the real output; tune the prompt in `api/synthesize.js` if Contested/Commons/Gaps look thin or misattributed.
2. **Privacy review**, which the owner explicitly deferred ("then we can figure out privacy issues after"): named attribution in the public synthesis, meaning of "anonymous", retention, an attribution on/off switch.
3. Decide whether to raise the AI text limits (8,000 chars/submission for summaries in `api/summarize.js`; 6,000 chars/submission in `api/synthesize.js`); long decks/docs are currently truncated for the AI.
4. Confirm the owner set: Anthropic monthly spend limit; Vercel Firewall rate-limit rule on `/__login`.
5. Before sharing widely: delete test data (`delete from public.submissions where uid like 'demo-voter-%';` and any manual tests), then share `SITE_PASSWORD` with the crew.

Backlog ideas: "Clear saved synthesis" button; separate models for summaries vs synthesis; `X-Frame-Options`/CSP; per-person access; export synthesis.
