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

## Identity architecture (local change, 2026-10-06)
- Real participants use Supabase passwordless email OTP. The SDK owns persistent/refreshing sessions; never manually store Auth tokens.
- `participants.id = auth.users.id`; its only user field is one non-unique `display_name`. Email remains only in Supabase Auth.
- Real submission creation, listing private text, deletion and test-flag changes go through security-definer RPCs that derive ownership from `auth.uid()`. Never accept a participant id or arbitrary per-row name from the browser.
- `submissions.uid` is nullable and retained only for historical/test rows. A legacy/test uid grants no raw-text access or mutation authority. Admin personas are service-role-managed, forced-test rows with `participant_id = null`; create/delete goes through the admin-key-checked Vercel endpoint.
- Synthesis groups by stable id server-side, substitutes per-run Participant A/B labels before Claude, and maps labels to public saved names or distinct anonymous counts after the response. No email, UUID, uid, session data, or public display name is sent to Claude.
- `count` in `synthesis` is distinct participants; `submission_count` is contribution rows.
- Auth email delivery uses `supabase/functions/send-email`: a signed Send Email Hook that sends the OTP through Resend. Its three values (`RESEND_API_KEY`, `SEND_EMAIL_HOOK_SECRET`, `AUTH_EMAIL_FROM`) belong in Supabase Edge Function secrets, never Vercel or git.

## Where we left off (2026-10-06)
The Resend sending domain, three Edge Function secrets, deployed `send-email` function, and live Supabase Send Email Hook are complete. A real six-digit OTP was delivered and verified through the local frontend. The verified-participant frontend/database changes are **not committed, pushed, migrated, or deployed**. A read-only live check confirmed that `participants` and `synthesis.submission_count` do not exist yet. Run `supabase-setup.sql` immediately before deploying the frontend because it disables the old browser-UID submission path. See README "Setup from scratch" and "Project status" for exact steps and deployment order.

**Next up, in order**
1. Complete the SQL/frontend cutover: confirm Vercel access/settings, run SQL, immediately deploy the frontend, then test persistence and ownership with two real emails.
2. Run synthesis on multiple contributions from one real participant plus another anonymous participant; inspect the real model output and stored JSON for attribution/privacy.
3. Privacy defense in depth: public summaries/saved synthesis are still reachable with the public Supabase key outside the crew gate, although production inserts and private content are now Auth-protected. Consider gated read APIs.
4. Decide whether to raise AI text limits (8,000 summary / 6,000 synthesis characters per contribution).
5. Monitor Anthropic/Resend usage as the crew grows; the Anthropic limit, Vercel `/__login` firewall rule, and Supabase Auth cooldown/expiry are confirmed configured.

Backlog ideas: parallel/durable synthesis orchestration as a separate future project (possibly Cloudflare Workers/Queues/Workflows; do not add it casually); trusted claiming of historical pre-Auth rows; "Clear saved synthesis"; separate models; `X-Frame-Options`/CSP; per-person crew access; export synthesis.
