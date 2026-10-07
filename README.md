# Prometheus Lab

A private web app where a crew can contribute anonymous (or named) positions on how humans and AI should behave together, for the **Burning Man AI Constitution** project. Claude summarizes each submission and tags it to 12 constitutional pillars. The project lead can then run an AI **synthesis** that sorts everything into **The Commons** (where voices agree), **Contested Ground** (where they diverge, and who holds which position) and **The Gaps** (pillars nobody addressed).

- **Live site:** https://prometheus-lab-xi.vercel.app (password-protected, crew only)
- **Status:** the existing browser-UID version is deployed; the verified-participant version in this working tree is implemented and tested locally but awaits Supabase setup and deployment. See [Project status](#project-status--where-we-left-off).
- **Name history:** originally "The Fire Circle", renamed Prometheus Lab. Only the files in `docs/` still use the old name, on purpose.

---

## Contents
1. [Features](#features)
2. [How it works](#how-it-works)
3. [Repository map](#repository-map)
4. [Setup from scratch](#setup-from-scratch)
5. [Using the app](#using-the-app)
6. [Security and privacy model](#security-and-privacy-model)
7. [Database reference](#database-reference)
8. [API reference](#api-reference)
9. [Testing](#testing)
10. [Project status / where we left off](#project-status--where-we-left-off)
11. [Decisions & deviations](#decisions--deviations)
12. [Known limitations](#known-limitations)
13. [Troubleshooting](#troubleshooting)
14. [Conventions for contributors](#conventions-for-contributors)
15. [History](#history)

---

## Features

**For everyone on the crew**
- **Password gate** on the landing page; nothing is reachable without it.
- **Five tabs:** Home, Pillars, Submit, Voices, Synthesis.
- **Pillars:** the 12 constitutional pillars with expandable sub-topics.
- **Submit** by typing/pasting text, or by adding files: `.txt`, `.md`, `.docx`, `.pptx` (slide text in deck order plus speaker notes), `.pdf` (scanned PDFs are read by Claude), images (`.png`/`.jpg`, read by Claude vision), or a **Google Docs / Google Slides link** (file must be shared "Anyone with the link can view").
- **Pillars optional:** pick 1–3, or skip and Claude auto-tags them.
- **Verified participant, not an account workflow:** before a real contribution, enter an email and the Supabase one-time code. No password, username or onboarding. The normal Supabase session persists and refreshes on that browser.
- **Anonymous by default**; optionally use one saved display name/handle. The email and Auth identity are never public and never sent to Claude.
- **Voices:** a per-pillar coverage chart plus a card per submission showing the AI *summary*, tags and date. Auth ownership makes "yours", raw-text access, **mark/unmark as test**, and **delete** work after reload and on another device signed into the same email. Filters: "Show tests", "Mine only".
- **Synthesis:** the latest saved result is visible to everyone.

**For the project lead** (after unlocking with `ADMIN_KEY` on the Synthesis tab)
- **Run synthesis**, optionally including test submissions.
- **Testing personas** on the Submit tab ("Testing as: Off / Me / Persona 2 / Persona 3"). These are admin-key-protected, test-only identities and are never attached to the signed-in participant.
- Results attribute each view to named participants; anonymous submitters are counted as distinct participants ("3 anonymous"), not submission rows.

## How it works

```
 Browser (public/, plain HTML/CSS/JS)
   │
   ├── every request ──► middleware.js ── crew password gate (cookie)  [Vercel Routing Middleware]
   │
   ├── auth ───────────► Supabase Auth (passwordless email OTP; persistent/refreshing session)
   │                         └── Send Email Hook → Supabase Edge Function → Resend
   ├── reads/writes ───► Supabase (Postgres) via public key + RLS + auth.uid()-owned RPC functions
   │
   └── /api/* ─────────► Vercel serverless functions (Node)
          ├─ summarize.js   → Claude (summary + pillar tags, one call per submission)
          ├─ synthesize.js  → reads ALL submissions (service role) → replaces ids with per-run labels → Claude → stores result
          ├─ test-persona-submit.js → admin-key-checked, test-only persona create/delete
          └─ google-doc.js  → fetches Google's plain-text export of a shared Doc/Slides link
```

- **Frontend:** no framework and no build step. `public/app.js` renders everything with template strings; file parsing happens in the browser (`mammoth` for .docx, `pdf.js` for .pdf, `JSZip` for .pptx).
- **AI:** both Claude calls use **`claude-sonnet-5-5`** (one constant, `MODEL` in `api/_shared.js`). Summaries run at `low` effort, synthesis at `medium`. Both use structured JSON output, so the reply is always valid JSON.
- **Live updates:** the page re-fetches every 20 seconds and when you return to the tab (no websockets).

## Repository map

```
public/                  static site (this folder is what Vercel serves)
  index.html             page shell; loads CDN libraries
  app.js                 the whole UI: render functions, file parsing, Supabase + API calls
  styles.css             design tokens + styles (dark primary, fire-amber accent, light via prefers-color-scheme)
  pillars.js             the 12 pillars (names, emoji, sub-topics)
  config.js              Supabase URL + anon key (public by design)
api/                     Vercel serverless functions
  _shared.js             model name, pillar names, Claude client, error handling ("_" = not a route)
  summarize.js           POST: text/images/PDFs → { pillars, summary, autoTagged }
  synthesize.js          POST (admin key): builds + stores the commons/contested/gaps synthesis
  test-persona-submit.js POST (admin key): creates/deletes detached, test-only persona contributions
  google-doc.js          POST: Google Docs/Slides link → { name, kind, text }
middleware.js            crew password gate in front of everything (pages, config.js, /api/*)
supabase-setup.sql       tables, security policies, RPC functions. Idempotent: safe to re-run
supabase/functions/
  send-email/            signed Supabase Auth hook → Resend OTP email
seed-test-voices.sql     12 fake voices from "Me / Persona 2 / Persona 3" for testing synthesis
vercel.json              static output dir, function timeouts, security headers
package.json             runtime deps: @anthropic-ai/sdk, @supabase/supabase-js, @vercel/functions
.env.example             every environment variable, documented
tests/                   self-contained test suites (own package.json, never installed by Vercel)
docs/                    original handoff spec + the original prototype (historical reference)
CLAUDE.md                context file for AI assistants working in this repo
```

## Setup from scratch

You need free accounts at GitHub, Supabase, Anthropic (API billing) and Vercel, plus Node.js ≥ 20.

### 1. Supabase
1. Create a project.
2. **SQL Editor → New query**, paste all of `supabase-setup.sql`, then **Run**. Check **Table Editor** shows `participants`, `submissions`, and `synthesis`. This SQL revokes the original direct anonymous insert path, so run it immediately before deploying this frontend. The old live frontend will be unable to submit during the short SQL-to-deploy interval (reading still works).
3. **Authentication → Sign In / Providers → Email**: enable the Email provider, turn **Allow new users to sign up** on, leave **Confirm email** on, set **Email OTP length** to `6`, and keep the expiry at `3600` seconds or less. Passwords are not used by this app.
4. **Authentication → Email Templates → Magic Link** (the dashboard may label it **Magic Link or OTP**): set the subject to `Your Prometheus Lab verification code` and the body to:
   ```html
   <h2>Your Prometheus Lab verification code</h2>
   <p>Enter this code in Prometheus Lab:</p>
   <p style="font-size:24px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
   <p>This code verifies that you are one participant. Your email is never shown to other participants or sent to the synthesis model.</p>
   ```
   The `{{ .Token }}` variable is what changes `signInWithOtp` from a magic-link experience to a code-entry experience when Supabase's built-in mailer is used. The Send Email Hook below replaces the built-in mailer and supplies the same code in its own template.
5. **Authentication → URL Configuration**: set **Site URL** to `https://prometheus-lab-xi.vercel.app/`. Add both `https://prometheus-lab-xi.vercel.app/**` and `http://localhost:3000/**` under **Redirect URLs**. The current code-entry flow does not redirect, but keeping these values correct makes Auth emails and any future link fallback safe.
6. Configure the free **Send Email Hook** before sending codes to crew members who are not Supabase project-team members:
   1. In Resend, verify a sending domain or subdomain that you own and create a sending-only API key.
   2. Set the Supabase Edge Function secrets `RESEND_API_KEY`, `AUTH_EMAIL_FROM` (for example `Prometheus Lab <no-reply@auth.example.com>`), and the `SEND_EMAIL_HOOK_SECRET` generated by the Auth Hooks screen. Never put these values in the repository or Vercel.
   3. Deploy `supabase/functions/send-email` with JWT verification disabled. This is safe because the function verifies Supabase's Standard Webhooks signature instead: `supabase functions deploy send-email --no-verify-jwt`.
   4. In **Authentication → Hooks → Send Email**, choose **HTTP** and use `https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-email`.
   5. Activate the hook only after the Resend domain is verified, all three secrets are set, and the function is deployed. Test immediately with one project-team email and one ordinary external email.
7. **Authentication → Rate Limits**: keep the built-in per-user OTP cooldown (60 seconds by default) and verification/IP limits enabled. Set the email/OTP quota high enough for the invited crew but keep the cooldown.
8. **Project Settings → API**: copy the **Project URL**, the **anon** key and the **service_role** key.
9. Put the Project URL and anon key in `public/config.js`. The anon key is public by design; **never** put the service-role key there.

### 2. Anthropic
Create an API key at console.anthropic.com. **Set a monthly spend limit** there.

### 3. Vercel
1. Import the GitHub repo. Settings: **Application Preset: Other**, Root Directory `./`, Build Command empty, Output Directory `public` (`vercel.json` already sets these), Install Command default.
2. Add these **Environment Variables** (all environments) *before* the first deploy:

   | Variable | What it is |
   |---|---|
   | `ANTHROPIC_API_KEY` | Anthropic key (server-only) |
   | `SUPABASE_URL` | Supabase Project URL, same as in `config.js` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key. Server-only; bypasses row-level security |
   | `ADMIN_KEY` | Passphrase you invent; unlocks "Run synthesis" and the testing personas |
   | `SITE_PASSWORD` | The crew password shown on the landing page (use a different value from `ADMIN_KEY`) |

   Changing a variable later requires a **Redeploy** (Deployments → ⋯ → Redeploy). If `SITE_PASSWORD` is missing, the whole site shows "This site isn't set up yet" (it fails closed).
3. Deploy. Every push to `main` redeploys automatically.
4. Recommended: **Firewall → Configure → + New Rule** → If *Request Path equals* `/__login` → Then *Rate Limit*, Fixed Window, 60 s, limit 10, key IP → Save → **Review Changes → Publish** (Hobby plan allows one rate-limit rule).

### Local development
```bash
npm install
cp .env.example .env        # fill in the values
npx vercel dev              # serves public/, api/ and the password gate at http://localhost:3000
```

## Using the app

**Crew:** open the site → enter the crew password → browse freely. The first time you contribute, Submit asks for an email and one-time code. After verification choose **Anonymous** or, after saving one display name, **Submit as _name_**. Supabase keeps the session usable on that browser until sign-out, invalidation, or cleared site data.

**Project lead, running a synthesis:**
1. Synthesis tab → **Project lead? Unlock** → enter `ADMIN_KEY` (kept for that browser tab only).
2. Optionally switch on **Include test submissions**.
3. **Run synthesis** (about 20–60 s; costs a few cents).

**Testing without real people** (three ways):
1. **Your verified participant:** submit real or test contributions as yourself. Named submissions always use your one saved display name; you cannot type a different identity per row.
2. **Personas:** after unlocking, Submit shows **Testing as: Off · Me · Persona 2 · Persona 3**. Every persona is forced to `is_test = true`, has no Auth participant id, and is inserted only after the server validates `ADMIN_KEY`.
3. **Seed data:** paste `seed-test-voices.sql` into the Supabase SQL Editor for 12 ready-made voices designed to produce contested ground on pillars 1, 4 and 7, commons on 5/10/12, and gaps on 2/3/6/8/9/11. Remove them with:
   ```sql
   delete from public.submissions where uid like 'demo-voter-%';
   ```

**Keeping test data out of real results:** anything flagged *test* is excluded from synthesis and from the public counts unless "Include test submissions" is on. "Mark as test" is reversible; "Delete" is not. A previously saved synthesis is not updated until you run it again.

## Security and privacy model

| Asset | Protected by |
|---|---|
| The whole site, `config.js`, `/api/*` | `middleware.js`: crew password → 30-day `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding a keyed hash (not the password). Changing `SITE_PASSWORD` logs everyone out. Failed attempts are delayed 1 s. Fails closed if the variable is unset. |
| Private authentication identity | Supabase Auth stores the email and session. `participants` contains only the Auth UUID and saved display name—no email. The Supabase client persists/refreshes its session; app code never manually stores tokens. |
| Creating a real submission | Direct table inserts are revoked. `submit_submission()` requires the `authenticated` role and always writes `participant_id = auth.uid()`. The browser supplies neither owner id nor per-row display name. |
| Raw submission text and owner IDs | `submissions` has RLS and no direct browser table access. `list_submissions()` returns everyone's public fields but raw text only when `participant_id = auth.uid()`. It never returns participant ids. |
| Deleting / re-flagging submissions | `delete_my_submission()` and `set_my_submission_test()` compare real rows to `auth.uid()` server-side. Test-persona deletion goes through the crew-gated, admin-key-checked Vercel endpoint; predictable test UIDs cannot mutate rows through public RPCs. |
| Named submissions | `set_my_display_name()` saves one non-unique name/handle. Named rows use that saved value; edits update that participant's existing named rows while anonymous rows stay anonymous. |
| Claude synthesis input | The server groups rows by stable owner, then replaces all UUIDs/legacy UIDs with run-local labels (`Participant A…`). Claude receives no email, UUID, session data, or public display name. Afterward, the server maps source labels to public names or distinct anonymous counts and scrubs run-local labels from prose. |
| Synthesis table | Readable by anyone with the anon key, writable only by the service-role key (server). |
| Running synthesis | `x-admin-key` header checked server-side with a constant-time comparison. |
| Claude API key, service-role key | Server environment variables only; never in the browser or repo. |
| Google link fetching | Strict URL pattern; only `docs.google.com` and `*.googleusercontent.com` are ever contacted; redirects re-checked on every hop; 1 MB cap. |
| Prompt injection | User text is wrapped in tags and the model is told to treat it as data; AI output is validated (pillar ids, author names) and HTML-escaped before display. |

**Honest caveats**
- "Anonymous" means no public name or linkable participant identifier appears on the contribution. Supabase still knows authenticated ownership so the participant can manage it and synthesis can weight one person once.
- Email verification establishes one stable participant per Auth user/email, not one biologically unique human. Someone controlling several email addresses could still create several participants; stronger prevention would require invitations, domain restrictions, or identity verification and is intentionally out of scope.
- Email verification proves control of an email-backed participant identity, not a legal name. A display name is a participant-chosen handle; duplicate display names are allowed and aggregated explicitly if they collide in one attribution list.
- One shared crew password: you cannot remove a single person, only rotate it.
- **Named** authors appear by name in the synthesis everyone can read. Anonymous submitters appear only as "N anonymous". A privacy review of this is on the to-do list.
- **The Supabase URL and anon key are public by design.** Anyone holding them can bypass the crew-password website and call the public-summary RPC/read saved synthesis. They cannot insert real rows, read raw text, forge ownership, or mutate rows without a valid Auth session. Keeping the repository private and/or moving public reads behind gated Vercel endpoints remains a defense-in-depth backlog item.

## Database reference

**Tables** (see `supabase-setup.sql` for exact definitions)
- `participants`: `id` (same UUID as `auth.users.id`), `display_name`, `created_at`, `updated_at`. It deliberately has no email column.
- `submissions`: `id`, `pillars int[]` (1–12), `content` (≤100,000 chars, private), `summary`, `auto_tagged`, `is_test`, `participant_id` (private Auth owner), nullable legacy/test `uid`, public `display_name` snapshot (`''` means anonymous), `created_at`.
- `synthesis`: single row (`id = 1`): `commons`, `contested`, `gaps` (jsonb), `count` (distinct participants), `submission_count`, `included_tests`, `created_at`.

**Functions** (the only normal browser write/read path for submissions; all `security definer`)
- `submit_submission(...)` → row UUID; authenticated only, owner comes from `auth.uid()`, and named mode reads the saved profile name.
- `set_my_display_name(name)` → saved name; authenticated only.
- `list_submissions(p_test_uid default null)`: all public rows; real `mine`/`content` come only from `auth.uid()`. The optional value is restricted to participant-less test rows.
- `delete_my_submission(id)` → boolean; authenticated ownership only.
- `set_my_submission_test(id, is_test)` → boolean; Auth ownership only.

**Legacy migration behavior:** existing rows are preserved. Their old `uid` remains for synthesis grouping, but a legacy non-test `uid` can no longer be presented as proof of ownership. Therefore old production rows cannot expose raw text or be managed until an explicit, trusted migration/claim process is designed. Existing `is_test = true` persona/seed rows remain usable as tests.

**Stored synthesis shape**
```jsonc
{ "commons":   [{ "pillar", "pillarId", "strength": "strong|moderate|emerging",
                  "points": [{ "point", "voices": ["Mary", "2 anonymous"] }] }],
  "contested": [{ "pillar", "pillarId", "tension",
                  "positions": [{ "stance", "voices": ["Mary"] }] }],
  "gaps":      [{ "pillar", "pillarId", "note" }] }
```
Older saved results (plain-string positions, single `summary` per commons item) still display.

## API reference

All four require the crew cookie (otherwise `401 {code:"crew_login"}`).

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/summarize` | `{ text, selectedPillars?, attachments?: [{name, mediaType, data(base64)}] }` | `{ pillars, summary, autoTagged, attachmentsSkipped? }`. Text capped at 8,000 chars; ≤4 attachments, 3 MB total; images/PDFs only |
| `POST /api/synthesize` | `{ includeTests? }` + header `x-admin-key` | The synthesis (also stored). Reads up to 1,000 submissions, 6,000 chars each |
| `POST /api/google-doc` | `{ url }` | `{ name, kind, text }`. Public Docs/Slides only |
| `POST /api/test-persona-submit` | test contribution, or `{ persona, deleteId }`, plus header `x-admin-key` | Creates/deletes only forced-test, participant-less `Me` / `Persona 2` / `Persona 3` rows |

## Testing

All suites live in `tests/` and need **no real Anthropic, Supabase or Google access**: `tests/harness.mjs` serves the real `public/` files and the real `api/` + `middleware.js` code against fake Anthropic/Supabase/Google servers; the SQL suites run `supabase-setup.sql` in an in-memory Postgres (PGlite).

```bash
npm install                 # once, in the repo root (the tests import the API code)
cd tests && npm install     # once; uses your installed Google Chrome (or: npx playwright install chromium, PW_CHANNEL=chromium)
npm test                    # all 12 suites, ~2 min   (npm test -- persona  runs one)
```

| Suite | Covers |
|---|---|
| `gate.test.mjs` | password gate: fail-closed, cookies, tampering, rotation, API 401s |
| `google-doc.test.mjs` | Google link endpoint: redirects, private docs, hostile URLs, size limits |
| `sql-delete` / `sql-mark-test` / `sql-seed` | the real SQL: authenticated ownership rules, RLS, legacy/test isolation, seed data |
| `sql-auth.test.mjs` | Auth-required creation, `auth.uid()` ownership, saved/duplicate names, anonymity, cross-participant isolation |
| `app.e2e.mjs` | OTP verification, persisted session, submit, privacy between users, filters, synthesis, light/dark |
| `delete.e2e` / `mark-test.e2e` | delete and mark-as-test buttons |
| `persona.e2e.mjs` | detached test personas, per-participant attribution, anonymous counts, legacy output |
| `files.e2e.mjs` | .pptx (order, notes), Google links, what the AI actually receives |

**What the tests do NOT prove:** the fakes return canned model replies, so they cannot tell you whether the *real* Claude produces good synthesis output. That needs a manual run (see status below).

## Project status / where we left off

*Last updated: 2026-10-06.*

**Configured and verified in live Supabase:** the Resend sending domain is verified; the signed `send-email` Edge Function is deployed; all three function secrets are present; the Send Email Hook is active; and a real six-digit OTP was delivered and successfully verified. Supabase Auth also has the production Site URL, redirect URLs, 60-second resend cooldown, one-hour expiry, email confirmations, and six-digit OTP length configured.

**Implemented locally, not deployed:** verified-participant frontend, Auth-owned submission RPCs, saved display names, detached test personas, and distinct-participant synthesis labeling. The database migration has not been applied: the live database still lacks `participants` and `synthesis.submission_count`. Run `supabase-setup.sql` immediately before deploying this frontend because the migration intentionally disables the old browser-UID submission path. No commit, push, SQL migration, or frontend deployment was made in this work session.

**Previously deployed:** the browser-UID version in git `HEAD` remains live until the owner explicitly deploys these local changes.

**Verified against the real services:** site is up and gated; `/api/summarize` returns real summaries and tags; admin lock works; the Resend hook delivers a working six-digit OTP; required Vercel production environment variables are present; and the `/__login` firewall rule is live at 10 requests per 60 seconds. The owner also confirmed the Anthropic spending limit. The Google Slides export URL pattern works on a real public deck. The new participant SQL is intentionally not live yet.

**Not yet verified (please check)**
- [ ] The new SQL and hosted verified-participant frontend; verify reload persistence, sign-out, and sign-in from a second browser after deployment. Real OTP delivery and verification are already confirmed through the local frontend against live Supabase.
- [ ] Auth-owned raw-text/delete isolation with two real test emails in the hosted app.
- [ ] The **new synthesis prompts/layout with the real model** (attribution, bulleted Commons/Contested/Gaps, "N anonymous"). Run synthesis on the seed data and review the output.
- [ ] A real **Google Doc** link end to end (Slides is confirmed; Docs uses the same mechanism but wasn't tried on a live doc).
- [ ] A real **.pptx** and **.docx** upload in the live app.
- [ ] The raw-text privacy check with real rows (the table was empty when checked): a direct read of `submissions` with the anon key should return `[]` even when rows exist.

**Open to-do list (roughly in priority order)**
1. **Perform the SQL/frontend cutover:** run `supabase-setup.sql`, deploy the new frontend immediately afterward, then test with two real email addresses. The Resend/Auth Hook portion is complete and live.
2. **Privacy defense in depth:** real inserts and private reads are Auth-protected, but public summaries/names/synthesis remain callable with the public key outside the crew-password gate. Consider making the repo private and/or proxying public reads through gated Vercel endpoints.
3. **Monitor operational limits:** the Anthropic spend limit, Vercel login firewall rule, Supabase Auth cooldown/expiry, and Resend delivery are configured; review usage if the crew or traffic grows.
4. **Decide on the AI text limits** (8,000 chars per submission for summaries, 6,000 chars per submission for synthesis).
5. **Clean up test data** before sharing widely (`delete from public.submissions where uid like 'demo-voter-%' or uid like 'test-persona-%';` plus any manual test rows), then share `SITE_PASSWORD` with the crew only.

**Ideas / backlog:** future parallel/durable synthesis orchestration (possibly Workers/Queues/Workflows, as a separate project—not part of this Vercel/Supabase change); "Clear saved synthesis"; separate summary/synthesis models; server-side refusal fallbacks; `X-Frame-Options`/CSP; replace the shared crew gate; synthesis export; explicit trusted claiming of pre-Auth historical rows.

## Decisions & deviations

Why things are the way they are (including where we departed from the original spec in [`docs/original-handoff-spec.md`](docs/original-handoff-spec.md)):

- **Lightweight verification, not an account product.** Supabase email OTP supplies one stable participant id and a long-lived normal Auth session; there are no passwords, profiles, avatars, social login, or onboarding.
- **A real server-side password gate**, not a script in the page. A client-side check would be cosmetic: anyone could read `config.js` or call `/api/*` directly. Middleware runs in front of everything, so it also protects the AI credits.
- **Raw text is private via database functions, not just UI hiding.** With the public key, a readable table would expose everyone's raw text. So there is no read policy; browsers go through functions.
- **Extra env vars beyond the original "three":** `ADMIN_KEY` (stops strangers spending Anthropic credits via `/api/synthesize`) and `SITE_PASSWORD` (the landing-page gate). Five total.
- **Model:** `claude-sonnet-5-5` for both calls (the spec said Sonnet 4.6/Haiku; the owner asked for Sonnet 5.5). Structured JSON output instead of parsing free text. `effort` low for summaries, medium for synthesis. **Server-side refusal fallbacks were deliberately not enabled**: they only cover cyber/competing-AI refusals, which are unlikely for this content, and rely on a beta we couldn't test. A refusal returns a clear error and the submission still saves with a plain summary.
- **Polling every 20 s instead of realtime**, because browsers can't subscribe to a table they're not allowed to read.
- **Bugs in the original prototype that were fixed:** the AI step never ran (`imgBlobs` used before definition); typed text vanished on re-render; synthesis output was injected as raw HTML (now escaped).
- **One participant = one synthesis voice.** Stable ids are grouped only on the server, converted to run-local labels for Claude, then mapped to a saved public name or a distinct anonymous count. No stable id or email reaches Claude or the saved result.
- **"Mark as test" instead of only "Delete"**: reversible, which suits heavy testing.
- **Google links are fetched server-side** (browsers are blocked by CORS) with strict host allow-listing.
- **Tests live in `tests/` with their own `package.json`**, so Vercel never installs Playwright/PGlite.
- **Pillar names exist in two places** (`public/pillars.js` and `api/_shared.js`); keep them in sync.

## Known limitations

- Voices update every ~20 s, not instantly.
- "Yours" follows the verified Auth identity. Another device can manage the same rows after verifying the same email; clearing site data requires verifying again.
- Deleting or re-flagging a voice doesn't change an already-saved synthesis until it is re-run.
- Images inside slides/docs aren't read (only text). Legacy `.ppt`/Keynote must be saved as `.pptx`.
- More than 4 image/PDF attachments in one submission makes the AI step fall back to a plain 200-character summary.
- Synthesis reads at most 1,000 submissions and has a 60 s function limit; a very large run could time out on Vercel's free plan.
- Supabase's free tier can pause an inactive project; unpause it in the dashboard.
- The crew password is shared; rotation is the only revocation.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| "This site isn't set up yet" | `SITE_PASSWORD` missing in Vercel → add it, redeploy |
| Correct password just reloads the box | Trailing space in the Vercel value; re-copy it |
| "Could not load voices" toast | `public/config.js` wrong (URL must be `https://<ref>.supabase.co`), SQL not run, or Supabase project paused |
| Email contains a link instead of a code | Supabase **Authentication → Email Templates → Magic Link** still uses `{{ .ConfirmationURL }}`; replace the body with the documented `{{ .Token }}` template |
| Verification email does not arrive / 429 | Wait at least 60 seconds before retrying; check **Authentication → Logs**, **Rate Limits**, the `send-email` Edge Function logs, and Resend logs/capacity |
| "Authentication required" or submission RPC missing | Run the complete current `supabase-setup.sql` before deploying the frontend, then reload |
| Summary is just the first 200 characters | The AI step failed: check `ANTHROPIC_API_KEY`, Anthropic billing, Vercel function logs |
| "Wrong admin key" | `ADMIN_KEY` mismatch (the unlock is per tab; reopening needs re-entry) |
| Delete / Mark-as-test shows an error | The newest SQL wasn't run: re-run `supabase-setup.sql` (safe) |
| "Google would not let us read that file" | Share the file as "Anyone with the link can view" |
| Synthesis result looks old | Re-run it; saved results keep their original shape and content |
| Changes not visible after deploy | Hard refresh (Cmd+Shift+R); check Vercel → Deployments is "Ready" |

## Conventions for contributors

- **Never commit secrets.** `.env` is git-ignored; the Anthropic key and service-role key live only in Vercel/your `.env`. The anon key in `config.js` is the only key in the repo, by design.
- **Database changes** go into `supabase-setup.sql` as idempotent statements (`create or replace`, `if not exists`) and must be **run in Supabase before** deploying frontend code that depends on them.
- **Run `cd tests && npm test` before pushing.** Add or extend a suite with every behavior change.
- **Commit messages:** short imperative summary of the change. Commit and push only when the owner asks.
- Keep the design tokens in `public/styles.css`; dark mode is primary and light mode follows `prefers-color-scheme`.

## History

| Commit | Change |
|---|---|
| `dc4ade5` | Initial commit |
| `d628b10` | Static frontend, Vercel API functions, Supabase schema |
| `f663c30` | Crew password gate (routing middleware) |
| `c281e15` | Delete own submissions; mark/unmark as test |
| `93a28ed` | Per-author attribution in synthesis, bulleted Contested Ground, testing personas, seed data |
| `3cf7c3f` | Bulleted Commons and Gaps layouts |
| `6001b37` | Anonymous voices shown as a count; anonymous IDs no longer sent to the model |
| `cb62135` | `.pptx` upload and Google Docs/Slides links |
| *(this commit)* | Tests moved into the repo, docs archived, README and `CLAUDE.md` written |
